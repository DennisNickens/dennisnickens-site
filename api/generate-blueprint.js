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

const { scoreAssessment } = require('../lib/scoring');
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

  // Step 1: Score the assessment
  const scores = scoreAssessment(payload.rawAnswers || {});
  console.log(`[Blueprint] Scoring complete for ${payload.contact_id}`);

  // Step 2: Build the user message for Claude
  const userMessage = buildUserMessage(payload, scores);

  // Step 3: Get the master prompt
  const systemPrompt = await getMasterPrompt();

  // Step 4: Call Claude API
  const blueprintMarkdown = await callClaude(systemPrompt, userMessage);
  console.log(`[Blueprint] Claude returned ${blueprintMarkdown.length} characters`);

  // Step 5: Convert markdown to branded HTML
  const blueprintHtml = markdownToBrandedHtml(blueprintMarkdown, payload);

  // Step 6: Save to Vercel Blob
  const blueprintUrl = await saveToBlob(payload.contact_id, blueprintHtml);
  console.log(`[Blueprint] Saved to ${blueprintUrl}`);

  // Step 7: Update GHL contact
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
  });

  console.log(`[Blueprint] Complete. WF-04 will now fire delivery email.`);
}

// =======================================================================
// HELPER: GET MASTER PROMPT
// =======================================================================
// The master prompt is stored as a markdown file at /assessment/master-prompt.md
// in the same Vercel deployment. Fetched on each invocation (cached after cold start).

async function getMasterPrompt() {
  // Option A: Fetch from a public URL on the deployment
  const response = await fetch('https://dennisnickens.com/assessment/master-prompt.md');
  if (!response.ok) {
    throw new Error(`Failed to fetch master prompt: ${response.status}`);
  }
  return await response.text();
}

// =======================================================================
// HELPER: BUILD USER MESSAGE FOR CLAUDE
// =======================================================================

function buildUserMessage(payload, scores) {
  return `Generate a complete Alignment Blueprint for this customer following the master prompt's structure and voice exactly.

CUSTOMER:
- Name: ${payload.first_name} ${payload.last_name}
- Email: ${payload.email}
- SKU Tier: ${payload.sku_tier || 'Solo'}
- Relationship Lens: ${payload.lens || 'General'}
- Their Situation (in their own words): ${payload.lens_detail || 'Not specified'}

ASSESSMENT SCORES:

PILLAR 1: BEHAVIOR PROFILE (DISC)
- D (Dominance): ${scores.pillar1.scores10.d}/10 (${scores.pillar1.d} answers)
- I (Influence): ${scores.pillar1.scores10.i}/10 (${scores.pillar1.i} answers)
- S (Steadiness): ${scores.pillar1.scores10.s}/10 (${scores.pillar1.s} answers)
- C (Conscientiousness): ${scores.pillar1.scores10.c}/10 (${scores.pillar1.c} answers)
- Dominant Type: ${scores.pillar1.twoLetterType}

PILLAR 2: PERSONALITY CODE (MBTI-style)
- Type: ${scores.pillar2.type}
- E/I leaning: ${scores.pillar2.letters.e_i}
- S/N leaning: ${scores.pillar2.letters.s_n}
- T/F leaning: ${scores.pillar2.letters.t_f}
- J/P leaning: ${scores.pillar2.letters.j_p}
- Tied dichotomies (if any): ${scores.pillar2.balanced.join(', ') || 'None'}

PILLAR 3: ACTION STYLE
- Fact Finder: ${scores.pillar3.factFinder}
- Follow Thru: ${scores.pillar3.followThru}
- Quick Start: ${scores.pillar3.quickStart}
- Implementor: ${scores.pillar3.implementor}
- Dominant Mode: ${scores.pillar3.dominantMode}
- Secondary Mode: ${scores.pillar3.secondaryMode}

PILLAR 4: CONNECTION LANGUAGE
- Words: ${scores.pillar4.words}
- Time: ${scores.pillar4.time}
- Touch: ${scores.pillar4.touch}
- Service: ${scores.pillar4.service}
- Gifts: ${scores.pillar4.gifts}
- Primary: ${scores.pillar4.primary}
- Secondary: ${scores.pillar4.secondary}

PILLAR 5: LEARNING CHANNEL
- Visual: ${scores.pillar5.visualPct}%
- Auditory: ${scores.pillar5.auditoryPct}%
- Reading: ${scores.pillar5.readingPct}%
- Doing: ${scores.pillar5.doingPct}%
- Dominant Channel: ${scores.pillar5.dominantChannel}

PILLAR 6: SPIRITUAL COMPASS
- Faith Orientation: ${scores.pillar6.faithOrientation}
- Primary Theme: ${scores.pillar6.primaryTheme}
- Secondary Theme: ${scores.pillar6.secondaryTheme}
- Theme Distribution: ${JSON.stringify(scores.pillar6.themeCounts)}

INSTRUCTIONS FOR THIS BLUEPRINT:

Generate the complete 9-section Blueprint as defined in the master prompt:
1. Executive Summary
2. Section 1: Your Behavior Profile (with strengths, blind spots, leverage points)
3. Section 2: Your Personality Code
4. Section 3: Your Action Style
5. Section 4: Your Connection Language (with 5-language ranking and bridge strategies)
6. Section 5: Your Learning Channel (with environment recommendations)
7. Section 6: Your Spiritual Compass (with 3 personalized scripture verses calibrated to this person's combined archetype)
8. Section 7: Your Misalignment Map (where the pillars conflict and what it costs)
9. Section 8: Your Strategic Recommendations (Quick Win, Medium Shift, 90-Day Track)
10. Section 9: Your 30-Day Alignment Plan (week-by-week protocol)

Use Dennis Nickens's voice. Plain English. Direct, warm, consultative. NO em dashes or en dashes (replace with commas, periods, or rephrase). NO AI-sounding phrases ("delve into," "navigate the landscape," "in today's fast-paced world," "tapestry," etc.). Sign off with "Dennis Nickens" not "Dennis,".

The Blueprint should be specific to ${payload.first_name}, not generic. Reference their scores explicitly. Address them by first name.

Output the complete Blueprint as markdown. About 20 to 30 pages of substantive content.`;
}

// =======================================================================
// HELPER: CALL CLAUDE API
// =======================================================================

async function callClaude(systemPrompt, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
      ],
    }),
  });

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
      padding: 3rem 2rem;
      background: linear-gradient(180deg, #07071a 0%, #0f0a2e 50%, #07071a 100%);
      color: #f5f1e8;
      line-height: 1.7;
      min-height: 100vh;
    }
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
  ${innerHtml}
  <div class="footer">
    Generated for ${payload.first_name} ${payload.last_name} on ${new Date().toLocaleDateString()}<br/>
    Spiritual Romeo · Foundational Tools for Self-Understanding<br/>
    dennisnickens.com
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
