// /api/generate-comparison-blueprint.js
// Generates the Linked Pair Comparison Blueprint.
//
// Triggered by generate-blueprint.js after BOTH pair members have completed
// their individual Blueprints. Receives both contact ids, fetches their pillar
// scores from GHL, calls Claude with the comparison master prompt + both
// profiles, renders the Blueprint as HTML, saves to Vercel Blob, and emails
// both customers.
//
// Environment variables required:
//   ANTHROPIC_API_KEY            - Anthropic API key
//   RESEND_API_KEY               - Resend API key for email delivery
//   BLOB_READ_WRITE_TOKEN        - Vercel Blob token
//   GHL_PRIVATE_INTEGRATION_TOKEN- GHL Private Integration token
//   SR_WEBHOOK_SECRET            - Shared secret for auth (same as generate-blueprint)
//   SR_SITE_URL                  - Site URL for asset references (defaults to dennisnickens.com)

const { put } = require('@vercel/blob');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const SITE_URL = process.env.SR_SITE_URL || 'https://dennisnickens.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: same shared secret as generate-blueprint
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.SR_WEBHOOK_SECRET}`) {
    console.error('[Comparison] Unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Env vars check
  const required = ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'BLOB_READ_WRITE_TOKEN', 'GHL_PRIVATE_INTEGRATION_TOKEN', 'SR_WEBHOOK_SECRET'];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length) {
    console.error('[Comparison] Server misconfigured, missing:', missing);
    return res.status(500).json({ error: 'Server misconfigured', missing });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  payload = payload || {};
  const { primary_contact_id, secondary_contact_id } = payload;

  if (!primary_contact_id || !secondary_contact_id) {
    return res.status(400).json({ error: 'Missing primary_contact_id or secondary_contact_id' });
  }

  // Return 202 immediately; run generation in the background.
  res.status(202).json({
    status: 'processing',
    message: 'Comparison Blueprint generation started, will be delivered via email shortly',
    primary_contact_id,
    secondary_contact_id,
  });

  // Run async
  generateAndDeliverComparison({ primary_contact_id, secondary_contact_id }).catch(async (err) => {
    console.error('[Comparison] Generation failed:', err);
    try {
      await updateGhlContact(primary_contact_id, { sr_pair_comparison_status: 'Failed', sr_pair_comparison_error: err.message || String(err) });
      await updateGhlContact(secondary_contact_id, { sr_pair_comparison_status: 'Failed', sr_pair_comparison_error: err.message || String(err) });
    } catch (e) {
      console.error('[Comparison] Could not record failure on GHL contacts:', e.message);
    }
  });
}

async function generateAndDeliverComparison({ primary_contact_id, secondary_contact_id }) {
  console.log(`[Comparison] Starting for pair primary=${primary_contact_id} secondary=${secondary_contact_id}`);

  // Step 1: Fetch both contacts
  const primary = await fetchGhlContact(primary_contact_id);
  const secondary = await fetchGhlContact(secondary_contact_id);
  if (!primary || !secondary) {
    throw new Error('Could not fetch one or both pair members from GHL');
  }

  // Step 2: Build customer profiles for the prompt
  const primaryProfile = buildProfile(primary);
  const secondaryProfile = buildProfile(secondary);
  console.log(`[Comparison] Profiles built for ${primaryProfile.first_name} and ${secondaryProfile.first_name}`);

  // Step 3: Load comparison master prompt
  const systemPrompt = await getComparisonMasterPrompt();

  // Step 4: Build the user message with both profiles
  const userMessage = `Here are the two profiles for this Linked Pair. Produce the Comparison Blueprint as specified.

PRIMARY:
${JSON.stringify(primaryProfile, null, 2)}

SECONDARY:
${JSON.stringify(secondaryProfile, null, 2)}

Produce the Comparison Blueprint now.`;

  // Step 5: Call Claude
  const markdown = await callClaude(systemPrompt, userMessage);
  console.log(`[Comparison] Claude returned ${markdown.length} characters`);

  // Step 6: Convert markdown to branded HTML
  const html = comparisonMarkdownToHtml(markdown, primaryProfile, secondaryProfile);

  // Step 7: Save to Vercel Blob
  const blobUrl = await saveToBlob(`${primary_contact_id}_${secondary_contact_id}`, html);
  console.log(`[Comparison] Saved to ${blobUrl}`);

  // Step 8: Update both GHL contacts
  const generatedAt = new Date().toISOString();
  await updateGhlContact(primary_contact_id, {
    sr_pair_comparison_status: 'Generated',
    sr_pair_comparison_url: blobUrl,
    sr_pair_comparison_generated_at: generatedAt,
  });
  await updateGhlContact(secondary_contact_id, {
    sr_pair_comparison_status: 'Generated',
    sr_pair_comparison_url: blobUrl,
    sr_pair_comparison_generated_at: generatedAt,
  });

  // Step 9: Email both
  await sendComparisonEmail(primary, secondary, blobUrl);

  console.log(`[Comparison] Complete. Delivery emails sent to ${primary.email} and ${secondary.email}.`);
}

// =======================================================================
// HELPERS
// =======================================================================

let COMPARISON_PROMPT_CACHE = null;
async function getComparisonMasterPrompt() {
  if (COMPARISON_PROMPT_CACHE) return COMPARISON_PROMPT_CACHE;
  const promptUrl = `${SITE_URL}/assessment/comparison-master-prompt.md`;
  const resp = await fetch(promptUrl);
  if (!resp.ok) throw new Error(`Could not fetch comparison master prompt: ${resp.status}`);
  COMPARISON_PROMPT_CACHE = await resp.text();
  return COMPARISON_PROMPT_CACHE;
}

function buildProfile(contact) {
  return {
    first_name: contact.firstName || '',
    last_name: contact.lastName || '',
    focus_areas: readField(contact, 'sr_qual_focus_areas'),
    who_for: readField(contact, 'sr_qual_who_for'),
    sku_tier: readField(contact, 'sr_sku_tier'),
    behavior_results: {
      d_score: readField(contact, 'sr_pillar1_d_score'),
      i_score: readField(contact, 'sr_pillar1_i_score'),
      s_score: readField(contact, 'sr_pillar1_s_score'),
      c_score: readField(contact, 'sr_pillar1_c_score'),
      dominant: readField(contact, 'sr_pillar1_dominant'),
    },
    personality_results: {
      type: readField(contact, 'sr_pillar2_type'),
    },
    action_results: {
      dominant: readField(contact, 'sr_pillar3_dominant'),
    },
    currency_results: {
      primary: readField(contact, 'sr_pillar4_primary'),
      secondary: readField(contact, 'sr_pillar4_secondary'),
    },
    channel_results: {
      dominant: readField(contact, 'sr_pillar5_dominant'),
    },
    compass_results: {
      faith_orientation: readField(contact, 'sr_pillar6_faith_orientation'),
      themes: readField(contact, 'sr_pillar6_themes'),
    },
    gifts_results: {
      primary: readField(contact, 'sr_pillar7_primary_gift'),
      secondary: readField(contact, 'sr_pillar7_secondary_gift'),
    },
  };
}

function readField(contact, keyName) {
  const fields = (contact && contact.customFields) || [];
  let idMap = {};
  try { idMap = JSON.parse(process.env.GHL_FIELD_ID_MAP || '{}'); } catch (e) {}
  let matchId = null;
  for (const id in idMap) {
    if (idMap[id] === keyName) { matchId = id; break; }
  }
  for (const f of fields) {
    if (!f) continue;
    const nameKey = (f.key || f.fieldKey || '').toString();
    if (nameKey === keyName) {
      return f.value || f.field_value || f.fieldValueString || f.fieldValue || '';
    }
    if (matchId && f.id === matchId) {
      return f.value || f.field_value || f.fieldValueString || f.fieldValue || '';
    }
  }
  return '';
}

async function fetchGhlContact(contactId) {
  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const resp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28' },
  });
  if (!resp.ok) {
    console.error('[Comparison] GHL fetch failed for', contactId, resp.status);
    return null;
  }
  const data = await resp.json().catch(() => ({}));
  return data.contact || null;
}

async function updateGhlContact(contactId, fields) {
  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const customFields = Object.keys(fields).map((k) => ({ key: k, field_value: fields[k] }));
  const resp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    },
    body: JSON.stringify({ customFields }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('[Comparison] GHL update failed for', contactId, resp.status, errText);
  }
}

async function callClaude(systemPrompt, userMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 270000); // 270s budget

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Claude API ${resp.status}: ${errText.substring(0, 500)}`);
    }
    const data = await resp.json();
    return data.content[0].text;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Claude API client timeout (270s)');
    }
    throw err;
  }
}

function comparisonMarkdownToHtml(markdown, primary, secondary) {
  // Reuse the same branding pattern as individual Blueprints, just titled as Comparison.
  const title = `${primary.first_name} ${primary.last_name} & ${secondary.first_name} ${secondary.last_name} | Comparison Blueprint`;
  // Simple markdown to HTML conversion (headers, bold, italic, paragraphs).
  // For production we may want a heavier converter, but this keeps it inline.
  let body = markdown
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '</p><p>');
  body = `<p>${body}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  body { font-family: 'Inter', Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 3rem 2rem; color: #07071a; background: #fff; line-height: 1.7; }
  h1, h2, h3 { font-family: 'Playfair Display', Georgia, serif; color: #07071a; }
  h1 { font-size: 38px; margin-top: 0; border-bottom: 2px solid #d4a957; padding-bottom: 1rem; }
  h2 { font-size: 26px; margin-top: 2.5rem; color: #d4a957; }
  h3 { font-size: 20px; margin-top: 1.5rem; color: #07071a; }
  p { margin: 0 0 1rem; }
  strong { color: #07071a; }
  em { color: #d4a957; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
  th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2dccd; }
  th { background: #f6f1e3; color: #07071a; }
  .header-meta { color: #888; font-size: 14px; margin-bottom: 2rem; }
</style>
</head>
<body>
  <div class="header-meta">Comparison Blueprint &middot; ${primary.first_name} and ${secondary.first_name} &middot; Generated by Spiritual Romeo</div>
  ${body}
  <hr style="margin: 3rem 0; border: 0; border-top: 1px solid #e2dccd;">
  <p style="font-size: 12px; color: #888; text-align: center;">&copy; 2026 Dennis Nickens, Spiritual Romeo. All rights reserved.</p>
</body>
</html>`;
}

async function saveToBlob(pairKey, html) {
  const filename = `comparison-${pairKey}-${Date.now()}.html`;
  const blob = await put(filename, html, {
    access: 'public',
    contentType: 'text/html',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

async function sendComparisonEmail(primary, secondary, blueprintUrl) {
  const subject = `Your Comparison Blueprint, ${primary.firstName || 'Friend'} and ${secondary.firstName || 'Friend'}`;
  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem; color: #07071a;">
  <h1 style="font-family: 'Playfair Display', Georgia, serif; color: #07071a; font-size: 26px;">Both of you completed the assessment.</h1>
  <p>Here is what your two Blueprints reveal when you read them together. This is the third Blueprint you have been waiting for.</p>
  <p style="text-align: center; margin: 2rem 0;">
    <a href="${blueprintUrl}" style="display: inline-block; background: #07071a; color: #d4a957; padding: 14px 32px; text-decoration: none; font-weight: 600; border-radius: 4px;">View Your Comparison Blueprint</a>
  </p>
  <p>Read it side by side. Some of it will feel obvious. Some of it will feel like a translation of something you have struggled to name. Use the 30-60-90 day plan as a starting point, not a checklist. The work is in the conversation it opens between the two of you.</p>
  <p style="margin-top: 2rem;">Dennis Nickens<br/>AKA Spiritual Romeo<br/>Behavioral and Alignment Consultant</p>
</body></html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dennis Nickens <admin@dennisnickens.com>',
      to: [primary.email, secondary.email].filter(Boolean),
      subject,
      html: htmlBody,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('[Comparison] Resend send failed:', resp.status, errText);
  }
}
