// /api/generate-blueprint.js
// Vercel serverless function for Spiritual Romeo Alignment Blueprint generation.
//
// Flow:
//   1. Receive webhook from GHL when assessment is completed
//   2. Validate auth (shared secret)
//   3. Acknowledge receipt immediately (so GHL doesn't timeout)
//   4. Asynchronously: score the assessment, call Claude API, generate Blueprint
//   5. Convert markdown to HTML, save to Vercel Blob
//   6. Update GHL contact with the Blueprint URL
//   7. WF-04 fires automatically and emails the customer
//
// Environment variables required:
//   ANTHROPIC_API_KEY - your Claude API key from console.anthropic.com
//   SR_WEBHOOK_SECRET - shared secret between GHL and this function (you generate this)
//   GHL_API_KEY - your GHL API key from Settings > API > Generate Key
//   GHL_LOCATION_ID - your GHL location ID (currently 9LA3gKzADpdRC78OmDCD)

const { scoreAssessment, buildRawAnswersFromCustomFields } = require('../lib/scoring');
const { waitUntil } = require('@vercel/functions');

// =======================================================================
// MAIN HANDLER
// =======================================================================

export default async function handler(req, res) {
  // Method check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.SR_WEBHOOK_SECRET}`) {
    console.error('Unauthorized webhook attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fail fast if any required env var is missing. A missing var here would
  // otherwise surface as a confusing 401/403 from a downstream API call.
  const requiredEnv = [
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'GHL_PRIVATE_INTEGRATION_TOKEN',
    'BLOB_READ_WRITE_TOKEN',
    'SR_WEBHOOK_SECRET',
  ];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[Blueprint] FATAL: missing env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server misconfigured', missing });
  }

  // Snapshot the body before we respond, since req may be torn down after
  const payload = req.body;

  // Tell Vercel to keep the function alive until generation completes.
  // waitUntil gives us up to 30s on Hobby tier and 5min on Pro tier.
  // Without this, Vercel kills the function as soon as the response is flushed.
  waitUntil(
    generateAndDeliverBlueprint(payload).catch(async (err) => {
      console.error('[Blueprint] Generation failed:', err);
      if (payload && payload.contact_id) {
        try {
          await updateGhlContact(payload.contact_id, {
            sr_blueprint_status: 'Failed',
            sr_blueprint_error: err.message || String(err),
          });
        } catch (updateErr) {
          console.error('[Blueprint] Failed to write error status to GHL:', updateErr);
        }
      }
    })
  );

  // Acknowledge receipt immediately so GHL doesn't time out
  return res.status(202).json({
    status: 'processing',
    message: 'Blueprint generation started, will be delivered via email shortly',
  });
}

// =======================================================================
// MAIN BLUEPRINT GENERATION FLOW
// =======================================================================

async function generateAndDeliverBlueprint(payload) {
  console.log(`[Blueprint] Starting generation for contact ${payload.contact_id}`);

  // Test-script path: payload.rawAnswers is pre-built. Always a Solo Blueprint.
  // No GHL fetch, no Linked Pair logic.
  if (hasPrebuiltRawAnswers(payload)) {
    console.log(`[Blueprint] Using prebuilt rawAnswers (test mode) for ${payload.contact_id}`);
    const scores = scoreAssessment(payload.rawAnswers);
    console.log(`[Blueprint] Scoring complete for ${payload.contact_id}`);
    return produceAndDeliverBlueprint(payload, scores, null);
  }

  // Production GHL webhook path. Fetch the full contact once. We need it both to
  // reconstruct the scoring answers AND to read the Linked Pair fields.
  const me = await fetchGhlContact(payload.contact_id);
  if (!me) {
    throw new Error(`Could not fetch contact ${payload.contact_id} from GHL`);
  }
  const meCustomFields = Array.isArray(me.customFields) ? me.customFields : [];
  const meScores = scoreAssessment(buildRawAnswersFromCustomFields(meCustomFields));
  console.log(`[Blueprint] Scoring complete for ${payload.contact_id} (reconstructed from ${meCustomFields.length} customFields)`);

  const myRole = (readContactField(me, 'sr_pair_role') || '').toLowerCase().trim();

  // SOLO customer (sr_pair_role empty or null): unchanged behavior. Generate the
  // Blueprint and email it immediately. No wait-for-partner, no Connection Map.
  if (myRole !== 'primary' && myRole !== 'secondary') {
    return produceAndDeliverBlueprint(payload, meScores, null);
  }

  // LINKED PAIR (Change 1: wait-for-both delivery). Neither person receives
  // anything until BOTH have completed. Mark this person as waiting, then check
  // the partner. If the partner is not done, exit cleanly. The partner's own
  // completion call will trigger paired generation later.
  console.log(`[Blueprint] Linked Pair "${myRole}" for ${payload.contact_id}. Applying wait-for-both delivery.`);
  await updateGhlContact(payload.contact_id, { sr_blueprint_status: 'waiting for partner' });

  const partnerId = readContactField(me, 'sr_pair_partner_contact_id');
  if (!partnerId) {
    // Edge case: pair role is set but no partner is linked yet. Ship a Solo
    // Blueprint rather than leave this person stranded with nothing.
    console.warn(`[Blueprint] ${myRole} ${payload.contact_id} has no sr_pair_partner_contact_id. Falling back to Solo Blueprint.`);
    return produceAndDeliverBlueprint(payload, meScores, null);
  }

  const partner = await fetchGhlContact(partnerId);
  if (!partner) {
    // Edge case: partner lookup failed (network error, missing contact). Log it
    // and ship this person's Solo Blueprint instead of hanging or erroring.
    console.error(`[Blueprint] Partner ${partnerId} lookup failed. Falling back to Solo Blueprint for ${payload.contact_id}.`);
    return produceAndDeliverBlueprint(payload, meScores, null);
  }

  const partnerStatus = (readContactField(partner, 'sr_blueprint_status') || '').toLowerCase().trim();
  // The partner is ready to pair when they are also waiting, OR when they already
  // received an old-architecture Blueprint ("Generated"). In the Generated case we
  // regenerate them with the Connection Map and send a fresh email that supersedes
  // the first. (Edge case 1: the May 30 test Primary, Pair Code SR-468K-QN.)
  const partnerReady = partnerStatus === 'waiting for partner' || partnerStatus === 'generated';
  if (!partnerReady) {
    console.log(`[Blueprint] Partner ${partnerId} status is "${partnerStatus}", not ready. Exiting cleanly. Their completion will trigger paired generation.`);
    return;
  }

  // Both partners are complete (Change 2: paired generation with Connection Map).
  const partnerCustomFields = Array.isArray(partner.customFields) ? partner.customFields : [];
  const partnerScores = scoreAssessment(buildRawAnswersFromCustomFields(partnerCustomFields));
  const partnerPayload = payloadFromContact(partner);

  // Order by role so the prompt always sees a consistent primary/secondary shape.
  let primaryPayload, primaryScores, secondaryPayload, secondaryScores;
  if (myRole === 'primary') {
    primaryPayload = payload;          primaryScores = meScores;
    secondaryPayload = partnerPayload; secondaryScores = partnerScores;
  } else {
    primaryPayload = partnerPayload;   primaryScores = partnerScores;
    secondaryPayload = payload;        secondaryScores = meScores;
  }

  console.log(`[Blueprint] Both partners complete. Generating paired Blueprints with Connection Map (primary=${primaryPayload.contact_id}, secondary=${secondaryPayload.contact_id}).`);

  // Two Claude calls run in parallel. Each person is "self" in their own call and
  // the other is "partner," so the Connection Map is written from each person's
  // perspective. Promise.all keeps both pipelines in step so both emails land
  // at roughly the same time.
  await Promise.all([
    produceAndDeliverBlueprint(primaryPayload, primaryScores, buildPartnerData(secondaryPayload, secondaryScores)),
    produceAndDeliverBlueprint(secondaryPayload, secondaryScores, buildPartnerData(primaryPayload, primaryScores)),
  ]);

  console.log(`[Blueprint] Paired generation complete. Both Blueprints delivered.`);
}

// Returns true when the payload carries pre-built rawAnswers (the test-script path).
function hasPrebuiltRawAnswers(payload) {
  return !!(
    payload &&
    payload.rawAnswers &&
    typeof payload.rawAnswers === 'object' &&
    Array.isArray(payload.rawAnswers.behaviorProfile) &&
    payload.rawAnswers.behaviorProfile.length > 0
  );
}

// Builds a minimal payload for the partner (the person who did not trigger this
// webhook), pulling name and email off their GHL contact record.
function payloadFromContact(contact) {
  return {
    contact_id: contact.id,
    first_name: contact.firstName || '',
    last_name: contact.lastName || '',
    email: contact.email || '',
    sku_tier: readContactField(contact, 'sr_sku_tier') || 'Linked Pair',
    lens: readContactField(contact, 'sr_qual_who_for') || 'General',
    lens_detail: readContactField(contact, 'sr_qual_focus_areas') || 'Not specified',
  };
}

// Packages a partner's data for the Connection Map. `incomplete` flags thin
// scoring so the prompt can add a soft note (edge case 4).
function buildPartnerData(partnerPayload, partnerScores) {
  const p1 = partnerScores && partnerScores.pillar1;
  const incomplete =
    !p1 ||
    p1.twoLetterType === 'Unknown' ||
    ((p1.d + p1.i + p1.s + p1.c) === 0);
  return {
    first_name: partnerPayload.first_name || 'your partner',
    last_name: partnerPayload.last_name || '',
    scores: partnerScores,
    incomplete,
  };
}

// Produces one person's Blueprint end to end: build message, call Claude, render
// HTML, save to Blob, update GHL, email. When partnerData is present the prompt
// also writes the Connection Map. Shared by the solo and paired flows.
async function produceAndDeliverBlueprint(payload, scores, partnerData) {
  const userMessage = buildUserMessage(payload, scores, partnerData);
  const systemPrompt = await getMasterPrompt();

  const blueprintMarkdown = await callClaude(systemPrompt, userMessage, payload.contact_id);
  console.log(`[Blueprint] Claude returned ${blueprintMarkdown.length} characters for ${payload.contact_id}`);

  const blueprintHtml = markdownToBrandedHtml(blueprintMarkdown, payload);
  const blueprintUrl = await saveToBlob(payload.contact_id, blueprintHtml);
  console.log(`[Blueprint] Saved to ${blueprintUrl} for ${payload.contact_id}`);

  await updateGhlContact(payload.contact_id, {
    sr_blueprint_status: 'Generated',
    sr_blueprint_url: blueprintUrl,
    sr_blueprint_markdown: blueprintMarkdown.substring(0, 30000), // GHL field limit
    sr_blueprint_generated_at: new Date().toISOString(),
    // Also write the scores so they're queryable in GHL
    sr_pillar1_d_score: String(scores.pillar1.scores10.d),
    sr_pillar1_i_score: String(scores.pillar1.scores10.i),
    sr_pillar1_s_score: String(scores.pillar1.scores10.s),
    sr_pillar1_c_score: String(scores.pillar1.scores10.c),
    sr_pillar1_dominant: scores.pillar1.twoLetterType,
    sr_pillar2_type: scores.pillar2.type,
    sr_pillar3_dominant: scores.pillar3.dominantMode,
    sr_pillar4_primary: scores.pillar4.primary,
    sr_pillar4_secondary: scores.pillar4.secondary,
    sr_pillar5_dominant: scores.pillar5.dominantChannel,
    sr_pillar6_faith_orientation: scores.pillar6.faithOrientation,
    sr_pillar6_themes: `${scores.pillar6.primaryTheme} / ${scores.pillar6.secondaryTheme}`,
    ...(scores.spiritualGifts ? {
      sr_pillar7_primary_gift:   scores.spiritualGifts.primary,
      sr_pillar7_secondary_gift: scores.spiritualGifts.secondary,
      sr_pillar7_tertiary_gift:  scores.spiritualGifts.tertiary,
    } : {}),
  });
  console.log(`[Blueprint] GHL contact ${payload.contact_id} updated. Sending delivery email.`);

  // Send delivery email DIRECTLY via Resend. Bypasses GHL workflow enrollment.
  await sendBlueprintEmail(payload, blueprintUrl);
  console.log(`[Blueprint] Delivery email sent to ${payload.email} for ${payload.contact_id}.`);
}

// Read a single custom field from a contact object. Works with either name-keyed
// or id-keyed customFields[] entries.
function readContactField(contact, keyName) {
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
  try {
    const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
    const resp = await fetch(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => ({}));
    return data.contact || null;
  } catch (e) {
    return null;
  }
}

// =======================================================================
// HELPER: SEND BLUEPRINT EMAIL DIRECTLY (no GHL workflow dependency)
// =======================================================================

async function sendBlueprintEmail(payload, blueprintUrl) {
  const firstName = payload.first_name || 'Friend';
  const email = payload.email;

  const subject = `${firstName}, your Alignment Blueprint is ready`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem; color: #07071a;">
  <h1 style="font-family: 'Playfair Display', Georgia, serif; color: #07071a; font-size: 28px;">${firstName}, your Blueprint is ready.</h1>

  <p>You just finished the SR Alignment Assessment. Your personalized Blueprint, all six pillars analyzed and synthesized into a complete map of how you are wired, is now ready to read.</p>

  <p style="text-align: center; margin: 2rem 0;">
    <a href="${blueprintUrl}" style="display: inline-block; background: #07071a; color: #d4a957; padding: 14px 32px; text-decoration: none; font-weight: 600; border-radius: 4px;">View Your Alignment Blueprint</a>
  </p>

  <p>Bookmark the link. Your Blueprint stays available, you can come back to it any time you need a reminder of who you are and how you work best.</p>

  <p>What to do next:</p>

  <ul>
    <li>Read your Blueprint end to end at least once. The pillars connect in ways that only land when you see the whole picture.</li>
    <li>Pay attention to Section 7 (Misalignment Map) and Section 8 (Strategic Recommendations). That is where the practical leverage lives.</li>
    <li>Start the 30-Day Plan in Section 9 when you are ready. Small, doable steps.</li>
  </ul>

  <p>Reply to this email if you have questions. I read everything.</p>

  <p style="margin-top: 2rem;">Dennis Nickens<br>Behavioral and Alignment Consultant<br>dennisnickens.com</p>
</body>
</html>`;

  // Using Resend for transactional email delivery.
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dennis Nickens <dennis@dennisnickens.com>',
      to: [email],
      bcc: ['admin@dennisnickens.com'],
      subject: subject,
      html: htmlBody,
      reply_to: 'admin@dennisnickens.com',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend email send failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  console.log(`[Blueprint] Email sent via Resend, message ID: ${result.id || 'n/a'}`);
  return result;
}

// =======================================================================
// HELPER: GET MASTER PROMPT
// =======================================================================
// The master prompt is stored as a markdown file at /assessment/master-prompt.md
// in the same Vercel deployment. Cached in module scope so it loads once per
// cold start instead of once per invocation.

let MASTER_PROMPT_CACHE = null;

async function getMasterPrompt() {
  if (!MASTER_PROMPT_CACHE) {
    const response = await fetch('https://dennisnickens.com/assessment/master-prompt.md');
    if (!response.ok) {
      throw new Error(`Failed to fetch master prompt: ${response.status}`);
    }
    MASTER_PROMPT_CACHE = await response.text();
  }
  return MASTER_PROMPT_CACHE;
}

// =======================================================================
// HELPER: BUILD USER MESSAGE FOR CLAUDE
// =======================================================================

function buildUserMessage(payload, scores, partnerData) {
  // Build the conditional answers block. Groups by set letter (A-E), sorted
  // numerically within each set. Omitted entirely when the bucket is empty
  // so Claude never sees a stray empty section header.
  const conditionalAnswerBlock = (() => {
    const ca = scores.conditionalAnswers || {};
    const entries = Object.entries(ca);
    if (entries.length === 0) return '';
    const sets = {};
    for (const [key, text] of entries) {
      const setLetter = key[1]; // 'A' from 'QA1', 'E' from 'QE7', etc.
      if (!sets[setLetter]) sets[setLetter] = [];
      sets[setLetter].push([key, text]);
    }
    const sortedSetLetters = Object.keys(sets).sort();
    let block = '\nCONDITIONAL ANSWERS:\n';
    for (const letter of sortedSetLetters) {
      block += `\nSet ${letter}:\n`;
      const sortedPairs = sets[letter].sort((a, b) => {
        return parseInt(a[0].slice(2), 10) - parseInt(b[0].slice(2), 10);
      });
      for (const [key, text] of sortedPairs) {
        block += `Q-${key.slice(1)}: ${text}\n`;
      }
    }
    return block;
  })();

  // Linked Pair: when partnerData is present, append the partner's results and
  // require the Connection Map section. When absent, this is a Solo Blueprint and
  // the Connection Map is skipped entirely (preserving solo behavior).
  const partnerBlock = partnerData ? buildPartnerBlock(partnerData) : '';
  const connectionMapInstruction = partnerData
    ? `\n11. Section 17: Your Connection Map (REQUIRED). partner_data IS present below, so you MUST generate the full Connection Map exactly as defined in the master prompt: subsections 17.1 through 17.7 plus the closing line. Write it comparing ${payload.first_name} (the reader, "self") with ${partnerData.first_name} (the partner). This is the final section of the Blueprint.`
    : `\n(Section 17 Your Connection Map: SKIP entirely. No partner_data is present. This is a Solo Blueprint.)`;
  const pageTarget = partnerData
    ? `Target 25 to 30 pages total: the full Seven Lenses reading (20 to 25 pages) plus a 5 to 7 page Connection Map as the final section.`
    : `Target 20 to 25 pages, dense and substantive. Every section gets multiple paragraphs. Do not pad, but do not skimp either. The reader is paying for depth.`;

  return `Generate a complete Alignment Blueprint for this customer following the master prompt's structure and voice exactly.

CUSTOMER:
- Name: ${payload.first_name} ${payload.last_name}
- Email: ${payload.email}
- SKU Tier: ${payload.sku_tier || 'Solo'}
- Relationship Lens: ${payload.lens || 'General'}
- Their Situation (in their own words): ${payload.lens_detail || 'Not specified'}

ASSESSMENT SCORES:

PILLAR 1: BEHAVIOR PROFILE
- D (Dominance): ${scores.pillar1.scores10.d}/10 (${scores.pillar1.d} answers)
- I (Influence): ${scores.pillar1.scores10.i}/10 (${scores.pillar1.i} answers)
- S (Steadiness): ${scores.pillar1.scores10.s}/10 (${scores.pillar1.s} answers)
- C (Conscientiousness): ${scores.pillar1.scores10.c}/10 (${scores.pillar1.c} answers)
- Dominant Type: ${scores.pillar1.twoLetterType}

PILLAR 2: PERSONALITY CODE (SR Charge / Trust / Decide / Live)
- 4-letter SR code: ${scores.pillar2.type}
- Charge leaning: ${scores.pillar2.letters.charge} (O=Outward, W=Inward)
- Trust leaning:  ${scores.pillar2.letters.trust} (T=Tangible, V=Vision)
- Decide leaning: ${scores.pillar2.letters.decide} (M=Mind, H=Heart)
- Live leaning:   ${scores.pillar2.letters.live} (P=Plan, F=Flow)
- Tied dichotomies (if any): ${scores.pillar2.balanced.join(', ') || 'None'}

PILLAR 3: ACTION STYLE (SR Scholar / Steward / Sparker / Crafter)
- Scholar: ${scores.pillar3.scholar}
- Steward: ${scores.pillar3.steward}
- Sparker: ${scores.pillar3.sparker}
- Crafter: ${scores.pillar3.crafter}
- Dominant Mode: ${scores.pillar3.dominantMode}
- Secondary Mode: ${scores.pillar3.secondaryMode}

PILLAR 4: CONNECTION CURRENCY (SR Spoken / Presence / Contact / Action / Tokens)
- Spoken:   ${scores.pillar4.spoken}
- Presence: ${scores.pillar4.presence}
- Contact:  ${scores.pillar4.contact}
- Action:   ${scores.pillar4.action}
- Tokens:   ${scores.pillar4.tokens}
- Primary Currency: ${scores.pillar4.primary}
- Secondary Currency: ${scores.pillar4.secondary}

PILLAR 5: LEARNING CHANNEL (SR Sight / Sound / Word / Touch)
- Sight: ${scores.pillar5.sightPct}%
- Sound: ${scores.pillar5.soundPct}%
- Word:  ${scores.pillar5.wordPct}%
- Touch: ${scores.pillar5.touchPct}%
- Dominant Channel: ${scores.pillar5.dominantChannel}

PILLAR 6: SPIRITUAL COMPASS
- Faith Orientation: ${scores.pillar6.faithOrientation}
- Primary Theme: ${scores.pillar6.primaryTheme}
- Secondary Theme: ${scores.pillar6.secondaryTheme}
- Theme Distribution: ${JSON.stringify(scores.pillar6.themeCounts)}
${(() => {
  const sg = scores.spiritualGifts;
  if (!sg) return '';
  return `\nSPIRITUAL GIFTS (PILLAR 7):\n- Primary Gift: ${sg.primary}\n- Secondary Gift: ${sg.secondary}\n- Tertiary Gift: ${sg.tertiary}\n`;
})()}${conditionalAnswerBlock}${partnerBlock}
INSTRUCTIONS FOR THIS BLUEPRINT:

Generate the complete Blueprint as defined in the master prompt:
1. Executive Summary
2. Section 1: Your Behavior Profile (with strengths, blind spots, leverage points)
3. Section 2: Your Personality Code (name their SR Personality Code archetype prominently using the 16-archetype table in the master prompt)
4. Section 3: Your Action Style (name them as The Scholar / Steward / Sparker / Crafter based on dominant mode)
5. Section 4: Your Connection Currency (with 5-currency ranking and bridge scripts; use the currency framing naturally)
6. Section 5: Your Learning Channel (with environment recommendations calibrated to Sight/Sound/Word/Touch)
7. Section 6: Your Spiritual Compass (with 3 personalized scripture verses calibrated to this person's combined archetype)
8. Section 7: Your Misalignment Map (where the pillars conflict and what it costs)
9. Section 8 onward as defined in the master prompt
10. Section 13: Your Spiritual Gifts (conditional, only if SPIRITUAL GIFTS data is present above)${connectionMapInstruction}

Use Dennis Nickens's voice. Plain English. Direct, warm, consultative. NO em dashes or en dashes (replace with commas, periods, or rephrase). NO AI-sounding phrases ("delve into," "navigate the landscape," "in today's fast-paced world," "tapestry," etc.). Sign off with "Dennis Nickens" not "Dennis,".

The Blueprint should be specific to ${payload.first_name}, not generic. Reference their scores explicitly. Address them by first name.

Output the complete Blueprint as markdown. ${pageTarget} Every sentence earns its place. Be thorough and specific, but do not pad sections.`;
}

// =======================================================================
// HELPER: BUILD PARTNER DATA BLOCK (Linked Pair Connection Map)
// =======================================================================
// Renders the partner's scores for the Connection Map. The reader is "self";
// this block is the "partner." The master prompt uses it ONLY for Section 17.

function buildPartnerBlock(partnerData) {
  const s = partnerData.scores || {};
  const p1 = s.pillar1 || {};
  const s10 = p1.scores10 || {};
  const p2 = s.pillar2 || {};
  const p3 = s.pillar3 || {};
  const p4 = s.pillar4 || {};
  const p5 = s.pillar5 || {};
  const p6 = s.pillar6 || {};
  const sg = s.spiritualGifts;
  const name = partnerData.first_name;

  let block = `
PARTNER DATA (Linked Pair). This Blueprint is for a Linked Pair. The reader is the "self." The person below is the reader's partner. Use this partner data ONLY for the final Connection Map (Section 17), where you compare the reader and the partner. Do NOT blend it into the reader's own pillar sections.

- Partner Name: ${name} ${partnerData.last_name}
- Partner Behavior Profile (CORE): dominant ${p1.twoLetterType} (D ${s10.d}/10, I ${s10.i}/10, S ${s10.s}/10, C ${s10.c}/10)
- Partner Personality Code: ${p2.type}
- Partner Action Style: dominant ${p3.dominantMode}, secondary ${p3.secondaryMode}
- Partner Connection Currency: primary ${p4.primary}, secondary ${p4.secondary} (Spoken ${p4.spoken}, Presence ${p4.presence}, Contact ${p4.contact}, Action ${p4.action}, Tokens ${p4.tokens})
- Partner Learning Channel: dominant ${p5.dominantChannel} (Sight ${p5.sightPct}%, Sound ${p5.soundPct}%, Word ${p5.wordPct}%, Touch ${p5.touchPct}%)
- Partner Spiritual Compass: ${p6.faithOrientation}, themes ${p6.primaryTheme} / ${p6.secondaryTheme}`;

  if (sg) {
    block += `\n- Partner Spiritual Gifts: ${sg.primary}, ${sg.secondary}, ${sg.tertiary}`;
  }
  if (partnerData.incomplete) {
    block += `\n- NOTE: Some of ${name}'s scores came in incomplete. Build the Connection Map with the data that is available, and add a brief, warm note in the section letting the reader know some of ${name}'s results were incomplete, so the map will sharpen once both assessments are fully scored.`;
  }
  block += `\n`;
  return block;
}

// =======================================================================
// HELPER: CALL CLAUDE API
// =======================================================================

async function callClaude(systemPrompt, userMessage, contactId) {
  // 270-second client-side timeout. Vercel Pro tier kills the function at 300s,
  // so we abort at 270s to leave headroom for writing the failure status to GHL.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 270000);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Running on Vercel Pro tier with a 300-second waitUntil window (maxDuration 300
        // in vercel.json). max_tokens is 32000 so Claude has room to write the full
        // 20 to 25 page Solo Blueprint (25 to 30 paired) without truncating mid-document,
        // which is the depth the paid product needs. This is a deliberate cost-for-depth
        // tradeoff. The 270s client abort below leaves headroom under the Vercel cap to
        // record a failure status if a long generation runs over. Watch generation time:
        // if 32000-token runs start tripping the 300s cap, the next lever is a higher
        // Vercel maxDuration, not a lower token ceiling.
        model: 'claude-sonnet-4-6',
        max_tokens: 32000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('[Blueprint] Claude API client timeout (270s) hit');
      if (contactId) {
        try {
          await updateGhlContact(contactId, {
            sr_blueprint_status: 'Failed',
            sr_blueprint_error: 'Claude API client timeout (270s)',
          });
        } catch (updateErr) {
          console.error('[Blueprint] Failed to write timeout status to GHL:', updateErr);
        }
      }
      throw new Error('Claude API client timeout (270s)');
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  const result = await response.json();
  return result.content[0].text;
}

// =======================================================================
// HELPER: CONVERT MARKDOWN TO BRANDED HTML
// =======================================================================
// Uses the `marked` npm library to convert markdown.
// Wraps it in an HTML page with SR brand styling (navy/gold cosmic).

function markdownToBrandedHtml(markdown, payload) {
  // Lazy require to avoid import in handler boot
  const { marked } = require('marked');
  const innerHtml = marked.parse(markdown);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${payload.first_name}'s Alignment Blueprint | Spiritual Romeo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Allura&family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    body {
      font-family: 'Inter', sans-serif;
      max-width: 820px;
      margin: 0 auto;
      padding: 0;
      background: linear-gradient(180deg, #07071a 0%, #0f0a2e 50%, #07071a 100%);
      color: #f5f1e8;
      line-height: 1.7;
      min-height: 100vh;
    }
    .content-wrap {
      padding: 3rem 2rem;
    }
    /* COVER PAGE */
    .cover-page {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
      text-align: center;
      padding: 4rem 2rem 3rem 2rem;
      page-break-after: always;
      box-sizing: border-box;
    }
    .cover-top {
      flex: 0;
    }
    .cover-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 1.5rem;
    }
    .cover-logo-img {
      max-width: 320px;
      width: 100%;
      height: auto;
      margin-bottom: 1rem;
      filter: drop-shadow(0 0 24px rgba(212, 169, 87, 0.25));
    }
    .cover-logo-subtitle {
      font-family: 'Cormorant Garamond', serif;
      color: rgba(245, 241, 232, 0.75);
      font-size: 1rem;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      margin-top: -0.5rem;
    }
    .cover-divider {
      width: 80px;
      border-top: 2px solid #d4a957;
      margin: 2rem auto;
      opacity: 0.7;
    }
    .cover-name {
      font-family: 'Playfair Display', serif;
      color: #f5f1e8;
      font-size: 3rem;
      font-weight: 700;
      margin: 0;
    }
    .cover-aka {
      font-family: 'Cormorant Garamond', serif;
      color: #d4a957;
      font-style: italic;
      font-size: 1.5rem;
      margin: 0.25rem 0;
    }
    .cover-brand {
      font-family: 'Allura', cursive;
      color: #d4a957;
      font-size: 5.5rem;
      line-height: 1;
      margin: 0;
    }
    .cover-tagline {
      font-family: 'Cormorant Garamond', serif;
      color: rgba(245, 241, 232, 0.8);
      font-size: 1.1rem;
      font-style: italic;
      margin-top: 2rem;
      max-width: 500px;
    }
    .cover-footer {
      text-align: center;
      color: #f5f1e8;
      font-size: 0.95rem;
      line-height: 2;
      padding-top: 2rem;
      border-top: 1px solid rgba(212, 169, 87, 0.3);
      width: 100%;
      max-width: 500px;
    }
    .cover-footer a {
      color: #d4a957;
      text-decoration: none;
    }
    /* MAIN CONTENT */
    h1, h2, h3, h4 {
      font-family: 'Playfair Display', serif;
      color: #d4a957;
      margin-top: 2.5rem;
      margin-bottom: 1rem;
    }
    h1 { font-size: 2.6rem; font-weight: 700; }
    h2 { font-size: 2rem; border-bottom: 1px solid rgba(212,169,87,0.3); padding-bottom: 0.5rem; }
    h3 { font-size: 1.4rem; }
    h4 { font-size: 1.15rem; }
    p { margin: 1rem 0; }
    em {
      color: #d4a957;
      font-style: italic;
    }
    blockquote {
      border-left: 3px solid #d4a957;
      padding-left: 1.25rem;
      font-style: italic;
      color: #e5c170;
      margin: 1.5rem 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1.5rem 0;
      font-size: 0.95rem;
    }
    th, td {
      border: 1px solid rgba(212,169,87,0.3);
      padding: 0.6rem 0.8rem;
      text-align: left;
    }
    th {
      background: rgba(212,169,87,0.1);
      color: #d4a957;
      font-family: 'Playfair Display', serif;
      font-weight: 700;
    }
    code {
      background: rgba(255,255,255,0.06);
      padding: 0.15rem 0.35rem;
      border-radius: 3px;
      font-size: 0.9em;
    }
    hr {
      border: none;
      border-top: 1px solid rgba(212,169,87,0.3);
      margin: 2.5rem 0;
    }
    ul, ol { padding-left: 1.5rem; }
    li { margin: 0.4rem 0; }
    .footer {
      margin-top: 4rem;
      padding-top: 2rem;
      border-top: 1px solid rgba(212,169,87,0.3);
      text-align: center;
      color: rgba(245,241,232,0.6);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="cover-page">
    <div class="cover-top"></div>
    <div class="cover-content">
      <img src="https://dennisnickens-site-psi.vercel.app/sr-logo-transparent.png" alt="Spiritual Romeo" class="cover-logo-img" />
      <div class="cover-logo-subtitle">The Alignment Blueprint</div>
      <div class="cover-divider"></div>
      <h1 class="cover-name">Dennis Nickens</h1>
      <p class="cover-aka">aka</p>
      <h2 class="cover-brand">Spiritual Romeo</h2>
      <p class="cover-tagline">An assessment system that helps people understand how they're wired so they can position themselves to give their best to the world.</p>
    </div>
    <div class="cover-footer">
      <a href="https://dennisnickens.com">dennisnickens.com</a><br/>
      <a href="mailto:Admin@dennisnickens.com">Admin@dennisnickens.com</a><br/>
      1-866-944-7225
    </div>
  </div>
  <div class="content-wrap">
    ${innerHtml}
    <div class="footer">
      Generated for ${payload.first_name} ${payload.last_name} on ${new Date().toLocaleDateString()}<br/>
      Spiritual Romeo · Behavioral and Alignment Consulting<br/>
      dennisnickens.com
    </div>
  </div>
</body>
</html>`;
}

// =======================================================================
// HELPER: SAVE TO VERCEL BLOB
// =======================================================================

async function saveToBlob(contactId, html) {
  // Lazy require so this doesn't load until needed
  const { put } = await import('@vercel/blob');
  const filename = `blueprints/${contactId}-${Date.now()}.html`;
  const blob = await put(filename, html, {
    access: 'public',
    contentType: 'text/html; charset=utf-8',
  });
  return blob.url;
}

// =======================================================================
// HELPER: UPDATE GHL CONTACT
// =======================================================================

async function updateGhlContact(contactId, fields) {
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;

  // GHL custom fields update format
  const customFields = Object.entries(fields).map(([key, value]) => ({
    key,
    field_value: value,
  }));

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    },
    body: JSON.stringify({ customFields }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GHL update failed: ${response.status} ${errText}`);
  }

  return await response.json();
}

// =======================================================================
// HELPER: FETCH GHL CONTACT CUSTOM FIELDS
// =======================================================================
// Returns the raw customFields array on the contact, each entry shaped like
// { id: '<field id>', value: '<answer text>' }. Used by the scoring layer
// to reconstruct the per-pillar rawAnswers payload since GHL webhooks do
// not assemble that structure for us.

async function fetchGhlContactCustomFields(contactId) {
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${process.env.GHL_PRIVATE_INTEGRATION_TOKEN}`,
      'Version': '2021-07-28',
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GHL fetchContact failed: ${response.status} ${errText}`);
  }
  const body = await response.json();
  const contact = body.contact || body;
  return Array.isArray(contact.customFields) ? contact.customFields : [];
}
