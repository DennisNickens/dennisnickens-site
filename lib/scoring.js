// /lib/scoring.js
// Pure JavaScript scoring logic for the SR Alignment Blueprint assessment.
// No external dependencies. Easy to unit test, easy to update.
//
// Each pillar has a scoring function that takes raw answer data
// and returns a structured score object.

// =======================================================================
// PILLAR 1: BEHAVIOR PROFILE (DISC)
// =======================================================================
// 24 questions, each tagged [D], [I], [S], or [C]
// Input: array of 24 tag strings (e.g., ["D", "I", "S", "I", "C", ...])
// Output: { d, i, s, c, scores10, dominantType, twoLetterType }

function scoreBehaviorProfile(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return { d: 0, i: 0, s: 0, c: 0, scores10: { d: 0, i: 0, s: 0, c: 0 }, dominantType: "Unknown", twoLetterType: "Unknown" };
  }

  const counts = { D: 0, I: 0, S: 0, C: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const total = answers.length;

  // Convert raw counts to a 0-10 scale based on percentage of total
  const scores10 = {
    d: Math.round((counts.D / total) * 10 * 10) / 10,
    i: Math.round((counts.I / total) * 10 * 10) / 10,
    s: Math.round((counts.S / total) * 10 * 10) / 10,
    c: Math.round((counts.C / total) * 10 * 10) / 10,
  };

  // Identify dominant type and two-letter type (e.g., "SI", "DC")
  const sortedDimensions = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominantType = sortedDimensions[0][0];
  const twoLetterType = `${sortedDimensions[0][0]}${sortedDimensions[1][0]}`;

  return {
    d: counts.D,
    i: counts.I,
    s: counts.S,
    c: counts.C,
    scores10,
    dominantType,
    twoLetterType,
  };
}

// =======================================================================
// PILLAR 2: PERSONALITY CODE (SR Charge / Trust / Decide / Live)
// =======================================================================
// 28 questions, 7 per dichotomy. Internally keyed by ei/sn/tf/jp (legacy
// dichotomy slot names; do not customer-facing). Each slot now outputs
// the SR letter pair:
//   ei -> Charge: O (Outward) vs W (Inward)
//   sn -> Trust:  T (Tangible) vs V (Vision)
//   tf -> Decide: M (Mind)     vs H (Heart)
//   jp -> Live:   P (Plan)     vs F (Flow)
// Input: { ei: ["O","W","O",...], sn: ["T","V",...], tf: [...], jp: [...] }
// Output: { type: "OVMP", letters: { charge, trust, decide, live }, balanced: [] }

function scorePersonalityCode(answers) {
  if (!answers || !answers.ei || !answers.sn || !answers.tf || !answers.jp) {
    return { type: "Unknown", letters: {}, balanced: [], reason: "Missing answer arrays" };
  }

  const balanced = [];
  const letters = {};

  // Helper: pick the letter that appears more in the array
  const pickLetter = (arr, optionA, optionB) => {
    let countA = 0, countB = 0;
    for (const tag of arr) {
      if (tag === optionA) countA++;
      else if (tag === optionB) countB++;
    }
    if (countA === countB) {
      balanced.push(`${optionA}/${optionB}`);
      return optionA; // default to first option on tie
    }
    return countA > countB ? optionA : optionB;
  };

  letters.charge = pickLetter(answers.ei, "O", "W");
  letters.trust  = pickLetter(answers.sn, "T", "V");
  letters.decide = pickLetter(answers.tf, "M", "H");
  letters.live   = pickLetter(answers.jp, "P", "F");

  const type = `${letters.charge}${letters.trust}${letters.decide}${letters.live}`;

  return {
    type,
    letters,
    balanced, // dichotomies that were tied
  };
}

// =======================================================================
// PILLAR 3: ACTION STYLE (SR Scholar / Steward / Sparker / Crafter)
// =======================================================================
// 20 questions, each tagged "Scholar", "Steward", "Sparker", or "Crafter"
// Input: array of 20 tag strings
// Output: { scholar, steward, sparker, crafter, dominantMode, secondaryMode }
// dominantMode and secondaryMode are full archetype names ("The Scholar",
// "The Steward", "The Sparker", "The Crafter").

function scoreActionStyle(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      scholar: 0, steward: 0, sparker: 0, crafter: 0,
      dominantMode: "Unknown", secondaryMode: "Unknown"
    };
  }

  const counts = { Scholar: 0, Steward: 0, Sparker: 0, Crafter: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return {
    scholar: counts.Scholar,
    steward: counts.Steward,
    sparker: counts.Sparker,
    crafter: counts.Crafter,
    dominantMode: `The ${sorted[0][0]}`,
    secondaryMode: `The ${sorted[1][0]}`,
  };
}

// =======================================================================
// PILLAR 4: CONNECTION CURRENCY (SR Spoken / Presence / Contact / Action / Tokens)
// =======================================================================
// 20 questions, each tagged "Spoken", "Presence", "Contact", "Action", or "Tokens"
// Input: array of 20 tag strings
// Output: { spoken, presence, contact, action, tokens, primary, secondary, ranked }

function scoreConnectionCurrency(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      spoken: 0, presence: 0, contact: 0, action: 0, tokens: 0,
      primary: "Unknown", secondary: "Unknown", ranked: []
    };
  }

  const counts = { Spoken: 0, Presence: 0, Contact: 0, Action: 0, Tokens: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return {
    spoken: counts.Spoken,
    presence: counts.Presence,
    contact: counts.Contact,
    action: counts.Action,
    tokens: counts.Tokens,
    primary: ranked[0][0],
    secondary: ranked[1][0],
    ranked: ranked.map(([name, count]) => ({ name, count })),
  };
}

// =======================================================================
// PILLAR 5: LEARNING CHANNEL (SR Sight / Sound / Word / Touch)
// =======================================================================
// 16 questions, each tagged "Sight", "Sound", "Word", or "Touch"
// Input: array of 16 tag strings
// Output: percentages for each, dominant channel

function scoreLearningChannel(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      sightPct: 0, soundPct: 0, wordPct: 0, touchPct: 0,
      dominantChannel: "Unknown", channelMix: ""
    };
  }

  const counts = { Sight: 0, Sound: 0, Word: 0, Touch: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const total = answers.length;
  const pct = {
    sight: Math.round((counts.Sight / total) * 100),
    sound: Math.round((counts.Sound / total) * 100),
    word:  Math.round((counts.Word  / total) * 100),
    touch: Math.round((counts.Touch / total) * 100),
  };

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominantChannel = sorted[0][0];
  const channelMix = sorted.map(([name, count]) => `${name} ${Math.round((count / total) * 100)}%`).join(", ");

  return {
    sightPct: pct.sight,
    soundPct: pct.sound,
    wordPct:  pct.word,
    touchPct: pct.touch,
    dominantChannel,
    channelMix,
  };
}

// =======================================================================
// PILLAR 6: SPIRITUAL COMPASS
// =======================================================================
// 12 questions, mix of categorical and free-form
// Input: object with structured answer data
// Output: faith orientation + theme analysis (mostly raw data passed to Claude)

function scoreSpiritualCompass(answers) {
  if (!answers) {
    return { faithOrientation: "Unknown", themes: [], rawAnswers: {} };
  }

  // The first question is the faith orientation (categorical)
  const faithOrientation = answers.faithOrientation || "Unknown";

  // Questions 110-120 reveal a theme pattern
  // Each answer maps to one of 4 themes:
  //   Action-oriented (a) — boldness, mission, doing
  //   Community-oriented (b) — fellowship, worship, relational
  //   Contemplative (c) — peace, stillness, prayer
  //   Study-oriented (d) — theology, depth, scripture
  const themeCounts = { Action: 0, Community: 0, Contemplative: 0, Study: 0 };
  if (Array.isArray(answers.themeAnswers)) {
    for (const tag of answers.themeAnswers) {
      if (tag in themeCounts) themeCounts[tag]++;
    }
  }

  const ranked = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]);
  const primaryTheme = ranked[0][0];
  const secondaryTheme = ranked[1][0];

  return {
    faithOrientation,
    primaryTheme,
    secondaryTheme,
    themeCounts,
    rawAnswers: answers, // pass all raw data to Claude for contextual interpretation
  };
}

// =======================================================================
// MASTER SCORING FUNCTION
// =======================================================================
// Takes the full assessment payload from GHL webhook
// Returns the complete scored profile that gets sent to Claude

function scoreAssessment(rawAnswers) {
  return {
    pillar1: scoreBehaviorProfile(rawAnswers.behaviorProfile || []),
    pillar2: scorePersonalityCode(rawAnswers.personalityCode || {}),
    pillar3: scoreActionStyle(rawAnswers.actionStyle || []),
    pillar4: scoreConnectionCurrency(rawAnswers.connectionCurrency || []),
    pillar5: scoreLearningChannel(rawAnswers.learningChannel || []),
    pillar6: scoreSpiritualCompass(rawAnswers.spiritualCompass || {}),
  };
}

// =======================================================================
// TRANSFORMER: GHL CUSTOM FIELDS -> rawAnswers SHAPE
// =======================================================================
// GHL stores each survey answer as a separate custom field on the contact.
// The field's value is the answer TEXT, not a tag. This function walks the
// contact's customFields, looks each one up in the canonical QUESTION_MAP,
// finds the value's position in the question's option list, and translates
// that position into the tag the scorer expects.
//
// Per-pillar option-position -> tag conventions are documented in
// SR-ASSESSMENT-QUESTIONS.md and verified consistent across all 120 questions
// (Pillar 1: a/b/c/d = D/I/S/C, Pillar 3: a/b/c/d = Scholar/Steward/Sparker/Crafter,
//  Pillar 4: a/b/c/d/e = Spoken/Presence/Contact/Action/Tokens,
//  Pillar 5: a/b/c/d = Sight/Sound/Word/Touch).

const { QUESTION_MAP, PERSONALITY_QUESTION_INFO, FAITH_ORIENTATION_LABELS } = require('./question-map');

const PILLAR1_TAGS = ['D', 'I', 'S', 'C'];
const PILLAR3_TAGS = ['Scholar', 'Steward', 'Sparker', 'Crafter'];
const PILLAR4_TAGS = ['Spoken', 'Presence', 'Contact', 'Action', 'Tokens'];
const PILLAR5_TAGS = ['Sight', 'Sound', 'Word', 'Touch'];
const PILLAR6_THEME_TAGS = ['Action', 'Community', 'Contemplative', 'Study'];

function findOptionIndex(value, options) {
  if (!value || !Array.isArray(options)) return -1;
  const v = String(value).trim();
  let idx = options.indexOf(v);
  if (idx >= 0) return idx;
  // Handle GHL's occasional "X) " letter prefix on stored values
  const stripped = v.replace(/^[a-fA-F]\)\s+/, '');
  return options.indexOf(stripped);
}

function buildRawAnswersFromCustomFields(customFields) {
  const rawAnswers = {
    behaviorProfile: [],
    personalityCode: { ei: [], sn: [], tf: [], jp: [] },
    actionStyle: [],
    connectionCurrency: [],
    learningChannel: [],
    spiritualCompass: { faithOrientation: '', themeAnswers: [] },
  };

  if (!Array.isArray(customFields)) return rawAnswers;

  for (const f of customFields) {
    const fid = f && f.id;
    const val = f && f.value;
    if (!fid || typeof val !== 'string') continue;
    const q = QUESTION_MAP[fid];
    if (!q) continue;
    const idx = findOptionIndex(val, q.options);
    if (idx < 0) continue;
    const n = q.qnum;
    if (n >= 1 && n <= 24) {
      const tag = PILLAR1_TAGS[idx];
      if (tag) rawAnswers.behaviorProfile.push(tag);
    } else if (n >= 25 && n <= 52) {
      const info = PERSONALITY_QUESTION_INFO[n];
      if (info && info.dichotomy && info.tags && info.tags[idx]) {
        rawAnswers.personalityCode[info.dichotomy].push(info.tags[idx]);
      }
    } else if (n >= 53 && n <= 72) {
      const tag = PILLAR3_TAGS[idx];
      if (tag) rawAnswers.actionStyle.push(tag);
    } else if (n >= 73 && n <= 92) {
      const tag = PILLAR4_TAGS[idx];
      if (tag) rawAnswers.connectionCurrency.push(tag);
    } else if (n >= 93 && n <= 108) {
      const tag = PILLAR5_TAGS[idx];
      if (tag) rawAnswers.learningChannel.push(tag);
    } else if (n === 109) {
      rawAnswers.spiritualCompass.faithOrientation =
        FAITH_ORIENTATION_LABELS[idx] || val;
    } else if (n >= 110 && n <= 120) {
      const tag = PILLAR6_THEME_TAGS[idx];
      if (tag) rawAnswers.spiritualCompass.themeAnswers.push(tag);
    }
  }

  return rawAnswers;
}

module.exports = {
  scoreBehaviorProfile,
  scorePersonalityCode,
  scoreActionStyle,
  scoreConnectionCurrency,
  scoreLearningChannel,
  scoreSpiritualCompass,
  scoreAssessment,
  buildRawAnswersFromCustomFields,
};
