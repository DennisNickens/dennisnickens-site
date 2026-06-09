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
// PILLAR 7 PATH B SCORING (Set H Manifestation Gifts, Set I Fruits)
// =======================================================================
// Pre-processing layer for Blueprint subsections 6.2B and 6.2C. Set G
// (Motivational Gifts, 6.2A) is scored upstream in lib/scoring.js via
// scoreAssessment and is NOT touched here. These two functions read the raw
// Set H / Set I conditional answers off the GHL contact and produce structured
// results the model consumes (master prompt commit 6d53f73 defines 6.2B/6.2C).
//
// Both return null when their set is absent or too sparse, which lets the master
// prompt's "skip the subsection" gating fire naturally.

// Q-H Reference Table: each Set H question's option (A/B/C/D) -> Manifestation Gift.
const QH_MAPPING = {
  'srConditional_QH1':  { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Gifts of Healing' },
  'srConditional_QH2':  { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Gifts of Healing' },
  'srConditional_QH3':  { A: 'Different Kinds of Tongues', B: 'Interpretation of Tongues', C: 'Prophecy',                   D: 'Discerning of Spirits' },
  'srConditional_QH4':  { A: 'Gift of Faith',              B: 'Gifts of Healing',          C: 'Different Kinds of Tongues', D: 'Prophecy' },
  'srConditional_QH5':  { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Working of Miracles' },
  'srConditional_QH6':  { A: 'Prophecy',                   B: 'Discerning of Spirits',     C: 'Different Kinds of Tongues', D: 'Interpretation of Tongues' },
  'srConditional_QH7':  { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Gifts of Healing' },
  'srConditional_QH8':  { A: 'Word of Wisdom',             B: 'Gift of Faith',             C: 'Discerning of Spirits',      D: 'Prophecy' },
  'srConditional_QH9':  { A: 'Gifts of Healing',           B: 'Working of Miracles',       C: 'Prophecy',                   D: 'Gift of Faith' },
  'srConditional_QH10': { A: 'Word of Knowledge',          B: 'Discerning of Spirits',     C: 'Word of Wisdom',             D: 'Gifts of Healing' },
  'srConditional_QH11': { A: 'Different Kinds of Tongues', B: 'Interpretation of Tongues', C: 'Prophecy',                   D: 'Word of Wisdom' },
  'srConditional_QH12': { A: 'Gift of Faith',              B: 'Working of Miracles',       C: 'Word of Knowledge',          D: 'Word of Wisdom' },
  'srConditional_QH13': { A: 'Working of Miracles',        B: 'Prophecy',                  C: 'Discerning of Spirits',      D: 'Different Kinds of Tongues' },
  'srConditional_QH14': { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Discerning of Spirits' },
  'srConditional_QH15': { A: 'Gifts of Healing',           B: 'Working of Miracles',       C: 'Word of Wisdom',             D: 'Prophecy' },
  'srConditional_QH16': { A: 'Different Kinds of Tongues', B: 'Interpretation of Tongues', C: 'Prophecy',                   D: 'Discerning of Spirits' },
  'srConditional_QH17': { A: 'Word of Wisdom',             B: 'Word of Knowledge',         C: 'Gift of Faith',              D: 'Gifts of Healing' },
  'srConditional_QH18': { A: 'Discerning of Spirits',      B: 'Prophecy',                  C: 'Word of Wisdom',             D: 'Different Kinds of Tongues' },
  'srConditional_QH19': { A: 'Prophecy',                   B: 'Word of Wisdom',            C: 'Word of Knowledge',          D: 'Discerning of Spirits' },
  'srConditional_QH20': { A: 'Gifts of Healing',           B: 'Working of Miracles',       C: 'Gift of Faith',              D: 'Prophecy' },
};

// Tie-break priority when two Manifestation Gifts have equal counts (earlier wins).
const MANIFESTATION_TIEBREAK_ORDER = [
  'Word of Wisdom', 'Word of Knowledge', 'Gift of Faith', 'Gifts of Healing', 'Working of Miracles',
  'Prophecy', 'Discerning of Spirits', 'Different Kinds of Tongues', 'Interpretation of Tongues',
];

// Q-I mapping: each Set I question -> the Fruit it scores (two questions per fruit).
const QI_FRUIT_MAPPING = {
  'srConditional_QI1':  'Love',
  'srConditional_QI2':  'Love',
  'srConditional_QI3':  'Joy',
  'srConditional_QI4':  'Joy',
  'srConditional_QI5':  'Peace',
  'srConditional_QI6':  'Peace',
  'srConditional_QI7':  'Patience',
  'srConditional_QI8':  'Patience',
  'srConditional_QI9':  'Kindness',
  'srConditional_QI10': 'Kindness',
  'srConditional_QI11': 'Goodness',
  'srConditional_QI12': 'Goodness',
  'srConditional_QI13': 'Faithfulness',
  'srConditional_QI14': 'Faithfulness',
  'srConditional_QI15': 'Gentleness',
  'srConditional_QI16': 'Gentleness',
  'srConditional_QI17': 'Self-Control',
  'srConditional_QI18': 'Self-Control',
};

// Set I frequency scale -> numeric score.
const QI_SCORE_MAPPING = {
  'A': 1,  // Almost Never
  'B': 2,  // Sometimes
  'C': 3,  // Often
  'D': 4,  // Almost Always
};

const FRUIT_CANONICAL_ORDER = [
  'Love', 'Joy', 'Peace', 'Patience', 'Kindness', 'Goodness', 'Faithfulness', 'Gentleness', 'Self-Control',
];

// Normalize a stored conditional answer to a single uppercase letter A-D.
// Handles both a bare letter ("A") and GHL's stored option text, which carries a
// leading letter prefix ("A) full option sentence..."). Returns null when no
// letter can be extracted.
function normalizeOptionLetter(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^[A-Da-d]$/.test(v)) return v.toUpperCase();          // bare letter
  const m = v.match(/^([A-Da-d])\s*[).:\-\]]/);              // "A) ...", "A. ...", "A] ..."
  if (m) return m[1].toUpperCase();
  return null;
}

// Read one conditional answer by its srConditional_* key. Accepts either the GHL
// customFields array (objects carrying key/fieldKey/conditionalKey + value) or a
// plain object map { srConditional_QH1: 'A' } (used by tests). Returns the raw
// stored value (string) or null.
function readConditionalAnswer(contactFields, key) {
  if (!contactFields) return null;
  if (!Array.isArray(contactFields)) {
    const direct = contactFields[key];
    if (direct == null) return null;
    if (typeof direct === 'object') {
      return direct.value ?? direct.field_value ?? direct.fieldValueString ?? null;
    }
    return direct;
  }
  for (const f of contactFields) {
    if (!f) continue;
    const k = f.key || f.fieldKey || f.conditionalKey || '';
    if (k === key) {
      return f.value ?? f.field_value ?? f.fieldValueString ?? f.fieldValue ?? null;
    }
  }
  return null;
}

// computeManifestationGifts: top-3 Manifestation Gifts from Set H (Q-H1..Q-H20).
// Returns null (skip 6.2B) when fewer than 15 of the 20 answers are populated.
function computeManifestationGifts(contactFields) {
  const letters = {};
  let populated = 0;
  for (let i = 1; i <= 20; i++) {
    const key = `srConditional_QH${i}`;
    const letter = normalizeOptionLetter(readConditionalAnswer(contactFields, key));
    if (letter) { letters[key] = letter; populated++; }
  }
  if (populated < 15) return null;

  const counts = {};
  MANIFESTATION_TIEBREAK_ORDER.forEach((g) => { counts[g] = 0; });
  for (const key of Object.keys(letters)) {
    const map = QH_MAPPING[key];
    const gift = map && map[letters[key]];
    if (gift && gift in counts) {
      counts[gift]++;
    } else {
      console.warn(`[Blueprint] Set H ${key}: answer "${letters[key]}" did not map via QH_MAPPING`);
    }
  }

  const ranked = MANIFESTATION_TIEBREAK_ORDER
    .map((gift, order) => ({ gift, count: counts[gift], order }))
    .sort((a, b) => b.count - a.count || a.order - b.order);

  return {
    primary:   ranked[0].gift,
    secondary: ranked[1].gift,
    tertiary:  ranked[2].gift,
    rawCounts: counts,
  };
}

// computeFruitsOfTheSpirit: growth-diagnostic over all 9 Fruits from Set I
// (Q-I1..Q-I18). Returns null (skip 6.2C) when fewer than 14 of the 18 answers
// are populated. Each fruit sums its two questions (A=1..D=4, range 2-8) and is
// classified Strong (6-8) / Developing (4-5) / Growth Edge (2-3).
function computeFruitsOfTheSpirit(contactFields) {
  const totals = {};
  FRUIT_CANONICAL_ORDER.forEach((fruit) => { totals[fruit] = 0; });
  let populated = 0;
  for (let i = 1; i <= 18; i++) {
    const key = `srConditional_QI${i}`;
    const letter = normalizeOptionLetter(readConditionalAnswer(contactFields, key));
    if (!letter) continue;
    const fruit = QI_FRUIT_MAPPING[key];
    const score = QI_SCORE_MAPPING[letter];
    if (fruit && score) {
      totals[fruit] += score;
      populated++;
    } else {
      console.warn(`[Blueprint] Set I ${key}: could not score (fruit=${fruit}, letter=${letter}) via QI_FRUIT_MAPPING/QI_SCORE_MAPPING`);
    }
  }
  if (populated < 14) return null;

  const tierFor = (total) => (total >= 6 ? 'Strong' : total >= 4 ? 'Developing' : 'Growth Edge');
  const fruits = {};
  const strongFruits = [];
  const developingFruits = [];
  const growthEdgeFruits = [];
  for (const fruit of FRUIT_CANONICAL_ORDER) {
    const score = totals[fruit];
    const tier = tierFor(score);
    fruits[fruit] = { score, tier };
    if (tier === 'Strong') strongFruits.push(fruit);
    else if (tier === 'Developing') developingFruits.push(fruit);
    else growthEdgeFruits.push(fruit);
  }

  return { fruits, strongFruits, developingFruits, growthEdgeFruits };
}

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

  // Normalize naming conventions. Webhook callers may send camelCase
  // (firstName/lastName) while our code expects snake_case (first_name/last_name).
  // Always set the snake_case fields from camelCase if not already set. This
  // prevents 'undefined' from leaking into the Blueprint cover, HTML title,
  // and footer when the caller used camelCase.
  if (payload) {
    if (!payload.first_name && payload.firstName) payload.first_name = payload.firstName;
    if (!payload.last_name && payload.lastName) payload.last_name = payload.lastName;
  }

  // COUPLES CONNECTION MAP path (mode=couples). Standalone relational deliverable
  // built from two already-scored paired contacts. Fully independent of the solo
  // Blueprint flow below: it never gates, waits on, or alters per-contact solo
  // generation. Requires both contact IDs in the body.
  if (payload && payload.mode === 'couples') {
    if (!payload.primary_contact_id || !payload.secondary_contact_id) {
      return res.status(400).json({
        error: 'mode=couples requires both primary_contact_id and secondary_contact_id',
      });
    }
    waitUntil(
      generateAndDeliverCouplesMap(payload).catch((err) => {
        console.error('[CouplesMap] Generation failed:', err);
      })
    );
    return res.status(202).json({
      status: 'processing',
      message: 'Couples Connection Map generation started, will be delivered via email shortly',
    });
  }

  // Tell Vercel to keep the function alive until generation completes.
  // waitUntil gives us up to 30s on Hobby tier and 5min on Pro tier.
  // Without this, Vercel kills the function as soon as the response is flushed.
  const startedAt = Date.now();
  waitUntil(
    generateAndDeliverBlueprint(payload).catch(async (err) => {
      console.error('[Blueprint] Generation failed:', err);
      if (payload && payload.contact_id) {
        try {
          console.error("Blueprint generation failed:", err);
          // Distinguish a function/platform abort (waitUntil budget, instance teardown)
          // from our per-chunk AbortController timeouts (which throw the specific
          // "Claude API client timeout (Xs) on chunk Y" message). A raw AbortError or an
          // "aborted" message reaching here did NOT come from a chunk controller, so tag
          // it as a platform abort with the elapsed time instead of leaking the generic
          // "This operation was aborted" string.
          const elapsedSecs = Math.round((Date.now() - startedAt) / 1000);
          const isPlatformAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
          const statusValue = isPlatformAbort
            ? `Failed: function/platform abort (not a chunk timeout) after ${elapsedSecs}s`
            : "Failed: " + (err?.message || String(err)).slice(0, 800);
          await updateGhlContact(payload.contact_id, {
            sr_blueprint_status: statusValue,
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
    // Pillar 7 Path B (6.2B/6.2C): test path may pass contactFields on rawAnswers;
    // absent => both null, so the master prompt skips those subsections.
    const testFields = payload.rawAnswers && payload.rawAnswers.contactFields;
    payload.manifestationGifts = computeManifestationGifts(testFields);
    payload.fruitsOfTheSpirit = computeFruitsOfTheSpirit(testFields);
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

  // Pillar 7 Path B (6.2B Manifestation Gifts, 6.2C Fruits of the Spirit). Read the
  // raw Set H / Set I answers straight off the contact's customFields. Each returns
  // null when its set is absent or too sparse, which lets the master prompt skip the
  // subsection. Set G (6.2A) is already scored inside meScores.spiritualGifts above.
  payload.manifestationGifts = computeManifestationGifts(meCustomFields);
  payload.fruitsOfTheSpirit = computeFruitsOfTheSpirit(meCustomFields);
  console.log(`[Blueprint] Pillar 7 Path B: manifestationGifts=${payload.manifestationGifts ? 'present' : 'absent'}, fruitsOfTheSpirit=${payload.fruitsOfTheSpirit ? 'present' : 'absent'}`);

  // Pair status no longer gates generation timing. Every contact's solo Blueprint
  // fires immediately on assessment completion, whether or not they belong to a
  // Linked Pair. There is no longer a hold-until-both-complete branch and no
  // simultaneous paired generation here.
  //
  // The pairing fields on the contact record (sr_pair_role,
  // sr_pair_partner_contact_id) are intentionally NOT read here anymore. They stay on
  // the record so the separate Couples Connection Map generator (a follow-up
  // deliverable) can read them later to find the partner contact and build the Map as
  // its own artifact.
  //
  // partnerData is passed as null so a solo Blueprint NEVER builds a partner data
  // block and NEVER generates the Section 17 Connection Map. The master prompt already
  // skips Section 17 when partner_data is absent.
  await produceAndDeliverBlueprint(payload, meScores, null);

  // AUTO-TRIGGER: Couples Connection Map. The solo Blueprint above has now delivered
  // (generated, saved, GHL updated, email sent). If this contact is part of a Linked
  // Pair AND their partner's solo Blueprint is already "Generated", then this contact
  // is the second of the two to finish, so fire the Couples Map automatically. This
  // removes the old manual text-Dennis trigger step.
  //
  // This entire block is best-effort and fire-and-forget: the solo Blueprint already
  // shipped, so any failure here (network, GHL down, malformed partner data, a missing
  // custom field) is logged and swallowed. It must NEVER roll back or fail the solo
  // delivery that already succeeded.
  try {
    const partnerContactId = readContactField(me, 'sr_pair_partner_contact_id');
    if (!partnerContactId) {
      console.log('[AutoTrigger] Skipped: no sr_pair_partner_contact_id (solo contact, not paired).');
      return;
    }
    console.log(`[AutoTrigger] Partner ID: ${partnerContactId}`);

    const partner = await fetchGhlContact(partnerContactId);
    if (!partner) {
      console.log(`[AutoTrigger] Skipped: could not fetch partner contact ${partnerContactId} from GHL.`);
      return;
    }

    // Idempotency (light layer): if the partner already has a Couples Map URL, an
    // earlier run already fired it, so skip to avoid duplicate Maps when both contacts
    // finish at nearly the same time. readContactField returns '' when
    // sr_couples_map_url does not exist in GHL yet, so a missing field is treated as
    // empty and we proceed (never crash on a not-yet-created field).
    const existingMapUrl = readContactField(partner, 'sr_couples_map_url') || '';
    if (existingMapUrl.startsWith('http')) {
      console.log(`[AutoTrigger] Skipped: partner already has sr_couples_map_url (${existingMapUrl}).`);
      return;
    }

    const partnerStatus = (readContactField(partner, 'sr_blueprint_status') || '').trim();
    console.log(`[AutoTrigger] Partner status: ${partnerStatus}`);

    if (partnerStatus !== 'Generated') {
      console.log(`[AutoTrigger] Skipped: partner status is "${partnerStatus}", not "Generated". Their completion will fire the Couples Map.`);
      return;
    }

    console.log('[AutoTrigger] Firing Couples Map');
    const resp = await fetch('https://dennisnickens.com/api/generate-blueprint', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SR_WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'couples',
        primary_contact_id: payload.contact_id,  // the contact that just finished
        secondary_contact_id: partnerContactId,
      }),
    });
    console.log(`[AutoTrigger] Couples Map request returned HTTP ${resp.status}.`);
  } catch (err) {
    // Solo Blueprint already delivered. Auto-trigger is bonus, so never let this throw.
    console.error('[AutoTrigger] Error (solo Blueprint already delivered, ignoring):', err);
  }
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

// Generates the full Blueprint markdown using THREE parallel Claude calls, each
// responsible for a range of sections, then stitches the outputs together in order.
//   Call A: front matter (Cover Page through Executive Summary) plus Sections 1 to 6.
//   Call B: Sections 7 to 11 (Misalignment, Career, Relationship, conditional Parenting/Leadership).
//   Call C: Sections 12 to 17 (conditional Ministry, Stress, Strategic, 30 Day Plan,
//           the paired Connection Map) plus What Is Next, the Disclaimer, and the close.
// There is no Section 13: Spiritual Gifts live in Subsection 6.2 (generated in Call A),
// so Call C's numbering jumps 12 to 14.
//
// All three calls share the SAME cached system prompt (master-prompt.md wrapped in a
// cache_control: ephemeral content block, set in callClaude) and the SAME customer data
// block. Only the per-call section instruction differs. The shared system prompt is the
// large input, so after the first call warms the cache the other two read it from cache
// (the original Tier 1 rate-limit problem from the reverted multi-call attempt is gone).
// Running the three in parallel keeps wall-clock near the slowest single call, and each
// call has its own 90s AbortController. If ANY call throws (timeout or API error),
// Promise.all rejects and the existing Failed-status path records it. We never ship a
// partial Blueprint.
async function generateMultiCallBlueprintMarkdown(payload, scores, partnerData) {
  const systemPrompt = await getMasterPrompt();
  const cid = payload.contact_id;

  const userMessageA1 = buildCallA1Message(payload, scores, partnerData);
  const userMessageA2 = buildCallA2Message(payload, scores, partnerData);
  const userMessageB = buildCallBMessage(payload, scores, partnerData);
  const userMessageC = buildCallCMessage(payload, scores, partnerData);

  // Four-call architecture. Stage A1 first to warm the prompt cache before A2, B, and C
  // fire in parallel. Without this, all calls race and each pays the full master prompt
  // input cost, blowing the Tier 1 30K/min rate limit on paired runs. Once A1 returns,
  // the cached master prompt block is warm, so A2, B, and C read it from cache (~500 user
  // payload tokens counted instead of ~15K each). Splitting the old heavy Call A (front
  // matter plus Sections 1 to 6) into A1 (front matter plus 1 to 3) and A2 (4 to 6) keeps
  // each chunk's output small enough to finish inside its AbortController window. The
  // trimmed master prompt (about 16K tokens) keeps the rate limit math satisfied without
  // an inter-chunk wait, so A2, B, and C fire immediately after A1 warms the cache.
  // Worst-case wall-clock: A1 (200s) + max(A2, B, C) (240s) = 440s, under the 800s Pro ceiling.
  const chunkA1 = await callClaude(systemPrompt, userMessageA1, cid, 'A1', 200000);
  const [chunkA2, chunkB, chunkC] = await Promise.all([
    callClaude(systemPrompt, userMessageA2, cid, 'A2', 240000),
    callClaude(systemPrompt, userMessageB, cid, 'B', 240000),
    callClaude(systemPrompt, userMessageC, cid, 'C', 240000),
  ]);

  // Stitch in order: A1 + A2 + B + C, one blank line between each chunk.
  return [chunkA1, chunkA2, chunkB, chunkC].map((p) => p.trim()).join('\n\n');
}

// Produces one person's Blueprint end to end: generate (3 parallel calls), render
// HTML, save to Blob, update GHL, email. When partnerData is present, Call C writes
// the Connection Map. Shared by the solo and paired flows.
async function produceAndDeliverBlueprint(payload, scores, partnerData) {
  const blueprintMarkdown = await generateMultiCallBlueprintMarkdown(payload, scores, partnerData);
  console.log(`[Blueprint] Multi-call generation produced ${blueprintMarkdown.length} characters for ${payload.contact_id}`);

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

// =======================================================================
// COUPLES CONNECTION MAP (standalone deliverable, mode=couples)
// =======================================================================
// Separate from the solo Blueprint flow. Reads two already-scored paired contacts
// and produces a focused Connection Map document (Section 17 structure only, no
// Sections 1-16, no individual Blueprint). A single Claude call (much smaller than a
// full Blueprint) renders through the same branded HTML + signoff styling, saves to
// Blob, writes the URL to both contacts, and emails both partners the same email.

async function generateAndDeliverCouplesMap(payload) {
  const primaryId = payload.primary_contact_id;
  const secondaryId = payload.secondary_contact_id;
  console.log(`[CouplesMap] Starting for primary=${primaryId}, secondary=${secondaryId}`);

  try {
    // Fetch both contacts in parallel. Each carries the customFields we score from.
    const [primary, secondary] = await Promise.all([
      fetchGhlContact(primaryId),
      fetchGhlContact(secondaryId),
    ]);
    if (!primary) throw new Error(`Could not fetch primary contact ${primaryId} from GHL`);
    if (!secondary) throw new Error(`Could not fetch secondary contact ${secondaryId} from GHL`);

    const primaryPayload = payloadFromContact(primary);
    const secondaryPayload = payloadFromContact(secondary);
    const primaryScores = scoreAssessment(
      buildRawAnswersFromCustomFields(Array.isArray(primary.customFields) ? primary.customFields : [])
    );
    const secondaryScores = scoreAssessment(
      buildRawAnswersFromCustomFields(Array.isArray(secondary.customFields) ? secondary.customFields : [])
    );
    console.log(`[CouplesMap] Scored both contacts (${primaryPayload.first_name} + ${secondaryPayload.first_name}).`);

    // Single Claude call against the SAME cached master prompt (cache_control set in
    // callClaude). Output is ~2,000-3,000 words, which Sonnet 4.6 takes roughly
    // 150-200s to produce, so the Couples chunk gets a 240s timeout. The Couples flow
    // has the full 800s Vercel ceiling to itself, so 240s leaves comfortable headroom.
    // This does NOT touch the solo per-chunk timeouts (A1 200s, A2/B/C 240s).
    //
    // contactId is passed as null so callClaude's own abort/error handler NEVER writes
    // a failure to sr_blueprint_status. That field holds the solo Blueprint result and
    // must not be corrupted when a Couples Map fails. Couples failures are recorded on
    // sr_couples_map_status in the catch below instead.
    const systemPrompt = await getMasterPrompt();
    const userMessage = buildCouplesMapMessage(primaryPayload, primaryScores, secondaryPayload, secondaryScores);
    const mapMarkdown = await callClaude(systemPrompt, userMessage, null, 'COUPLES', 240000, 6000);
    console.log(`[CouplesMap] Generation produced ${mapMarkdown.length} characters.`);

    // Render with the existing branded renderer (same CSS, same signoff styling). The
    // title/footer use a combined "Primary & Secondary" name.
    const renderPayload = {
      first_name: `${primaryPayload.first_name || 'Partner 1'} & ${secondaryPayload.first_name || 'Partner 2'}`,
      last_name: '',
    };
    const mapHtml = markdownToBrandedHtml(mapMarkdown, renderPayload);
    const mapUrl = await saveToBlob(`couples-${primaryId}-${secondaryId}`, mapHtml);
    console.log(`[CouplesMap] Saved to ${mapUrl}`);

    // Write the URL to BOTH contacts (new field sr_couples_map_url). If the field does
    // not exist yet, writeCouplesMapUrl logs the URL instead of failing the run.
    await Promise.all([
      writeCouplesMapUrl(primaryId, mapUrl),
      writeCouplesMapUrl(secondaryId, mapUrl),
    ]);

    // Email BOTH contacts the same delivery email.
    await sendCouplesMapEmail(primaryPayload, secondaryPayload, mapUrl);
    console.log(`[CouplesMap] Delivery email sent for ${primaryId} and ${secondaryId}.`);
  } catch (err) {
    // Couples Map failed. Record the failure on sr_couples_map_status for BOTH
    // contacts, never on sr_blueprint_status (which holds each person's solo Blueprint
    // result). If sr_couples_map_status does not exist in GHL yet, writeCouplesMapStatus
    // logs to console and moves on. Either way, both solo Blueprints stay untouched.
    console.error(`[CouplesMap] Generation failed for primary=${primaryId}, secondary=${secondaryId}:`, err);
    const statusValue = `Failed: ${(err && err.message) || String(err)}`.slice(0, 800);
    await Promise.all([
      writeCouplesMapStatus(primaryId, statusValue),
      writeCouplesMapStatus(secondaryId, statusValue),
    ]);
    throw err;
  }
}

// Builds the single user message for the Couples Map. Provides both contacts' full
// pillar scores and qualifier answers (via buildCustomerDataBlock with null
// partnerData), then instructs Claude to produce ONLY the standalone Connection Map.
function buildCouplesMapMessage(primaryPayload, primaryScores, secondaryPayload, secondaryScores) {
  const primaryName = primaryPayload.first_name || 'Partner 1';
  const secondaryName = secondaryPayload.first_name || 'Partner 2';

  return `Generate ONLY a standalone Couples Connection Map document for ${primaryName} and ${secondaryName}. Use the Connection Map subsection structure from Section 17 of the master prompt, but render the seven subsection headings as plain title text. The seven headings are: "Your Pair at a Glance", "What Each of You Brings", "Where You Align", "Where You Speak Different Languages", "Your Connection Currency Map", "How to Bridge the Gaps", "Your 30-60-90 Day Plan". Render each one as a level-4 markdown heading (#### Your Pair at a Glance). Do NOT prefix any heading with "Section", "Section 17", "17.1", "17.2", or any other numeric or "Section" prefix. The subsection title is the entire heading. Begin with a cover page that reads "Your Couples Connection Map for ${primaryName} and ${secondaryName}". Do not generate Sections 1-16. Do not include any preamble that references having read the individual Blueprints. The document stands on its own.

Use Dennis Nickens's voice: plain English, direct, warm, consultative. No em dashes or en dashes (use commas, periods, parentheses, or rephrase). No AI-sounding phrases. Use the SR-native CORE vocabulary. Address ${primaryName} and ${secondaryName} by name, and write the Map comparing the two of them. Sign off as "Dennis Nickens".

=== PRIMARY PARTNER: ${primaryName} ===
${buildCustomerDataBlock(primaryPayload, primaryScores, null)}

=== SECONDARY PARTNER: ${secondaryName} ===
${buildCustomerDataBlock(secondaryPayload, secondaryScores, null)}`;
}

// Writes the Couples Map URL to a contact's sr_couples_map_url custom field. If the
// field does not exist yet (or any GHL error occurs), logs the URL to console so the
// run still succeeds and Dennis can wire the field / grab the URL manually.
async function writeCouplesMapUrl(contactId, url) {
  try {
    await updateGhlContact(contactId, { sr_couples_map_url: url });
    console.log(`[CouplesMap] Wrote sr_couples_map_url to contact ${contactId}.`);
  } catch (err) {
    console.log(
      `[CouplesMap] Could not write sr_couples_map_url to contact ${contactId} ` +
      `(field may not exist yet). Couples Map URL: ${url}. Error: ${err.message || err}`
    );
  }
}

// Writes a Couples Map status (e.g. a failure reason) to a contact's
// sr_couples_map_status custom field. This is deliberately SEPARATE from
// sr_blueprint_status so a Couples Map failure can never overwrite a successfully
// delivered solo Blueprint's status. If sr_couples_map_status does not exist in GHL
// yet, the update fails and we log to console only (no other field is touched).
async function writeCouplesMapStatus(contactId, statusValue) {
  try {
    await updateGhlContact(contactId, { sr_couples_map_status: statusValue });
    console.log(`[CouplesMap] Wrote sr_couples_map_status to contact ${contactId}: ${statusValue}`);
  } catch (err) {
    console.log(
      `[CouplesMap] Could not write sr_couples_map_status to contact ${contactId} ` +
      `(field may not exist yet). Status was: ${statusValue}. Error: ${err.message || err}`
    );
  }
}

// Emails the Couples Map to BOTH contacts in a single send (same email to both).
async function sendCouplesMapEmail(primaryPayload, secondaryPayload, mapUrl) {
  const recipients = [primaryPayload.email, secondaryPayload.email].filter(Boolean);
  if (recipients.length === 0) {
    console.log('[CouplesMap] No recipient emails on either contact; skipping email send.');
    return null;
  }
  const primaryName = primaryPayload.first_name || 'there';
  const secondaryName = secondaryPayload.first_name || 'there';
  const subject = 'Your Couples Connection Map is ready';

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem; color: #07071a;">
  <h1 style="font-family: 'Playfair Display', Georgia, serif; color: #07071a; font-size: 28px;">${primaryName} and ${secondaryName}, your Couples Connection Map is ready.</h1>

  <p>You both finished your individual Blueprints. This is the next piece: a Connection Map built from both of your results, showing where the two of you align, where you speak different languages, and how to bridge the gaps.</p>

  <p style="text-align: center; margin: 2rem 0;">
    <a href="${mapUrl}" style="display: inline-block; background: #07071a; color: #d4a957; padding: 14px 32px; text-decoration: none; font-weight: 600; border-radius: 4px;">View Your Couples Connection Map</a>
  </p>

  <p>Read it together. The most useful conversations come from the "Where You Speak Different Languages" and "How to Bridge the Gaps" sections, and the 30-60-90 Day Plan gives you concrete steps to start on.</p>

  <p>Reply to this email if you have questions. I read everything.</p>

  <p style="margin-top: 2rem;">Dennis Nickens<br>Behavioral and Alignment Consultant<br>dennisnickens.com</p>
</body>
</html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dennis Nickens <dennis@dennisnickens.com>',
      to: recipients,
      bcc: ['admin@dennisnickens.com'],
      subject: subject,
      html: htmlBody,
      reply_to: 'admin@dennisnickens.com',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend couples email send failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  console.log(`[CouplesMap] Email sent via Resend to ${recipients.join(', ')}, message ID: ${result.id || 'n/a'}`);
  return result;
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

  <p>You just finished The Blueprint Assessment. Your personalized Blueprint, all six pillars analyzed and synthesized into a complete map of how you are wired, is now ready to read.</p>

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

// Builds the shared customer data context. This block is IDENTICAL across all three
// generation calls so each Claude call has full context of who the customer is. Only
// the per-call section instruction (added by the call builders) differs.
function buildCustomerDataBlock(payload, scores, partnerData) {
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

  // Linked Pair: when partnerData is present, append the partner's results so Call C
  // can write the Section 17 Connection Map. Absent for Solo customers (no Map).
  const partnerBlock = partnerData ? buildPartnerBlock(partnerData) : '';

  return `CUSTOMER:
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
})()}${(() => {
  // Pillar 7 Path B structured scoring for Subsection 6.2B. Pre-computed top three
  // Manifestation Gifts plus the raw per-gift counts, as JSON the model references
  // directly. Absent (no block) when Set H did not fire.
  const mg = payload.manifestationGifts;
  if (!mg) return '';
  return `\nMANIFESTATION GIFTS (PILLAR 7, SUBSECTION 6.2B):\n${JSON.stringify(mg, null, 2)}\n`;
})()}${(() => {
  // Pillar 7 Path B structured scoring for Subsection 6.2C. Per-fruit score and tier
  // for all nine Fruits plus the Strong/Developing/Growth-Edge groupings, as JSON.
  // Absent (no block) when Set I did not fire.
  const fos = payload.fruitsOfTheSpirit;
  if (!fos) return '';
  return `\nFRUITS OF THE SPIRIT (PILLAR 7, SUBSECTION 6.2C):\n${JSON.stringify(fos, null, 2)}\n`;
})()}${conditionalAnswerBlock}${partnerBlock}`;
}

// Shared header prepended to every call. The full voice and section specs live in the
// cached system prompt (master-prompt.md); this is a per-call reminder that each pass is
// one chunk of a Blueprint stitched together from three parallel passes.
const MULTI_CALL_HEADER = `Generate part of a complete Alignment Blueprint for this customer, following the master prompt structure and voice exactly. The full Blueprint is produced in several parallel passes and stitched together in order. This pass covers ONLY the section range named below. Do not repeat or reference sections from the other passes.`;

// Per-call voice reminder. The detailed rules are in the system prompt; this keeps the
// voice tight on every chunk.
function multiCallVoiceReminder(payload) {
  return `Use Dennis Nickens's voice. Plain English. Direct, warm, consultative. No em dashes or en dashes (use commas, periods, parentheses, or rephrase). No AI-sounding phrases ("delve into," "navigate the landscape," "in today's fast-paced world," "tapestry," "embark on a journey"). Use the SR-native CORE vocabulary throughout. Be specific to ${payload.first_name}, reference their actual scores, and address them by first name. Sign off with "Dennis Nickens" not "Dennis,".`;
}

// Call A1: front matter (Cover Page through Executive Summary) plus Sections 1 to 3.
// This is the first half of the old Call A. It is awaited solo to warm the prompt cache
// before A2, B, and C fire in parallel. Front matter weight (about 1,100 words) plus
// Sections 1 to 3 balances against A2, which carries the heavier Section 6.
function buildCallA1Message(payload, scores, partnerData) {
  return `${MULTI_CALL_HEADER}

GENERATE ONLY Sections 1 through 3 of the Blueprint as defined in the system prompt, preceded by the full front matter. This is the FIRST parallel pass. Do not generate any section after Section 3; those are produced separately and stitched in after yours.

Because this is the first chunk, include, in this exact order, BEFORE Section 1:
1. The Cover Page (use the format in the system prompt; substitute the customer's actual first and last name, never the literal text [Client Name], [Their actual first name], or similar placeholders)
2. How Your Blueprint Works
3. How To Read It
4. What This Blueprint Is, And What It Isn't (output verbatim, as defined in the system prompt)
5. Executive Summary

Then generate, in order:
- Section 1: Your Behavior Profile
- Section 2: Your Personality Code
- Section 3: Your Action Style

End your output cleanly after Section 3. Do NOT write Section 4 or anything later. Do NOT add a closing benediction, disclaimer, or any "continue to Section 4" transition.

${multiCallVoiceReminder(payload)}

Customer payload:
${buildCustomerDataBlock(payload, scores, partnerData)}`;
}

// Call A2: Sections 4 to 6 (the second half of the old Call A). No front matter, no
// cover page. Section 6 (Spiritual Wiring, with 6.1 Compass and 6.2 Gifts) is the
// heaviest piece here, which is why front matter went to A1 to keep the two even.
function buildCallA2Message(payload, scores, partnerData) {
  return `${MULTI_CALL_HEADER}

GENERATE ONLY Sections 4 through 6 of the Blueprint as defined in the system prompt. Do NOT regenerate the Cover Page, any front matter, the Executive Summary, or Sections 1 through 3. Do NOT write Section 7 or anything later. Do NOT include a closing benediction or disclaimer.

Begin your output directly at the Section 4 heading. Generate, in order:
- Section 4: Your Connection Currency
- Section 5: Your Learning Channel
- Section 6: Your Spiritual Wiring (open with the unified intro, then Subsection 6.1 Your Spiritual Compass with its scripture verses, then Subsection 6.2 Your Spiritual Gifts ONLY IF Pillar 7 / SPIRITUAL GIFTS data is present in the payload below; if it is absent, end Section 6 after Subsection 6.1, with no placeholder)

End your output cleanly after Section 6. Do NOT write Section 7 or anything later. Do NOT add any "continue to Section 7" transition.

${multiCallVoiceReminder(payload)}

Customer payload:
${buildCustomerDataBlock(payload, scores, partnerData)}`;
}

// Call B: Sections 7 to 11 (Misalignment, Career, Relationship, conditional Parenting/Leadership).
function buildCallBMessage(payload, scores, partnerData) {
  return `${MULTI_CALL_HEADER}

GENERATE ONLY Sections 7 through 11 of the Blueprint as defined in the system prompt. This is the SECOND of three parallel passes. Do NOT regenerate the Cover Page, any front matter, the Executive Summary, or Sections 1 through 6. Do NOT write Section 12 or anything later. Do NOT include a closing benediction or disclaimer.

Begin your output directly at the Section 7 heading. Generate, in order:
- Section 7: Your Misalignment Map (the deepest section; pair every misalignment you name with a concrete "what to do this week" 7-day action step)
- Section 8: Your Career Alignment
- Section 9: Your Relationship Alignment (include the Marriage Dynamics subsection at the END of Section 9 ONLY if Set E marriage answers are present in the payload; skip it entirely otherwise)
- Section 10: Your Parenting Style (Family audience ONLY; skip entirely if the audience is not Family, no placeholder)
- Section 11: Your Leadership Profile (Team or Leadership audience ONLY; skip entirely otherwise, no placeholder)

End cleanly after the last section you generate. Do NOT add any "continue to Section 12" transition.

${multiCallVoiceReminder(payload)}

Customer payload:
${buildCustomerDataBlock(payload, scores, partnerData)}`;
}

// Call C: Sections 12 to 17 plus the closing material. No Section 13 (Gifts live in
// Subsection 6.2, generated in Call A), so the numbering jumps 12 to 14.
function buildCallCMessage(payload, scores, partnerData) {
  const connectionMapInstruction = partnerData
    ? `- Section 17: Your Connection Map (REQUIRED here). partner_data IS present below, so generate the full Connection Map exactly as defined in the master prompt: all seven subsections (Your Pair at a Glance, What Each of You Brings, Where You Align, Where You Speak Different Languages, Your Connection Currency Map, How to Bridge the Gaps, Your 30-60-90 Day Plan) plus the closing line. Render each h4 heading WITHOUT any section number prefix (no 17.1, no 17.2, etc.), just the subsection title text. Write it comparing ${payload.first_name} (the reader, "self") with ${partnerData.first_name} (the partner). Substitute the partner's actual first name into the heading. This is the final Blueprint section.`
    : `- Section 17: Your Connection Map. SKIP entirely. No partner_data is present (this is a Solo Blueprint). Do not mention it or leave a placeholder.`;

  return `${MULTI_CALL_HEADER}

GENERATE ONLY Sections 12 through 17 of the Blueprint as defined in the system prompt, followed by the closing material. This is the THIRD and FINAL of three parallel passes. Do NOT regenerate the Cover Page, any front matter, or Sections 1 through 11.

There is NO Section 13 (Spiritual Gifts live in Subsection 6.2, generated in an earlier pass), so the numbering goes 12, then 14. Begin your output directly at the first section you actually generate. Generate, in order:
- Section 12: Your Ministry Profile (Ministry audience ONLY, i.e. Set F answers present; skip entirely otherwise, no placeholder)
- Section 14: Your Stress Response Map (ALWAYS generate; keep all 5 subsections, do not collapse them)
- Section 15: Your Strategic Recommendations (ALWAYS generate)
- Section 16: Your 30 Day Alignment Plan (ALWAYS generate; every practice needs a specific time/trigger, a duration, and a measurable outcome)
${connectionMapInstruction}

Because this is the final chunk, AFTER the last section above, include the closing material defined in the system prompt, in order: What Is Next, the Important Disclaimer, and the closing benediction.

${multiCallVoiceReminder(payload)}

Customer payload:
${buildCustomerDataBlock(payload, scores, partnerData)}`;
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

async function callClaude(systemPrompt, userMessage, contactId, label, timeoutMs = 90000, maxTokens = 14000) {
  const tag = label ? `chunk ${label}` : 'call';
  if (label) console.log(`[Blueprint] ${tag} start for contact ${contactId}`);

  // Client-side timeout PER CALL, default 90s, overridable via timeoutMs. Multi-call
  // generation runs three chunks; B and C are light and keep the 90s default, but A is
  // the heaviest (front matter plus Sections 1 to 6) and gets 180s from its call site so
  // it does not abort mid-generation. The Vercel function ceiling is 300s (vercel.json
  // maxDuration), and A runs before B and C fire, so 180 + max(B, C) stays under it. We
  // abort at timeoutMs to leave headroom for writing the failure status to GHL.
  const callStartedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let result;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Multi-call generation with Anthropic prompt caching. This function runs three
        // times in parallel, each producing a different range of Blueprint sections. The
        // master prompt (about 15K input tokens) is sent as a cache_control: ephemeral
        // content block, so the first call warms the cache and the other two read it from
        // cache instead of reprocessing it. That caching is what makes three parallel calls
        // safe now (the reverted multi-call attempt tripped a Tier 1 rate limit without it).
        // max_tokens 14000 per call gives one chunk room to reach full depth without the
        // single-call output length that tripped the old 270s timeout.
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });

    // Body read is INSIDE the try and BEFORE clearTimeout, so the per-chunk
    // AbortController still governs it. If the body read is aborted, the catch below
    // translates it to the specific "Claude API client timeout (Xs) on chunk Y" message
    // instead of leaking a generic "This operation was aborted".
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error on ${tag}: ${response.status} ${errText}`);
    }

    result = await response.json();
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' || /aborted/i.test(err?.message || '')) {
      const timeoutSecs = Math.round(timeoutMs / 1000);
      const elapsedSecs = Math.round((Date.now() - callStartedAt) / 1000);
      // An aborted fetch here is EITHER our per-chunk timer firing (elapsed reaches
      // timeoutMs) OR the platform aborting the request before our timer (elapsed is
      // shorter, e.g. the function/waitUntil budget killed the instance). Discriminate by
      // elapsed so the status field names the real cause instead of leaking the generic
      // "This operation was aborted" (raw AbortError message). 2s tolerance for timer slop.
      const chunkTimedOut = (Date.now() - callStartedAt) >= (timeoutMs - 2000);
      const reason = chunkTimedOut
        ? `Claude API client timeout (${timeoutSecs}s) on ${tag}`
        : `function/platform abort (not a chunk timeout) after ${elapsedSecs}s`;
      console.error(`[Blueprint] ${reason}`);
      if (contactId) {
        try {
          console.error("Blueprint generation failed:", err);
          await updateGhlContact(contactId, {
            sr_blueprint_status: `Failed: ${reason}`,
            sr_blueprint_error: reason,
          });
        } catch (updateErr) {
          console.error('[Blueprint] Failed to write timeout status to GHL:', updateErr);
        }
      }
      throw new Error(reason);
    }
    throw err;
  }

  // Per-chunk usage logging so cache hits are verifiable in Vercel logs. On the call that
  // warms the cache, cache_creation_input_tokens is populated; on a warm call,
  // cache_read_input_tokens is.
  console.log(`Blueprint chunk ${label || '?'} usage:`, {
    cache_creation_input_tokens: result.usage?.cache_creation_input_tokens,
    cache_read_input_tokens: result.usage?.cache_read_input_tokens,
    input_tokens: result.usage?.input_tokens,
    output_tokens: result.usage?.output_tokens
  });

  return result.content[0].text;
}

// =======================================================================
// HELPER: CONVERT MARKDOWN TO BRANDED HTML
// =======================================================================
// Uses the `marked` npm library to convert markdown.
// Wraps it in an HTML page with SR brand styling (navy/gold cosmic).

// The master prompt closes with a blockquote: the "I help people understand the
// person in the mirror..." line, then the signoff name and title on the next two
// lines. marked renders those two name/title lines as a single paragraph (a single
// newline collapses to a space, so "Dennis Nickens ... Behavioral and Alignment
// Consultant" runs together on one line). This rebuilds that closing blockquote as a
// centered signoff block: the name in Dancing Script (gold), the title below it in
// Inter (smaller, muted), each on its own line.
function styleClosingSignoff(html) {
  // Anchor on the blockquote that contains the title line. The quote text above it is
  // model-generated and varies, so we capture whatever the first paragraph holds and
  // keep it above the signoff rather than trying to match its exact wording.
  return html.replace(
    /<blockquote>[\s\S]*?Behavioral and Alignment Consultant[\s\S]*?<\/blockquote>/i,
    (block) => {
      const quoteMatch = block.match(/<p>([\s\S]*?)<\/p>/i);
      const quote = quoteMatch
        ? quoteMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()
        : '';
      const quoteHtml = quote ? `<p class="blueprint-signoff-quote">${quote}</p>\n  ` : '';
      return `<div class="blueprint-signoff">
  ${quoteHtml}<span class="blueprint-signoff-name">Dennis Nickens <em>(aka Spiritual Romeo)</em></span>
  <span class="blueprint-signoff-title">Behavioral and Alignment Consultant</span>
</div>`;
    }
  );
}

// Prepends each pillar section heading with its brand icon. Runs on the rendered HTML
// (after marked.parse), NOT on the markdown, so the master prompt and the generated
// markdown are untouched. Icon URLs are absolute (dennisnickens.com) because the
// Blueprint HTML is served from a Vercel Blob subdomain where relative paths would break.
// Lenient matching: any h1-h6 tag, optional attributes (marked may add id anchors), and
// trailing text after the section title. Headings that do not match (e.g. in the Couples
// Map, which has no pillar sections) are passed through unchanged.
// Module-level so buildSidebarNav reads the same list of sections + icons that
// styleSectionIcons uses to render inline anchors. Order is presentation order.
// `sidebar: true` includes the entry in the left navigation rail. `sidebar: false`
// means the entry renders an inline icon at its heading but does NOT appear in the
// nav (subsection anchors like 6.1, Motivational/Manifestation/Fruits subsections).
// `label` is the short text shown in the nav (no "Section N:" prefix, no "Your").
// `anchor` is the id that will be injected just before the matched heading so the
// nav item can scroll to it.
const SECTION_ICON_MAP = [
  { needle: 'Section 1: Your Behavior Profile',    url: 'https://dennisnickens.com/assessment/icons/pillars/01-core.png',     pillar: 'CORE',     label: 'Behavior Profile',         anchor: 'section-1',  sidebar: true },
  { needle: 'Section 2: Your Personality Code',    url: 'https://dennisnickens.com/assessment/icons/pillars/02-lens.png',     pillar: 'LENS',     label: 'Personality Code',         anchor: 'section-2',  sidebar: true },
  { needle: 'Section 3: Your Action Style',        url: 'https://dennisnickens.com/assessment/icons/pillars/03-drive.png',    pillar: 'DRIVE',    label: 'Action Style',             anchor: 'section-3',  sidebar: true },
  { needle: 'Section 4: Your Connection Currency', url: 'https://dennisnickens.com/assessment/icons/pillars/04-currency.png', pillar: 'CURRENCY', label: 'Connection Currency',      anchor: 'section-4',  sidebar: true },
  { needle: 'Section 5: Your Learning Channel',    url: 'https://dennisnickens.com/assessment/icons/pillars/05-channel.png',  pillar: 'CHANNEL',  label: 'Learning Channel',         anchor: 'section-5',  sidebar: true },
  { needle: 'Section 6: Your Spiritual Wiring',    url: 'https://dennisnickens.com/assessment/icons/pillars/06-compass.png',  pillar: 'COMPASS',  label: 'Spiritual Wiring',         anchor: 'section-6',  sidebar: true },
  // Subsection 6.1 anchor (deep violet compass). Inline icon only, not in sidebar.
  { needle: '6.1 Your Spiritual Compass',          url: 'https://dennisnickens.com/assessment/icons/gifts-subsection/spiritual-compass.png', pillar: 'Spiritual Compass',     sidebar: false },
  // Pillar 7 Path B: three subsection anchors. Inline icons only, not in sidebar.
  { needle: 'Your Motivational Gifts',        url: 'https://dennisnickens.com/assessment/icons/gifts-subsection/motivational-gifts.png',   pillar: 'Motivational Gifts',  sidebar: false },
  { needle: 'Your Manifestation Gifts',       url: 'https://dennisnickens.com/assessment/icons/gifts-subsection/manifestation-gifts.png',  pillar: 'Manifestation Gifts', sidebar: false },
  { needle: 'Your Fruits of the Spirit',      url: 'https://dennisnickens.com/assessment/icons/gifts-subsection/fruit-of-the-spirit.png',  pillar: 'Fruits of the Spirit', sidebar: false },
  // Synthesis sections (7 through 16, minus 13 which is unified into Section 6).
  { needle: 'Section 7: Your Misalignment Map',           url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/misalignment-map.png',          pillar: 'Misalignment Map',         label: 'Misalignment Map',         anchor: 'section-7',  sidebar: true },
  { needle: 'Section 8: Your Career Alignment',           url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/career-alignment.png',          pillar: 'Career Alignment',         label: 'Career Alignment',         anchor: 'section-8',  sidebar: true },
  { needle: 'Section 9: Your Relationship Alignment',     url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/relationship-alignment.png',    pillar: 'Relationship Alignment',   label: 'Relationship Alignment',   anchor: 'section-9',  sidebar: true },
  { needle: 'Section 10: Your Parenting Style',           url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/parenting-style.png',           pillar: 'Parenting Style',          label: 'Parenting Style',          anchor: 'section-10', sidebar: true },
  { needle: 'Section 11: Your Leadership Profile',        url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/leadership-profile.png',        pillar: 'Leadership Profile',       label: 'Leadership Profile',       anchor: 'section-11', sidebar: true },
  { needle: 'Section 12: Your Ministry Profile',          url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/ministry-profile.png',          pillar: 'Ministry Profile',         label: 'Ministry Profile',         anchor: 'section-12', sidebar: true },
  { needle: 'Section 14: Your Stress Response Map',       url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/stress-response-map.png',       pillar: 'Stress Response Map',      label: 'Stress Response Map',      anchor: 'section-14', sidebar: true },
  { needle: 'Section 15: Your Strategic Recommendations', url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/strategic-recommendations.png', pillar: 'Strategic Recommendations', label: 'Strategic Recommendations', anchor: 'section-15', sidebar: true },
  // Section 16 needle uses just "Section 16:" because the model sometimes renders the heading
  // as "30-Day Alignment Plan" (with hyphen) and sometimes "30 Day Alignment Plan" (without).
  { needle: 'Section 16:',                                url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/thirty-day-plan.png',           pillar: '30 Day Alignment Plan',    label: '30 Day Plan',              anchor: 'section-16', sidebar: true },
  // Section 17 (Linked Pair Connection Map) reuses the Relationship Alignment icon for now.
  // Couples Map (standalone, mode=couples) has different subsection headings and skips this entry.
  { needle: 'Section 17: Your Connection Map',            url: 'https://dennisnickens.com/assessment/icons/synthesis-sections/relationship-alignment.png',    pillar: 'Connection Map',           label: 'Connection Map',           anchor: 'section-17', sidebar: true },
];

// Builds the left-rail navigation HTML for the Blueprint. Walks SECTION_ICON_MAP and
// for each entry with sidebar:true, looks for the matching heading inside the rendered
// content HTML. If a match is found, injects an empty anchor div with the entry's id
// just before the heading so the nav link can scroll to it, and adds the entry to the
// nav list.
//
// Returns { html, navHtml }. html is the content with anchor divs injected. navHtml is
// the full nav UL ready to drop into the layout. If fewer than two sections matched
// (e.g. the Couples Map, which has no Section X headings), navHtml is the empty string
// so the layout collapses the sidebar entirely.
function buildSidebarNav(html) {
  let out = html;
  const navItems = [];
  for (const entry of SECTION_ICON_MAP) {
    if (!entry.sidebar) continue;
    const escaped = entry.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Detect whether this section actually appears in the rendered HTML.
    const presenceRe = new RegExp(`<h[1-6]\\b[^>]*>[^<]*?${escaped}[^<]*</h[1-6]>`, 'i');
    if (!presenceRe.test(out)) continue;
    // Inject an empty anchor div directly before the matched heading. This avoids any
    // conflict with marked's auto-generated heading ids and gives the nav a stable
    // scroll target regardless of how the model formatted the heading text.
    const injectRe = new RegExp(`(<h[1-6]\\b[^>]*>[^<]*?${escaped}[^<]*</h[1-6]>)`, 'i');
    out = out.replace(injectRe, `<div id="${entry.anchor}" class="section-anchor"></div>\n$1`);
    navItems.push(entry);
  }
  if (navItems.length < 2) {
    return { html: out, navHtml: '' };
  }
  const itemsHtml = navItems.map((e) => `
        <li>
          <a href="#${e.anchor}" data-anchor="${e.anchor}">
            <img src="${e.url}" alt="" class="nav-icon" />
            <span class="nav-label">${e.label}</span>
          </a>
        </li>`).join('');
  const navHtml = `
    <nav class="sidebar-nav" aria-label="Blueprint sections">
      <div class="sidebar-header">Sections</div>
      <ul class="sidebar-list">${itemsHtml}
      </ul>
    </nav>`;
  return { html: out, navHtml };
}

function styleSectionIcons(html) {
  // Absolute URLs: the Blueprint HTML is served from a Vercel Blob subdomain, so a
  // relative path would 404. Icons live at dennisnickens.com/assessment/icons/pillars/.
  const MAP = SECTION_ICON_MAP;
  let out = html;
  for (const { needle, url, pillar } of MAP) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Group 1: the whole heading (re-emitted unchanged). Group 2: the heading level digit.
    const re = new RegExp(`(<h([1-6])\\b[^>]*>[^<]*?${escaped}[^<]*</h\\2>)`, 'i');
    const iconDiv = `<div class="pillar-icon-wrap"><img src="${url}" alt="${pillar} pillar icon"></div>`;
    out = out.replace(re, `${iconDiv}\n$1`);
  }
  return out;
}

// Prepends a small inline icon next to the customer's SPECIFIC sub-archetype name within
// each pillar section's body. Runs AFTER styleSectionIcons (which handles the big per-section
// pillar icons) on the already-rendered HTML, so the master prompt and generated markdown stay
// untouched. Icon URLs are absolute (dennisnickens.com) because the Blueprint HTML is served
// from a Vercel Blob subdomain where relative paths would 404.
//
// Matching contract: for each archetype name, find the FIRST `<strong>...</strong>` block whose
// inner text CONTAINS the name as a whole word (case-insensitive), and inject one <img>
// immediately before that opening <strong>. This catches the prominent identity line however the
// model bolds it: `<strong>The Mastermind</strong>`, `<strong>You are: The Mastermind</strong>`,
// `<strong>As the Mastermind, you...</strong>`, or a full bolded sentence. Only that first mention
// per archetype gets an icon; later mentions stay plain text. Matching is scoped per pillar
// section (CORE names only inside Section 1, LENS only inside Section 2, and so on), which keeps a
// bolded common word (e.g. "Leadership" in the Section 11 Leadership Profile) from pulling an
// unrelated pillar's icon.
//
// CURRENCY note: the Connection Currency pillar names its physical-closeness currency "Contact"
// (the master prompt bans the legacy "Touch" love-language naming), and its icon file is named
// to match: currency-subtypes/contact.png. The Learning Channel pillar is the only place the
// word "Touch" appears, mapping to channel-subtypes/touch.png. The currency and channel icons
// therefore never collide on the same word. Each pillar's dictionary is still
// scoped to its own Section N body, which also keeps common gift words (e.g. "Leadership") from
// grabbing an icon inside an unrelated section.
function styleSubArchetypeIcons(html) {
  const BASE = 'https://dennisnickens.com/assessment/icons';
  // Per-pillar dictionaries for Sections 1-5. `section` is the Blueprint Section number whose
  // body owns the archetype names. Each entry pairs the name as it appears in the copy with its
  // absolute icon URL. Pillar 7 (Section 6) is handled separately via SECTION6_SUBSCOPES below,
  // because its names are scoped to h4 subsections (6.2A/B/C), not to the whole section.
  const PILLARS = [
    {
      section: 1, label: 'CORE',
      entries: [
        { name: 'Commander', url: `${BASE}/core-subtypes/commander.png` },
        { name: 'Organizer', url: `${BASE}/core-subtypes/organizer.png` },
        { name: 'Relator',   url: `${BASE}/core-subtypes/relator.png` },
        { name: 'Energizer', url: `${BASE}/core-subtypes/energizer.png` },
      ],
    },
    {
      section: 2, label: 'LENS',
      entries: [
        { name: 'Operator',       url: `${BASE}/lens-subtypes/operator.png` },
        { name: 'Tactician',      url: `${BASE}/lens-subtypes/tactician.png` },
        { name: 'Host',           url: `${BASE}/lens-subtypes/host.png` },
        { name: 'Performer',      url: `${BASE}/lens-subtypes/performer.png` },
        { name: 'Pioneer',        url: `${BASE}/lens-subtypes/pioneer.png` },
        { name: 'Innovator',      url: `${BASE}/lens-subtypes/innovator.png` },
        { name: 'Mentor',         url: `${BASE}/lens-subtypes/mentor.png` },
        { name: 'Dreamer',        url: `${BASE}/lens-subtypes/dreamer.png` },
        { name: 'Keeper',         url: `${BASE}/lens-subtypes/keeper.png` },
        { name: 'Troubleshooter', url: `${BASE}/lens-subtypes/troubleshooter.png` },
        { name: 'Protector',      url: `${BASE}/lens-subtypes/protector.png` },
        { name: 'Artisan',        url: `${BASE}/lens-subtypes/artisan.png` },
        { name: 'Mastermind',     url: `${BASE}/lens-subtypes/mastermind.png` },
        { name: 'Theorist',       url: `${BASE}/lens-subtypes/theorist.png` },
        { name: 'Seer',           url: `${BASE}/lens-subtypes/seer.png` },
        { name: 'Poet',           url: `${BASE}/lens-subtypes/poet.png` },
      ],
    },
    {
      section: 3, label: 'DRIVE',
      entries: [
        { name: 'Scholar', url: `${BASE}/drive-subtypes/scholar.png` },
        { name: 'Steward', url: `${BASE}/drive-subtypes/steward.png` },
        { name: 'Sparker', url: `${BASE}/drive-subtypes/sparker.png` },
        { name: 'Crafter', url: `${BASE}/drive-subtypes/crafter.png` },
      ],
    },
    {
      section: 4, label: 'CURRENCY',
      entries: [
        { name: 'Spoken',   url: `${BASE}/currency-subtypes/spoken.png` },
        { name: 'Presence', url: `${BASE}/currency-subtypes/presence.png` },
        // "Contact" is the currency name in the copy; contact.png is its icon file.
        { name: 'Contact',  url: `${BASE}/currency-subtypes/contact.png` },
        { name: 'Action',   url: `${BASE}/currency-subtypes/action.png` },
        { name: 'Tokens',   url: `${BASE}/currency-subtypes/tokens.png` },
      ],
    },
    {
      section: 5, label: 'CHANNEL',
      entries: [
        { name: 'Sight', url: `${BASE}/channel-subtypes/sight.png` },
        { name: 'Sound', url: `${BASE}/channel-subtypes/sound.png` },
        { name: 'Word',  url: `${BASE}/channel-subtypes/word.png` },
        { name: 'Touch', url: `${BASE}/channel-subtypes/touch.png` },
      ],
    },
  ];

  // Pillar 7 (Section 6 Subsection 6.2) expands into three h4 subsections, each with its OWN
  // scoped dictionary. Scoping by subsection (not just by Section 6) is what keeps the two
  // overlap pairs from colliding: motivational "Faith"/"Discernment" live ONLY in 6.2A, while
  // manifestation "Gift of Faith"/"Discerning of Spirits" live ONLY in 6.2B. Because the
  // matcher is word-boundary based, a bolded "Gift of Faith" inside 6.2B would otherwise also
  // match the shorter "Faith" entry; keeping the two names in separate subsection scopes makes
  // that impossible (the "Faith" entry never runs inside 6.2B).

  // 6.2A Motivational Gifts (the existing 12, emerald). Unchanged names/URLs.
  const MOTIVATIONAL_ENTRIES = [
    { name: 'Administration', url: `${BASE}/gifts-subtypes/administration.png` },
    { name: 'Discernment',    url: `${BASE}/gifts-subtypes/discernment.png` },
    { name: 'Encouragement',  url: `${BASE}/gifts-subtypes/encouragement.png` },
    { name: 'Evangelism',     url: `${BASE}/gifts-subtypes/evangelism.png` },
    { name: 'Faith',          url: `${BASE}/gifts-subtypes/faith.png` },
    { name: 'Giving',         url: `${BASE}/gifts-subtypes/giving.png` },
    { name: 'Helps',          url: `${BASE}/gifts-subtypes/helps.png` },
    { name: 'Hospitality',    url: `${BASE}/gifts-subtypes/hospitality.png` },
    { name: 'Leadership',     url: `${BASE}/gifts-subtypes/leadership.png` },
    { name: 'Mercy',          url: `${BASE}/gifts-subtypes/mercy.png` },
    { name: 'Shepherding',    url: `${BASE}/gifts-subtypes/shepherding.png` },
    { name: 'Teaching',       url: `${BASE}/gifts-subtypes/teaching.png` },
  ];

  // 6.2B Manifestation Gifts (9, amber). Longer/more-specific overlap phrases listed first as
  // defense-in-depth; the real safeguard is subsection scoping above.
  const MANIFESTATION_ENTRIES = [
    { name: 'Gift of Faith',              url: `${BASE}/manifestation-gifts-subtypes/gift-of-faith.png` },
    { name: 'Discerning of Spirits',      url: `${BASE}/manifestation-gifts-subtypes/discerning-of-spirits.png` },
    { name: 'Word of Wisdom',             url: `${BASE}/manifestation-gifts-subtypes/word-of-wisdom.png` },
    { name: 'Word of Knowledge',          url: `${BASE}/manifestation-gifts-subtypes/word-of-knowledge.png` },
    { name: 'Gifts of Healing',           url: `${BASE}/manifestation-gifts-subtypes/gifts-of-healing.png` },
    { name: 'Working of Miracles',        url: `${BASE}/manifestation-gifts-subtypes/working-of-miracles.png` },
    { name: 'Prophecy',                   url: `${BASE}/manifestation-gifts-subtypes/prophecy.png` },
    { name: 'Different Kinds of Tongues', url: `${BASE}/manifestation-gifts-subtypes/different-kinds-of-tongues.png` },
    { name: 'Interpretation of Tongues',  url: `${BASE}/manifestation-gifts-subtypes/interpretation-of-tongues.png` },
  ];

  // 6.2C Fruits of the Spirit (9, wine red).
  const FRUIT_ENTRIES = [
    { name: 'Love',         url: `${BASE}/fruits-subtypes/love.png` },
    { name: 'Joy',          url: `${BASE}/fruits-subtypes/joy.png` },
    { name: 'Peace',        url: `${BASE}/fruits-subtypes/peace.png` },
    { name: 'Patience',     url: `${BASE}/fruits-subtypes/patience.png` },
    { name: 'Kindness',     url: `${BASE}/fruits-subtypes/kindness.png` },
    { name: 'Goodness',     url: `${BASE}/fruits-subtypes/goodness.png` },
    { name: 'Faithfulness', url: `${BASE}/fruits-subtypes/faithfulness.png` },
    { name: 'Gentleness',   url: `${BASE}/fruits-subtypes/gentleness.png` },
    { name: 'Self-Control', url: `${BASE}/fruits-subtypes/self-control.png` },
  ];

  // Section 6 subsection scopes, in document order. Each runs from its own 6.2x h4 heading to
  // the next subscope's h4 (6.2C runs to the end of the Section 6 segment, i.e. the Section 7
  // boundary). The 6.1 Compass text before 6.2A gets no entries.
  const SECTION6_SUBSCOPES = [
    { needle: 'Your Motivational Gifts',   entries: MOTIVATIONAL_ENTRIES },
    { needle: 'Your Manifestation Gifts',  entries: MANIFESTATION_ENTRIES },
    { needle: 'Your Fruits of the Spirit', entries: FRUIT_ENTRIES },
  ];

  // Build a case-insensitive regex body for a single word by expanding each letter into a
  // [lower UPPER] class, so the name matches in any case without an /i flag clouding the rest of
  // the pattern.
  const ciWord = (word) =>
    word.replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);

  // Inject an inline icon at the matching block whose inner text contains the name as a whole
  // word, for each entry. A match is any `<strong>`, `<h3>`, or `<h4>` element: <strong> catches
  // the bolded identity line, and h3/h4 catch the heading form the model uses for the prominent
  // "### You Are: The X" archetype declarations in Sections 1-3 (and any heading-based Gift label).
  // The `\1` backreference ties the closing tag to whichever opened, and the tempered
  // `(?:(?!</\1>)[\s\S])*?` segments keep the match inside that single element (they never cross
  // its closing tag), so the name must appear within one block.
  //
  // allMatches controls the per-archetype cap. Default (false): first bolded mention only, used in
  // CORE/LENS/DRIVE and Currency/Channel where one archetype owns the section and repeats would be
  // noise. True (the 6.2A/B/C subscopes): EVERY bolded mention gets the icon, so the top-three
  // summary line plus the Primary/Secondary/Tertiary (or per-fruit-tier) callouts each get one.
  //
  // Placement differs by tag. <strong> is inline, so the icon is prepended as a sibling right
  // before it; a single <br> is added afterward by addBreaks so the icon(s) stack on their own line
  // above the bolded text. h3/h4 are block-level, so a sibling before them would float on its own
  // line above the heading; instead the icon is inserted as the FIRST CHILD inside the opening tag
  // (right after its `>`), which keeps it inline with the heading text (no <br>).
  const injectIcons = (segment, entries, allMatches = false) => {
    let out = segment;
    for (const { name, url } of entries) {
      const re = new RegExp(
        `<(strong|h3|h4)\\b[^>]*>(?:(?!</\\1>)[\\s\\S])*?\\b${ciWord(name)}\\b(?:(?!</\\1>)[\\s\\S])*?</\\1>`,
        allMatches ? 'g' : ''
      );
      const img = `<img class="subarchetype-icon-inline" src="${url}" alt="${name} icon">`;
      out = out.replace(re, (match, tag) =>
        tag === 'strong'
          ? `${img}${match}`            // inline tag: sibling before it (addBreaks inserts the <br>)
          : match.replace('>', `>${img}`) // heading: first child, just inside the opening tag
      );
    }
    return out;
  };

  // After all injection, drop a single <br> between a run of inline sub-archetype icons and the
  // <strong> that follows them, so the icon(s) render on their own line above the bolded text
  // instead of squishing inline. Targets ONLY our injected `subarchetype-icon-inline` icons (never
  // the model's own markdown images in 4/5), and never the in-heading icons (those are followed by
  // heading text, not `<strong`). One <br> regardless of how many icons stacked.
  const addBreaks = (s) =>
    s.replace(/((?:<img class="subarchetype-icon-inline"[^>]*>)+)(<strong\b)/g, '$1<br>$2');

  // Section 6 carries three h4 subsections (6.2A/B/C), each with its own dictionary. Split the
  // Section 6 segment at those h4 headings and run each subscope ONLY inside its own subsection,
  // so the Faith / Gift of Faith and Discernment / Discerning of Spirits pairs never collide and
  // amber/wine-red icons cannot leak into the wrong subsection. The 6.1 Compass text before 6.2A
  // gets no entries. Returns the segment unchanged when no 6.2 subsection headings are present.
  const injectSection6 = (seg) => {
    const found = [];
    for (const sub of SECTION6_SUBSCOPES) {
      const esc = sub.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`<h([1-6])\\b[^>]*>[^<]*?${esc}[^<]*</h\\1>`, 'i');
      const mm = re.exec(seg);
      if (mm) found.push({ start: mm.index, entries: sub.entries });
    }
    if (found.length === 0) return seg;
    found.sort((a, b) => a.start - b.start);
    const parts = [seg.slice(0, found[0].start)];
    for (let i = 0; i < found.length; i++) {
      const start = found[i].start;
      const end = i + 1 < found.length ? found[i + 1].start : seg.length;
      // allMatches=true: 6.2A/B/C drop the first-occurrence cap so the top-three summary AND each
      // Primary/Secondary/Tertiary (or per-fruit-tier) callout each get their icon.
      parts.push(injectIcons(seg.slice(start, end), found[i].entries, true));
    }
    return parts.join('');
  };

  // Locate each "Section N:" heading so we can scope each pillar's dictionary to its own body.
  // The solo Blueprint has these headings; the Couples Map does not.
  const sectionRe = /<h([1-6])\b[^>]*>[^<]*?Section\s+(\d+)\s*:[^<]*<\/h\1>/gi;
  const marks = [];
  let m;
  while ((m = sectionRe.exec(html)) !== null) {
    marks.push({ num: parseInt(m[2], 10), start: m.index });
  }

  // Couples Map (or any document without numbered sections): single global pass over Pillars
  // 1-5 plus the motivational gifts (the names the Couples Map can reference). Manifestation and
  // Fruit entries are intentionally NOT applied here: they only belong inside scoped 6.2B/6.2C
  // subsections, and a Couples Map has no such subsections, so running them globally could only
  // mis-attach. "Contact" and "Touch" are different words, so the touch.png entries never collide.
  if (marks.length === 0) {
    let out = html;
    for (const p of PILLARS) out = injectIcons(out, p.entries);
    out = injectIcons(out, MOTIVATIONAL_ENTRIES);
    return addBreaks(out);
  }

  // Solo Blueprint: slice the document at the section headings (contiguous, lossless) and run
  // each pillar's dictionary only inside its own Section body. Everything before Section 1 and
  // any non-pillar section (7-17) passes through untouched.
  const pieces = [html.slice(0, marks[0].start)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    let seg = html.slice(start, end);
    if (marks[i].num === 6) {
      // Section 6 is sub-scoped by its 6.2A/B/C h4 subsections (Pillar 7 Path B).
      seg = injectSection6(seg);
    } else {
      const pillar = PILLARS.find((p) => p.section === marks[i].num);
      if (pillar) seg = injectIcons(seg, pillar.entries);
    }
    pieces.push(seg);
  }
  return addBreaks(pieces.join(''));
}

// Strips stubborn "Section 17.X:", "Section 17:", "17.X." or "17.X " prefixes from
// markdown heading lines. The model sometimes prepends these to Couples Map subsection
// titles even when the prompt forbids it. Runs only on heading lines (#, ##, ###, ####)
// so body text that references "Section 17.4" (etc.) remains intact.
function stripSectionNumberPrefixes(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return markdown;
  return markdown.replace(/^(#{1,6})\s+(.*)$/gm, (full, hashes, rest) => {
    let title = rest;
    // "Section 17.4: Your Pair at a Glance" or "Section 17: Your Pair at a Glance"
    title = title.replace(/^Section\s+17(?:\.\d+)?\s*[:.\-]\s*/i, '');
    // "17.4 Your Pair at a Glance" or "17.4: Your Pair at a Glance" or "17.4. ..."
    title = title.replace(/^17\.\d+\s*[:.\-]?\s+/, '');
    // "Section 17 - Your Pair at a Glance"
    title = title.replace(/^Section\s+17\s*[\-]\s*/i, '');
    return `${hashes} ${title}`.replace(/\s+$/, '');
  });
}

// Strips internal question-code citations like "(Q-C8 from both)", "(per Q-A7)",
// "Q-D1 and Q-D4", "Q-H7", from customer-facing prose. The master prompt uses these
// codes internally to point the model at specific question answers, but the customer
// has no map back from a code to a question, so they read as meaningless noise.
// The model still slips these into output despite the writing rule. This sweep cleans
// them up before HTML rendering.
function stripQuestionCodeCitations(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return markdown;
  let out = markdown;
  // Parenthetical wrappers: "(Q-C8)", "(Q-C8 from both)", "(per Q-A7)", "(Q-D1 and Q-D4)",
  // "(see Q-H7)", "(from Q-E3)". Match an open paren containing at least one Q-XN and
  // any short connecting words, no nested parens.
  out = out.replace(/\s*\(\s*(?:(?:per|see|from|via|cf\.?|cf|ref|refs?\.?)\s+)?Q-[A-I]\d+(?:\s*(?:and|,|&|\+|\/|\\|to|through)\s*Q-[A-I]\d+)*(?:\s+(?:from\s+(?:both|him|her|each|them|themselves))?)?\s*\)/gi, '');
  // Bare inline runs: "Q-D1 and Q-D4 indicate", "from Q-A7", "Q-H7,". Drop the codes
  // but keep surrounding prose intact by removing the codes plus immediately attached
  // connector words ("and Q-X", ", Q-X").
  out = out.replace(/\bQ-[A-I]\d+(?:\s*(?:and|,|&|\+|\/|to|through)\s*Q-[A-I]\d+)*/g, '');
  // Tidy double spaces or stray " ," / " ." left behind by the strips above.
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  out = out.replace(/\(\s*\)/g, '');
  return out;
}

// Wraps the "Your Blueprint at a Glance" h3 (plus its content up to the next h2/h3) in
// a card div. The card gets distinct styling so the executive summary stands out from the
// rest of the document. Match is lenient (h2 or h3, case-insensitive, optional Section
// number) so model output variations still get caught.
function wrapAtAGlanceCard(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  // Find the opening heading.
  const startRe = /<h([23])\b[^>]*>\s*(?:Your\s+)?(?:Blueprint\s+)?At\s+a\s+Glance[^<]*<\/h\1>/i;
  const startMatch = html.match(startRe);
  if (!startMatch) return html;
  const startIdx = startMatch.index;
  // Find where the card ends: the next h2 or h3 that comes AFTER the opening heading.
  const after = html.slice(startIdx + startMatch[0].length);
  const endRe = /<h[23]\b/i;
  const endLocalMatch = after.match(endRe);
  const endIdx = endLocalMatch ? (startIdx + startMatch[0].length + endLocalMatch.index) : html.length;
  const block = html.slice(startIdx, endIdx);
  const before = html.slice(0, startIdx);
  const afterBlock = html.slice(endIdx);
  return `${before}<section class="at-a-glance-card">${block}</section>${afterBlock}`;
}

// Replaces <!-- SCORE_BAR pillar="X" labels="A|B|C" values="1|2|3" letters="X|Y|Z" -->
// markers with inline SVG horizontal bar charts. The chart shows the customer's score
// breakdown for a pillar (e.g. CORE: Commander 13%, Organizer 25%, Relator 34%, Energizer
// 28%) as colored bars sized to their percentage. Color-coded to match the pillar palette.
function renderScoreBars(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  // Pillar accent colors that match the existing Pillar icon palette.
  const COLORS = {
    CORE: '#d4a957',      // gold
    LENS: '#c8c8d0',      // platinum
    DRIVE: '#a67039',     // bronze
    CURRENCY: '#d99a8a',  // rose gold
    CHANNEL: '#7a92b8',   // steel blue
    COMPASS: '#7a4ea3',   // deep violet
    GIFTS: '#3f9b6c',     // emerald
  };
  return html.replace(
    /<!--\s*SCORE_BAR\s+pillar="([^"]+)"\s+labels="([^"]+)"\s+values="([^"]+)"\s+letters="([^"]*)"\s*-->/g,
    (_, pillar, labelsStr, valuesStr, lettersStr) => {
      const labels = labelsStr.split('|').map(s => s.trim());
      const values = valuesStr.split('|').map(s => parseFloat(s) || 0);
      const letters = lettersStr ? lettersStr.split('|').map(s => s.trim()) : labels.map(() => '');
      const color = COLORS[pillar.toUpperCase()] || '#d4a957';
      // Find the max value so we can scale bars to a consistent width.
      const maxVal = Math.max(...values, 1);
      const rows = labels.map((label, i) => {
        const val = values[i];
        const widthPct = Math.round((val / 100) * 100); // values are already percentages
        const letter = letters[i] || '';
        return `
        <div class="sb-row">
          <div class="sb-letter">${letter}</div>
          <div class="sb-label">${label}</div>
          <div class="sb-track"><div class="sb-fill" style="width:${widthPct}%;background:${color};"></div></div>
          <div class="sb-value">${val.toFixed(1)}%</div>
        </div>`;
      }).join('');
      return `<div class="score-bar-chart" data-pillar="${pillar}">${rows}\n      </div>`;
    }
  );
}

function markdownToBrandedHtml(markdown, payload) {
  // Lazy require to avoid import in handler boot
  const { marked } = require('marked');
  // Pre-process pass 1: strip stubborn "Section 17.X:", "17.X.", "17.X " prefixes the
  // model keeps attaching to Couples Map subsection headings even though the master
  // prompt tells it not to.
  // Pre-process pass 2: strip internal question-code citations like "(Q-C8 from both)",
  // "(Q-A7)", "Q-D1 and Q-D4 indicate" that the model leaks into customer-facing prose.
  // Runs on the raw markdown so the cleaned content flows through marked + the icon
  // stylers unchanged.
  const cleanedMarkdown = stripQuestionCodeCitations(stripSectionNumberPrefixes(markdown));
  // Post-process pass: wrap "Your Blueprint at a Glance" in a card div, render score-bar
  // markers as inline SVG bar charts, and chain through the existing icon stylers.
  const styledHtml = renderScoreBars(wrapAtAGlanceCard(
    styleSubArchetypeIcons(styleSectionIcons(styleClosingSignoff(marked.parse(cleanedMarkdown))))
  ));
  // Sidebar nav for jumping between sections. Empty navHtml means the layout collapses
  // back to single-column (e.g. for the Couples Map, which has no Section N headings).
  const { html: innerHtml, navHtml } = buildSidebarNav(styledHtml);
  const hasSidebar = navHtml.length > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${payload.first_name || 'Your'} Alignment Blueprint | Spiritual Romeo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Allura&family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=Dancing+Script:wght@700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    body {
      font-family: 'Inter', sans-serif;
      margin: 0;
      padding: 0;
      background: linear-gradient(180deg, #07071a 0%, #0f0a2e 50%, #07071a 100%);
      color: #f5f1e8;
      line-height: 1.7;
      min-height: 100vh;
    }
    /* Sidebar layout. With sidebar: flex layout with fixed-width nav rail and centered
       main content. Without sidebar (Couples Map, fallback): main content centers normally. */
    body.has-sidebar {
      display: flex;
      align-items: flex-start;
    }
    .main-content {
      max-width: 820px;
      margin: 0 auto;
      width: 100%;
      flex: 1;
      min-width: 0;
    }
    .content-wrap {
      padding: 3rem 2rem;
    }
    .section-anchor {
      /* Negative top margin offsets the sticky positioning so anchored sections
         scroll into view with breathing room above. */
      scroll-margin-top: 1rem;
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
    /* PILLAR SECTION ICONS */
    .pillar-icon-wrap {
      text-align: center;
      margin: 4rem 0 0.75rem 0;
      page-break-inside: avoid;
    }
    .pillar-icon-wrap img {
      display: inline-block;
      width: 160px;
      height: 160px;
      object-fit: contain;
      opacity: 0.95;
      filter: drop-shadow(0 4px 24px rgba(212, 169, 87, 0.18));
    }
    /* Heading immediately following a pillar icon centers and breathes. Magazine-style entry. */
    .pillar-icon-wrap + h2,
    .pillar-icon-wrap + h3 {
      text-align: center;
      margin-top: 0.5rem;
      margin-bottom: 1.25rem;
      font-family: 'Playfair Display', serif;
      font-size: 2.4rem;
      letter-spacing: -0.01em;
    }
    /* Drop caps on the first paragraph after a Pillar section heading. */
    .pillar-icon-wrap + h2 + p::first-letter,
    .pillar-icon-wrap + h3 + p::first-letter {
      font-family: 'Playfair Display', serif;
      float: left;
      font-size: 4.5rem;
      line-height: 0.9;
      padding: 0.45rem 0.6rem 0 0;
      color: #d4a957;
      font-weight: 700;
    }
    /* ====================================================================
       LEANING CELL FORMAT
       Tables in the Personality Code section put a single letter on top
       (gold, centered) above the leaning word (e.g. W / Inward, T / Tangible).
       The model emits cells as <strong>W</strong><br>Inward; CSS centers them
       and styles the letter as a small gold heading.
       ==================================================================== */
    td:has(> strong + br) {
      text-align: center;
      vertical-align: middle;
    }
    td:has(> strong + br) strong {
      display: block;
      color: #d4a957;
      font-family: 'Playfair Display', serif;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      margin-bottom: 0.35rem;
    }
    /* ====================================================================
       AT A GLANCE CARD
       The TL;DR card directly after the cover page. Dense, premium, the
       90-second read for skimmers. Dark within dark, gold border, clear
       internal hierarchy.
       ==================================================================== */
    .at-a-glance-card {
      background: linear-gradient(180deg, rgba(15, 10, 46, 0.65) 0%, rgba(7, 7, 26, 0.7) 100%);
      border: 1px solid rgba(212, 169, 87, 0.45);
      border-radius: 8px;
      padding: 2rem 2.25rem 1.5rem;
      margin: 2.5rem 0 3rem;
      box-shadow: 0 8px 36px rgba(0, 0, 0, 0.35);
      page-break-inside: avoid;
    }
    .at-a-glance-card h2,
    .at-a-glance-card h3 {
      font-family: 'Playfair Display', serif;
      color: #f5f1e8;
      font-size: 1.5rem;
      text-align: center;
      letter-spacing: 0.02em;
      margin-top: 0;
      margin-bottom: 0.25rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid rgba(212, 169, 87, 0.3);
    }
    .at-a-glance-card h4 {
      font-family: 'Cormorant Garamond', serif;
      color: #d4a957;
      font-size: 0.85rem;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      margin: 1.25rem 0 0.5rem;
      font-weight: 600;
    }
    .at-a-glance-card ol {
      margin: 0;
      padding-left: 1.4rem;
    }
    .at-a-glance-card ol li {
      margin-bottom: 0.45rem;
      line-height: 1.55;
    }
    .at-a-glance-card ol li strong {
      color: #f5f1e8;
    }
    .at-a-glance-card p {
      margin: 0.5rem 0;
      line-height: 1.6;
    }
    .at-a-glance-card p strong {
      color: #d4a957;
    }
    /* ====================================================================
       SCORE BAR CHART
       Renders the customer's pillar percentage breakdown as inline horizontal
       bars. Color-coded per pillar (gold for CORE, steel blue for CHANNEL, etc.).
       ==================================================================== */
    .score-bar-chart {
      margin: 1.5rem 0 2rem;
      padding: 1.25rem 1.5rem;
      background: rgba(7, 7, 26, 0.4);
      border-left: 3px solid #d4a957;
      border-radius: 4px;
      font-family: 'Inter', sans-serif;
      page-break-inside: avoid;
    }
    .sb-row {
      display: grid;
      grid-template-columns: 28px 1fr 3fr 60px;
      align-items: center;
      gap: 0.85rem;
      margin: 0.45rem 0;
    }
    .sb-letter {
      font-family: 'Playfair Display', serif;
      color: #d4a957;
      font-weight: 700;
      font-size: 1.05rem;
      text-align: center;
    }
    .sb-label {
      color: rgba(245, 241, 232, 0.85);
      font-size: 0.95rem;
      font-weight: 500;
    }
    .sb-track {
      height: 12px;
      background: rgba(212, 169, 87, 0.12);
      border-radius: 6px;
      overflow: hidden;
      position: relative;
    }
    .sb-fill {
      height: 100%;
      border-radius: 6px;
      transition: width 0.4s ease;
      box-shadow: 0 0 12px rgba(212, 169, 87, 0.18);
    }
    .sb-value {
      color: #f5f1e8;
      font-size: 0.9rem;
      font-weight: 600;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    @media (max-width: 640px) {
      .sb-row {
        grid-template-columns: 24px 1fr 2fr 52px;
        gap: 0.5rem;
      }
      .sb-label {
        font-size: 0.85rem;
      }
    }
    /* INLINE SUB-ARCHETYPE ICONS (next to the customer's specific archetype name) */
    .subarchetype-icon-inline {
      display: inline-block;
      vertical-align: middle;
      height: 48px;
      width: 48px;
      margin-right: 0.5rem;
      object-fit: contain;
      opacity: 0.95;
    }
    /* CLOSING SIGNOFF */
    .blueprint-signoff {
      text-align: center;
      margin: 3rem 0 1.5rem 0;
      padding: 2rem 1rem;
    }
    .blueprint-signoff-quote {
      font-family: 'Cormorant Garamond', serif;
      font-style: italic;
      font-size: 1.25rem;
      color: #e5c170;
      max-width: 560px;
      margin: 0 auto 1.75rem auto;
      line-height: 1.6;
    }
    .blueprint-signoff-name {
      font-family: 'Dancing Script', cursive;
      font-weight: 700;
      font-size: 2.5rem;
      color: #c9a84c;
      line-height: 1.2;
      margin: 0 0 0.5rem 0;
      display: block;
    }
    .blueprint-signoff-name em {
      font-style: normal;
      color: #c9a84c;
    }
    .blueprint-signoff-title {
      font-family: 'Inter', sans-serif;
      font-weight: 400;
      font-size: 1rem;
      color: rgba(255, 255, 255, 0.7);
      letter-spacing: 1px;
      text-transform: none;
      display: block;
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
    /* ====================================================================
       SIDEBAR NAVIGATION
       ==================================================================== */
    .sidebar-nav {
      width: 260px;
      flex-shrink: 0;
      background: rgba(7, 7, 26, 0.85);
      border-right: 1px solid rgba(212, 169, 87, 0.25);
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      padding: 2rem 0;
      box-sizing: border-box;
      z-index: 50;
    }
    .sidebar-header {
      font-family: 'Cormorant Garamond', serif;
      font-size: 0.8rem;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      color: #d4a957;
      text-align: center;
      padding: 0 1.25rem 1rem;
      border-bottom: 1px solid rgba(212, 169, 87, 0.2);
      margin-bottom: 1rem;
    }
    .sidebar-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .sidebar-list li {
      margin: 0;
    }
    .sidebar-list a {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.75rem 1.25rem;
      color: rgba(245, 241, 232, 0.78);
      text-decoration: none;
      font-size: 0.92rem;
      font-weight: 500;
      transition: background 0.18s ease, color 0.18s ease;
      border-left: 3px solid transparent;
    }
    .sidebar-list a:hover {
      background: rgba(212, 169, 87, 0.08);
      color: #f5f1e8;
    }
    .sidebar-list a.active {
      background: rgba(212, 169, 87, 0.12);
      color: #f5f1e8;
      border-left-color: #d4a957;
    }
    .nav-icon {
      width: 28px;
      height: 28px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .nav-label {
      flex: 1;
      line-height: 1.3;
    }
    /* Hamburger button shown only on narrow screens. */
    .nav-toggle {
      display: none;
      position: fixed;
      top: 1rem;
      right: 1rem;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #07071a;
      border: 1px solid #d4a957;
      color: #d4a957;
      font-size: 1.4rem;
      cursor: pointer;
      z-index: 60;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
      align-items: center;
      justify-content: center;
    }
    .nav-toggle:hover {
      background: #0f0a2e;
    }
    /* Backdrop behind the drawer on mobile. */
    .nav-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 45;
    }
    /* ==== Responsive: narrow screens convert sidebar to slide-in drawer ==== */
    @media (max-width: 1099px) {
      body.has-sidebar {
        display: block;
      }
      .sidebar-nav {
        position: fixed;
        left: 0;
        top: 0;
        height: 100vh;
        transform: translateX(-100%);
        transition: transform 0.28s ease;
      }
      .sidebar-nav.open {
        transform: translateX(0);
      }
      .nav-toggle {
        display: flex;
      }
      .nav-backdrop.show {
        display: block;
      }
    }
    /* ====================================================================
       DOWNLOAD PDF BUTTON
       Floating top-right button that triggers the browser print dialog
       with a pre-set filename ("FirstName_LastName_Blueprint_YYYY-MM-DD").
       Customer picks "Save as PDF" in the print dialog and the suggested
       filename matches what they expect. Hidden in print so it does not
       end up inside the PDF itself.
       ==================================================================== */
    .pdf-download-btn {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 70;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.65rem 1.1rem;
      background: linear-gradient(180deg, #1b1640 0%, #07071a 100%);
      border: 1px solid #d4a957;
      border-radius: 28px;
      color: #d4a957;
      font-family: 'Inter', sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      text-decoration: none;
      transition: background 0.18s ease, transform 0.18s ease;
    }
    .pdf-download-btn:hover {
      background: linear-gradient(180deg, #2a2055 0%, #0f0a2e 100%);
      transform: translateY(-1px);
    }
    .pdf-download-btn .pdf-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    /* When the sidebar is present, the nav-toggle sits at top-right on mobile.
       Push the download button left so they don't overlap. */
    @media (max-width: 1099px) {
      body.has-sidebar .pdf-download-btn {
        right: 4rem;
      }
    }
    /* PDF / print page setup: thin margins, no background gradient (saves ink), keep
       deep navy panels for premium look on print. */
    @page {
      size: Letter;
      margin: 0.5in 0.4in 0.5in 0.4in;
    }
    /* Print: hide nav and the download button itself, expand main content. */
    @media print {
      .sidebar-nav, .nav-toggle, .nav-backdrop, .pdf-download-btn {
        display: none !important;
      }
      body.has-sidebar {
        display: block;
      }
      .main-content {
        max-width: none;
      }
      /* Soften the dark gradient for ink-saving while keeping brand-recognizable. */
      body {
        background: #0f0a2e !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body${hasSidebar ? ' class="has-sidebar"' : ''}>
  <button class="pdf-download-btn" id="pdf-download-btn" aria-label="Download Blueprint as PDF">
    <svg class="pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    Download PDF
  </button>
  ${hasSidebar ? `<button class="nav-toggle" id="nav-toggle" aria-label="Open sections" aria-expanded="false">&#9776;</button>
  <div class="nav-backdrop" id="nav-backdrop"></div>
  ${navHtml}` : ''}
  <main class="main-content">
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
        Generated for ${payload.first_name || 'this customer'} ${payload.last_name || ''} on ${new Date().toLocaleDateString()}<br/>
        Spiritual Romeo &middot; Behavioral and Alignment Consulting<br/>
        dennisnickens.com
      </div>
    </div>
  </main>
  ${hasSidebar ? `<script>
(function(){
  var sidebar = document.querySelector('.sidebar-nav');
  var toggle = document.getElementById('nav-toggle');
  var backdrop = document.getElementById('nav-backdrop');
  if (!sidebar || !toggle || !backdrop) return;
  function openDrawer(){ sidebar.classList.add('open'); backdrop.classList.add('show'); toggle.setAttribute('aria-expanded','true'); }
  function closeDrawer(){ sidebar.classList.remove('open'); backdrop.classList.remove('show'); toggle.setAttribute('aria-expanded','false'); }
  toggle.addEventListener('click', function(){
    if (sidebar.classList.contains('open')) closeDrawer(); else openDrawer();
  });
  backdrop.addEventListener('click', closeDrawer);
  // Smooth scroll on link click + close drawer on mobile after navigation.
  var links = sidebar.querySelectorAll('a[data-anchor]');
  links.forEach(function(link){
    link.addEventListener('click', function(e){
      var anchor = link.getAttribute('data-anchor');
      var target = document.getElementById(anchor);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Update URL hash without jumping.
        history.pushState(null, '', '#' + anchor);
        closeDrawer();
      }
    });
  });
  // Active-state tracking via IntersectionObserver. Highlights the section the
  // reader is currently in. Falls back gracefully if the observer is unsupported.
  if ('IntersectionObserver' in window) {
    var byAnchor = {};
    links.forEach(function(link){ byAnchor[link.getAttribute('data-anchor')] = link; });
    var anchors = document.querySelectorAll('.section-anchor');
    var observer = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        var id = entry.target.id;
        var link = byAnchor[id];
        if (!link) return;
        if (entry.isIntersecting) {
          links.forEach(function(l){ l.classList.remove('active'); });
          link.classList.add('active');
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    anchors.forEach(function(a){ observer.observe(a); });
  }
})();
</script>` : ''}
<script>
// PDF download button. Click sets the document title to a structured filename
// (FirstName_LastName_Blueprint_YYYY-MM-DD) so the browser's "Save as PDF" dialog
// suggests that filename. After the print dialog closes, the title is restored.
(function(){
  var btn = document.getElementById('pdf-download-btn');
  if (!btn) return;
  function sanitize(s) {
    return (s || '').toString().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }
  var firstName = sanitize(${JSON.stringify(payload.first_name || 'Your')});
  var lastName = sanitize(${JSON.stringify(payload.last_name || '')});
  var originalTitle = document.title;
  function restoreTitle(){ document.title = originalTitle; }
  btn.addEventListener('click', function(){
    var d = new Date();
    var pad = function(n){ return n < 10 ? '0' + n : '' + n; };
    var ymd = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    var nameJoin = firstName + (lastName ? '_' + lastName : '');
    var filename = (nameJoin || 'Your') + '_Blueprint_' + ymd;
    document.title = filename;
    setTimeout(function(){ window.print(); }, 50);
    // Restore title after the print dialog closes. afterprint is the modern way;
    // setTimeout is a safety net for browsers that don't fire afterprint reliably.
    setTimeout(restoreTitle, 4000);
  });
  window.addEventListener('afterprint', restoreTitle);
})();
</script>
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
