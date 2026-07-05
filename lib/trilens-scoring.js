// /lib/trilens-scoring.js
// Deterministic scoring engine for the in-house TriLens question bank.
// Ported from the validated scoringEngine.service.js (Postgres scaffold),
// adapted for serverless: pure functions, no database, answers passed in.
//
// Input answer format (from /api/sr-assessment-submit):
//   { core_q1: {a:1,b:3,c:2,d:4}, currency_q1: {a:2,b:1,c:5,d:3,e:4}, ... }
//   rank 1 = most like the respondent.
//
// Points: rank r among n options scores (n - r + 1). Rank 1 of 4 = 4 pts.
//
// Type keys follow the SR Pillar Naming Canon (see
// Strategy/TRILENS-TAXONOMY-RECONCILIATION.md). Lineage note: the CORE
// blend archetype lookup uses internal D/I/S/C dimension letters per the
// canon (commander=D, energizer=I, relator=S, organizer=C). Those letters
// never surface in customer output.

'use strict';

const PILLAR_TYPES = {
  core: ['commander', 'relator', 'organizer', 'energizer'],
  currency: ['spoken', 'action', 'tokens', 'presence', 'contact'],
  channel: ['sight', 'sound', 'word', 'touch'],
  compass: ['faith', 'family', 'career', 'community'],
  partnership: ['initiator', 'responder', 'balancer', 'adapter'],
  family: ['nurturer', 'provider', 'peacemaker', 'director'],
  career: ['visionary', 'executor', 'collaborator', 'specialist'],
  ministry: ['teacher', 'encourager', 'giver', 'leader'],
};

const PILLAR_ORDER = ['core', 'currency', 'channel', 'compass', 'partnership', 'family', 'career', 'ministry'];

const PILLAR_QUESTION_COUNTS = {
  core: 22, currency: 18, channel: 18, compass: 20,
  partnership: 24, family: 24, career: 24, ministry: 20,
};

// Tier totals. Medium is 78 (22 core + 18 currency + 18 channel + 20
// compass). The scaffold's value of 58 was a bug; fixed here.
const TIER_QUESTION_COUNTS = { light: 22, medium: 78, deep: 170 };

const TIER_PILLARS = {
  light: ['core'],
  medium: ['core', 'currency', 'channel', 'compass'],
  deep: PILLAR_ORDER,
};

// SR lettering system (locked July 2026). Letters exist for the four
// Blueprint pillars only; Dynamics pillars use full type names.
// The SR Code is the 4-letter signature, e.g. C-S-W-F.
const TYPE_LETTERS = {
  core: { commander: 'C', relator: 'R', organizer: 'O', energizer: 'E' },
  currency: { spoken: 'S', action: 'A', tokens: 'K', presence: 'P', contact: 'T' },
  channel: { sight: 'G', sound: 'U', word: 'W', touch: 'H' },
  compass: { faith: 'F', family: 'M', career: 'V', community: 'Y' },
};

// Internal dimension letters for the CORE blend archetype lookup (canon
// lineage mapping; internal only, never customer-facing).
const CORE_TO_DIMENSION = { commander: 'D', energizer: 'I', relator: 'S', organizer: 'C' };

// The 16 SR Behavior Archetypes (canon, locked May 2026).
const PURE_ARCHETYPES = {
  commander: 'The Commander',
  organizer: 'The Organizer',
  relator: 'The Relator',
  energizer: 'The Energizer',
};

const BLEND_ARCHETYPES = {
  DI: 'The Visionary',
  DS: 'The Anchor',
  DC: 'The Strategist',
  ID: 'The Champion',
  IS: 'The Connector',
  IC: 'The Storyteller',
  SD: 'The Sentinel',
  SI: 'The Diplomat',
  SC: 'The Caretaker',
  CD: 'The Master Builder',
  CI: 'The Curator',
  CS: 'The Sage',
};

// ---------------------------------------------------------------
// Per-pillar scoring
// ---------------------------------------------------------------

function scorePillar(pillar, pillarAnswers, questionTypeMaps) {
  const types = PILLAR_TYPES[pillar];
  if (!types) throw new Error('unknown_pillar:' + pillar);

  const raw = {};
  for (const t of types) raw[t] = 0;

  const rank1Counts = {};
  let answered = 0;

  for (const [qid, ranks] of Object.entries(pillarAnswers)) {
    const typeMap = questionTypeMaps[qid];
    if (!typeMap) continue;
    const numOptions = Object.keys(ranks).length;
    let valid = true;
    const seen = new Set();
    for (const r of Object.values(ranks)) {
      if (typeof r !== 'number' || r < 1 || r > numOptions || seen.has(r)) { valid = false; break; }
      seen.add(r);
    }
    if (!valid || seen.size !== numOptions) continue;

    answered++;
    for (const [opt, rank] of Object.entries(ranks)) {
      const type = typeMap[opt];
      if (type && type in raw) raw[type] += numOptions - rank + 1;
      if (rank === 1) rank1Counts[opt] = (rank1Counts[opt] || 0) + 1;
    }
  }

  const totalPoints = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const percentages = {};
  for (const t of types) percentages[t] = Math.round((raw[t] / totalPoints) * 1000) / 10;

  const sorted = Object.entries(percentages).sort(([, a], [, b]) => b - a);
  const primaryType = sorted[0][0];
  const secondaryType = sorted.length > 1 ? sorted[1][0] : null;

  // Validation flags (ported from the validated engine, all-option
  // straight-lining detection included).
  const flags = [];
  const expected = PILLAR_QUESTION_COUNTS[pillar] || 0;
  if (expected && answered < Math.ceil(expected * 0.8)) {
    flags.push({ flag: 'incomplete', level: 'yellow', answered, expected });
  }
  if (answered >= 5) {
    const maxTops = Math.max(0, ...Object.values(rank1Counts));
    const ratio = maxTops / answered;
    if (ratio >= 0.9) {
      const dominantOption = Object.entries(rank1Counts).sort((a, b) => b[1] - a[1])[0][0];
      flags.push({ flag: 'straight_lining', level: 'yellow', ratio: Math.round(ratio * 100) / 100, dominantOption });
    }
  }

  return { pillar, answered, raw, percentages, primaryType, secondaryType, flags };
}

// ---------------------------------------------------------------
// Archetype from the CORE blend (canonical rule)
// ---------------------------------------------------------------

function determineArchetype(corePercentages) {
  const sorted = Object.entries(corePercentages).sort(([, a], [, b]) => b - a);
  const [topType, topPct] = sorted[0];
  const [secondType, secondPct] = sorted[1];

  // Pure Type when the leader is more than 1.5x the runner-up.
  if (secondPct === 0 || topPct > secondPct * 1.5) {
    return PURE_ARCHETYPES[topType];
  }
  const key = CORE_TO_DIMENSION[topType] + CORE_TO_DIMENSION[secondType];
  return BLEND_ARCHETYPES[key] || PURE_ARCHETYPES[topType];
}

// ---------------------------------------------------------------
// SR Code: the 4-letter signature across the Blueprint pillars,
// e.g. C-S-W-F = Commander, Spoken, Word, Faith. Pillars the tier
// did not measure are skipped, so a Light code is just "C".
// ---------------------------------------------------------------

function buildSrCode(scoresByPillar) {
  const parts = [];
  for (const pillar of ['core', 'currency', 'channel', 'compass']) {
    const s = scoresByPillar[pillar];
    if (!s) continue;
    const letter = TYPE_LETTERS[pillar][s.primaryType];
    if (letter) parts.push(letter);
  }
  return parts.join('-');
}

// ---------------------------------------------------------------
// Dual Profile: the within-pillar blend. Same 1.5x rule as the
// Behavior Archetype: a runaway primary is a Pure Profile, a close
// top two is a Dual Profile shown as "C+R" (lettered pillars) or
// "Initiator + Balancer" (Dynamics pillars).
// ---------------------------------------------------------------

function buildDualProfile(pillar, percentages) {
  const sorted = Object.entries(percentages).sort(([, a], [, b]) => b - a);
  const [primary, pPct] = sorted[0];
  const [secondary, sPct] = sorted.length > 1 ? sorted[1] : [null, 0];
  const letters = TYPE_LETTERS[pillar];
  const label = t => letters ? (letters[t] || '?') : (t.charAt(0).toUpperCase() + t.slice(1));
  const joiner = letters ? '+' : ' + ';

  if (!secondary || sPct === 0 || pPct > sPct * 1.5) {
    return { kind: 'pure', primary, secondary, code: label(primary), display: 'Pure Profile: ' + label(primary) };
  }
  return {
    kind: 'dual', primary, secondary,
    code: label(primary) + joiner + label(secondary),
    display: 'Dual Profile: ' + label(primary) + joiner + label(secondary),
  };
}

// ---------------------------------------------------------------
// Session-level scoring
// ---------------------------------------------------------------

function scoreSession(tier, answers, bank) {
  const pillars = TIER_PILLARS[tier] || TIER_PILLARS.light;

  // Group answers by pillar using the question id prefix, and build
  // typeMapping lookups from the served question bank so scoring always
  // matches what the customer actually answered.
  const byPillar = {};
  const typeMaps = {};
  for (const pillar of pillars) {
    byPillar[pillar] = {};
    for (const q of (bank.pillars[pillar] || [])) typeMaps[q.id] = q.typeMapping;
  }
  for (const [qid, ranks] of Object.entries(answers)) {
    const pillar = qid.split('_')[0];
    if (byPillar[pillar]) byPillar[pillar][qid] = ranks;
  }

  const scores = {};
  for (const pillar of pillars) {
    scores[pillar] = scorePillar(pillar, byPillar[pillar], typeMaps);
    scores[pillar].dualProfile = buildDualProfile(pillar, scores[pillar].percentages);
  }

  const archetype = scores.core ? determineArchetype(scores.core.percentages) : null;
  const srCode = buildSrCode(scores);

  const totalAnswered = Object.values(scores).reduce((a, s) => a + s.answered, 0);
  const expectedTotal = TIER_QUESTION_COUNTS[tier] || TIER_QUESTION_COUNTS.light;

  return {
    tier,
    scores,
    archetype,
    srCode,
    totalAnswered,
    expectedTotal,
    engineVersion: parseInt(process.env.CURRENT_ENGINE_VERSION) || 1,
  };
}

module.exports = {
  scoreSession,
  scorePillar,
  determineArchetype,
  buildSrCode,
  buildDualProfile,
  TYPE_LETTERS,
  PILLAR_TYPES,
  PILLAR_ORDER,
  TIER_PILLARS,
  TIER_QUESTION_COUNTS,
  PURE_ARCHETYPES,
  BLEND_ARCHETYPES,
};
