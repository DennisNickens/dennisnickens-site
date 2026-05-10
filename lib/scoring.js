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
// PILLAR 2: PERSONALITY CODE (MBTI-style)
// =======================================================================
// 28 questions, 7 per dichotomy (E/I, S/N, T/F, J/P)
// Input: object with 4 arrays of tags, e.g.,
//   { ei: ["E","I","E",...], sn: ["S","N",...], tf: [...], jp: [...] }
// Output: { type: "ENFJ", letters: { e_i: "E", s_n: "N", t_f: "F", j_p: "J" }, balanced: [] }

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

  letters.e_i = pickLetter(answers.ei, "E", "I");
  letters.s_n = pickLetter(answers.sn, "S", "N");
  letters.t_f = pickLetter(answers.tf, "T", "F");
  letters.j_p = pickLetter(answers.jp, "J", "P");

  const type = `${letters.e_i}${letters.s_n}${letters.t_f}${letters.j_p}`;

  return {
    type,
    letters,
    balanced, // array of dichotomies that were tied (good to surface in Blueprint)
  };
}

// =======================================================================
// PILLAR 3: ACTION STYLE (Kolbe-style)
// =======================================================================
// 20 questions, each tagged "FactFinder", "FollowThru", "QuickStart", or "Implementor"
// Input: array of 20 tag strings
// Output: { factFinder, followThru, quickStart, implementor, dominantMode, secondaryMode }

function scoreActionStyle(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      factFinder: 0, followThru: 0, quickStart: 0, implementor: 0,
      dominantMode: "Unknown", secondaryMode: "Unknown"
    };
  }

  const counts = { FactFinder: 0, FollowThru: 0, QuickStart: 0, Implementor: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return {
    factFinder: counts.FactFinder,
    followThru: counts.FollowThru,
    quickStart: counts.QuickStart,
    implementor: counts.Implementor,
    dominantMode: sorted[0][0],
    secondaryMode: sorted[1][0],
  };
}

// =======================================================================
// PILLAR 4: CONNECTION LANGUAGE (Love Languages)
// =======================================================================
// 20 questions, each tagged "Words", "Time", "Touch", "Service", or "Gifts"
// Input: array of 20 tag strings
// Output: { words, time, touch, service, gifts, primary, secondary, ranked }

function scoreConnectionLanguage(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      words: 0, time: 0, touch: 0, service: 0, gifts: 0,
      primary: "Unknown", secondary: "Unknown", ranked: []
    };
  }

  const counts = { Words: 0, Time: 0, Touch: 0, Service: 0, Gifts: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return {
    words: counts.Words,
    time: counts.Time,
    touch: counts.Touch,
    service: counts.Service,
    gifts: counts.Gifts,
    primary: ranked[0][0],
    secondary: ranked[1][0],
    ranked: ranked.map(([name, count]) => ({ name, count })),
  };
}

// =======================================================================
// PILLAR 5: LEARNING CHANNEL (VARK)
// =======================================================================
// 16 questions, each tagged "Visual", "Auditory", "Reading", or "Doing"
// Input: array of 16 tag strings
// Output: percentages for each, dominant channel

function scoreLearningChannel(answers) {
  if (!Array.isArray(answers) || answers.length === 0) {
    return {
      visualPct: 0, auditoryPct: 0, readingPct: 0, doingPct: 0,
      dominantChannel: "Unknown", channelMix: ""
    };
  }

  const counts = { Visual: 0, Auditory: 0, Reading: 0, Doing: 0 };
  for (const tag of answers) {
    if (tag in counts) counts[tag]++;
  }

  const total = answers.length;
  const pct = {
    visual: Math.round((counts.Visual / total) * 100),
    auditory: Math.round((counts.Auditory / total) * 100),
    reading: Math.round((counts.Reading / total) * 100),
    doing: Math.round((counts.Doing / total) * 100),
  };

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominantChannel = sorted[0][0];
  const channelMix = sorted.map(([name, count]) => `${name} ${Math.round((count / total) * 100)}%`).join(", ");

  return {
    visualPct: pct.visual,
    auditoryPct: pct.auditory,
    readingPct: pct.reading,
    doingPct: pct.doing,
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
    pillar4: scoreConnectionLanguage(rawAnswers.connectionLanguage || []),
    pillar5: scoreLearningChannel(rawAnswers.learningChannel || []),
    pillar6: scoreSpiritualCompass(rawAnswers.spiritualCompass || {}),
  };
}

module.exports = {
  scoreBehaviorProfile,
  scorePersonalityCode,
  scoreActionStyle,
  scoreConnectionLanguage,
  scoreLearningChannel,
  scoreSpiritualCompass,
  scoreAssessment,
};
