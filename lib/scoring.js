// /lib/scoring.js
// Pure JavaScript scoring logic for the SR Alignment Blueprint assessment.
// No external dependencies. Easy to unit test, easy to update.
//
// Each pillar has a scoring function that takes raw answer data
// and returns a structured score object.

// =======================================================================
// PILLAR 1: BEHAVIOR PROFILE (CORE framework, built on DISC concepts)
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

  // Apply Laplace smoothing (+2 per dimension) to ensure every customer
  // shows a meaningful presence in every CORE dimension. No one in real life
  // has 0% of any wiring; everyone carries some baseline of all four. This
  // prevents the math from ever producing a true zero on a percentage breakdown.
  const SMOOTHING = 2;
  const smoothed = {
    D: counts.D + SMOOTHING,
    I: counts.I + SMOOTHING,
    S: counts.S + SMOOTHING,
    C: counts.C + SMOOTHING,
  };
  const smoothedTotal = smoothed.D + smoothed.I + smoothed.S + smoothed.C;

  // Convert smoothed counts to a 0-10 scale based on percentage of smoothed total
  const scores10 = {
    d: Math.round((smoothed.D / smoothedTotal) * 10 * 10) / 10,
    i: Math.round((smoothed.I / smoothedTotal) * 10 * 10) / 10,
    s: Math.round((smoothed.S / smoothedTotal) * 10 * 10) / 10,
    c: Math.round((smoothed.C / smoothedTotal) * 10 * 10) / 10,
  };

  // Identify dominant type and two-letter type (e.g., "SI", "DC")
  // Use raw counts here so the dominant letter still reflects actual answers,
  // not the smoothing baseline.
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

  // Apply Laplace smoothing (+2 per channel) so no customer ever gets a true
  // 0% on any learning channel. Every brain processes through every channel
  // to some degree; the math should reflect that.
  const SMOOTHING = 2;
  const smoothed = {
    Sight: counts.Sight + SMOOTHING,
    Sound: counts.Sound + SMOOTHING,
    Word:  counts.Word  + SMOOTHING,
    Touch: counts.Touch + SMOOTHING,
  };
  const smoothedTotal = smoothed.Sight + smoothed.Sound + smoothed.Word + smoothed.Touch;

  const pct = {
    sight: Math.round((smoothed.Sight / smoothedTotal) * 100),
    sound: Math.round((smoothed.Sound / smoothedTotal) * 100),
    word:  Math.round((smoothed.Word  / smoothedTotal) * 100),
    touch: Math.round((smoothed.Touch / smoothedTotal) * 100),
  };

  // Dominant channel still uses raw counts so it reflects actual answers,
  // not the smoothing baseline.
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominantChannel = sorted[0][0];
  const channelMix = `Sight ${pct.sight}%, Sound ${pct.sound}%, Word ${pct.word}%, Touch ${pct.touch}%`;

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
// PILLAR 7: SPIRITUAL GIFTS
// =======================================================================
// 25 questions (srConditional_QG1-QG25), fires for Options 6/7/8.
// Each question has 4 options (A/B/C/D), each mapping to one of 12 gifts.
// Scoring: tally gift hits across all answered questions, rank top 3.
// Tiebreaker: count hits from Q14-Q25 (scenario-specific second half).
//
// PILLAR_7_GIFT_MAP: question key -> [A-gift, B-gift, C-gift, D-gift]
// PILLAR_7_OPTIONS:  question key -> [A-text, B-text, C-text, D-text]
// Both arrays are index-aligned (index 0 = option A, index 3 = option D).

const PILLAR_7_GIFT_MAP = {
  QG1:  ['Mercy', 'Helps / Service', 'Encouragement', 'Faith'],
  QG2:  ['Hospitality', 'Pastoring / Shepherding', 'Evangelism', 'Leadership'],
  QG3:  ['Discernment', 'Pastoring / Shepherding', 'Encouragement', 'Leadership'],
  QG4:  ['Pastoring / Shepherding', 'Evangelism', 'Teaching', 'Faith'],
  QG5:  ['Giving', 'Hospitality', 'Teaching', 'Administration'],
  QG6:  ['Administration', 'Leadership', 'Faith', 'Pastoring / Shepherding'],
  QG7:  ['Teaching', 'Encouragement', 'Helps / Service', 'Mercy'],
  QG8:  ['Discernment', 'Hospitality', 'Leadership', 'Administration'],
  QG9:  ['Teaching', 'Evangelism', 'Pastoring / Shepherding', 'Mercy'],
  QG10: ['Faith', 'Encouragement', 'Discernment', 'Mercy'],
  QG11: ['Teaching', 'Evangelism', 'Giving', 'Helps / Service'],
  QG12: ['Administration', 'Helps / Service', 'Discernment', 'Mercy'],
  QG13: ['Administration', 'Giving', 'Mercy', 'Leadership'],
  QG14: ['Encouragement', 'Discernment', 'Faith', 'Helps / Service'],
  QG15: ['Teaching', 'Discernment', 'Encouragement', 'Pastoring / Shepherding'],
  QG16: ['Discernment', 'Mercy', 'Faith', 'Leadership'],
  QG17: ['Evangelism', 'Discernment', 'Hospitality', 'Faith'],
  QG18: ['Administration', 'Giving', 'Evangelism', 'Leadership'],
  QG19: ['Pastoring / Shepherding', 'Leadership', 'Administration', 'Teaching'],
  QG20: ['Leadership', 'Encouragement', 'Teaching', 'Mercy'],
  QG21: ['Giving', 'Helps / Service', 'Hospitality', 'Encouragement'],
  QG22: ['Discernment', 'Evangelism', 'Faith', 'Mercy'],
  QG23: ['Giving', 'Helps / Service', 'Hospitality', 'Evangelism'],
  QG24: ['Teaching', 'Hospitality', 'Pastoring / Shepherding', 'Evangelism'],
  QG25: ['Administration', 'Encouragement', 'Pastoring / Shepherding', 'Giving'],
};

// Option texts embedded for pre-regen robustness. Before the regen script
// runs to add QG fields to question-map.js, the scoring engine uses these
// strings to match answer text -> option index -> gift. Index-aligned with
// PILLAR_7_GIFT_MAP (index 0 = A, index 1 = B, index 2 = C, index 3 = D).
const PILLAR_7_OPTIONS = {
  QG1: [
    'Sit with them. You do not rush to fix anything. You just want them to feel less alone.',
    'Find something practical to do. Take one burden off them before you say a word.',
    'Speak into them. Remind them of what is true about who they are and what God says about them.',
    'Pray with them. You want to watch for what God is doing in it.',
  ],
  QG2: [
    'Find the person standing alone and go to them first.',
    'Ask enough questions to actually understand their life. Surface conversation is not enough for you.',
    'Share what this community has meant to you. You want them to know why they should stay.',
    'See where they would fit. You can tell within a few minutes what role they could play here.',
  ],
  QG3: [
    'Read what is underneath it. You want to understand what is actually happening before you speak.',
    'Move toward the middle. You hold people together until the heat passes.',
    'Find what each side is getting right and say it out loud. That shift often opens the room.',
    'Step in and provide direction. Someone has to move this forward.',
  ],
  QG4: [
    'Stay in it with them long-term. You are not going anywhere, and you are not in a hurry.',
    'Share what you know from your own experience. Your story is the most honest argument you have.',
    'Walk through what scripture says on the specific question they are wrestling with.',
    'Pray and trust God to do the work. You know whose job it is and whose it is not.',
  ],
  QG5: [
    'Give a chunk of it. Somewhere you already know needs it.',
    'Have more people over. Feed more people. Open the table up.',
    'Put it toward someone\'s development. Invest it where it multiplies.',
    'Think through the system. Where does this resource fit in the larger picture?',
  ],
  QG6: [
    'Define who does what. Assign ownership, build the timeline, close the gaps.',
    'Get the people energized about why this matters. The buy-in comes before the plan.',
    'Pray about it first. You want to know if this is yours to lead before you say yes.',
    'Find out who is involved and make sure each person is set up to succeed.',
  ],
  QG7: [
    'Teaching them something. Explaining an idea that changed how you see the world.',
    'Encouraging them. Speaking into who they are and what you see in them.',
    'Serving them. You do things before they ask, without making a thing of it.',
    'Being the person who can feel what someone needs before they say it.',
  ],
  QG8: [
    'The spiritual dynamics. Who is operating out of something real versus something performed.',
    'The person who does not quite fit in. The one who has not connected yet.',
    'The informal power structure. Who leads here, and how well is that going for everyone?',
    'The logistical gaps. The thing nobody organized that is going to become a problem.',
  ],
  QG9: [
    'Preparing carefully and wanting to explain the text as accurately as possible.',
    'Thinking about who outside the group needs to hear this. You keep thinking of specific people.',
    'Listening for how the material is landing for each person personally.',
    'Noticing who in the room is carrying something heavy. You want the text to reach them specifically.',
  ],
  QG10: [
    'You pray and trust God to show them. You are clear on whose job it is.',
    'You call out what you know is true about them. Sometimes people need to be reminded who they are before they make a choice.',
    'You ask questions until they surface the blind spot themselves.',
    'You stay beside them regardless of the choice. When the consequences come, you are there.',
  ],
  QG11: [
    'Teaching or explaining. Breaking something down until people actually get it.',
    'Watching someone come to faith or renew their faith. That moment is the whole thing for you.',
    'The moment you can give something and it actually solves a real problem.',
    'Serving in ways most people do not notice. Behind-the-scenes work that makes everything run.',
  ],
  QG12: [
    'You start connecting dots. Resources, people, next steps. You map it fast.',
    'You just say yes. You figure out the how afterward.',
    'You ask more questions. The first thing someone asks for is rarely the real ask.',
    'You feel the weight of what they are carrying before you even respond.',
  ],
  QG13: [
    'You start organizing the response. Who needs to know, who should do what, in what order.',
    'You give to it. If financial resources can move this, yours are available.',
    'You go to the person or family in need. They need someone present before they need anything else.',
    'You start rounding up people to respond. More hands, better outcome.',
  ],
  QG14: [
    'You speak life into them. "Here is what is true. Here is who you are."',
    'You read what is underneath the fear before you respond. The surface fear is rarely the whole story.',
    'You believe for them when they cannot believe for themselves.',
    'You look for the practical thing that would reduce the threat right now.',
  ],
  QG15: [
    'You would teach them something that changes how they see.',
    'You would ask questions until you understood exactly where they are.',
    'You would speak into them. What you see in them, what you sense God is saying about them.',
    'You would stay close enough and long enough to know what they actually need, and then provide it.',
  ],
  QG16: [
    'You name it. You have seen this pattern before and you are not going to let it develop further.',
    'You go to the people most affected before you do anything else. You want to know what they are experiencing.',
    'You pray until you sense something specific, then you act on it.',
    'You bring it to whoever needs to address it and help them see what you see.',
  ],
  QG17: [
    'You look for the natural moment to share what faith has meant in your own life.',
    'You read what they actually believe versus what they say they believe.',
    'You love them well, openly, and without agenda. The life you live is the argument.',
    'You trust God to work through the relationship over time.',
  ],
  QG18: [
    'You start mapping it. Resources, organizations, how the problem is structured, what the gaps are.',
    'You give to it. Your money goes where your concern goes.',
    'You start talking to people about it. This is something they need to know.',
    'You start recruiting people to act with you. You would rather lead a team than go at it alone.',
  ],
  QG19: [
    'You want to know each person before you lead them. You get in the room with them one by one.',
    'You cast the vision. You tell them where this is going and why it matters.',
    'You build the structure. Everyone knows their role, the logistics are covered, the gaps are closed.',
    'You make sure they are equipped. They need to know what they are doing before you ask them to do it.',
  ],
  QG20: [
    'Your direction. When they do not know the next step, they come to you for it.',
    'Your words. You say things that give people strength when they are running on empty.',
    'Your ability to explain. When something is complicated or confusing, you are the person who breaks it down.',
    'Your presence. A safe ear, someone who will not flinch at what they bring.',
  ],
  QG21: [
    'Money. What you could give and to whom.',
    'Time. Who you could serve and what you could do with your hands.',
    'Your home. Who you could bring in, feed, and welcome.',
    'Your words. Who you could encourage this week.',
  ],
  QG22: [
    'Say what you are sensing. You have learned to trust this.',
    'Share what you sensed with them. If God is at work in this moment, they need to know.',
    'Pray about it. You need to know it is from God before you act on it.',
    'Feel what the person is carrying. You want to be in it with them, whatever it is.',
  ],
  QG23: [
    'Financial. You gave money you needed because someone else needed it more.',
    'Time and presence. You showed up with your hands and your hours when it cost you something.',
    'Your home and your resources. You gave the best of what you had to welcome someone in.',
    'Your comfort. You shared your faith with someone who might walk away. You did it anyway.',
  ],
  QG24: [
    'Get them into the word. Knowledge is the foundation and you want them on solid ground.',
    'Bring them in. To your home, to your table, to your people.',
    'Walk with them over time. No rushing. The relationship builds while the faith builds.',
    'Tell them your story. How you got here. What changed. Let that do the work.',
  ],
  QG25: [
    'Organizing the response. Who does what, in what order, with which resources.',
    'Keeping spirits up. You find the most discouraged person in the room and you go there first.',
    'Walking beside whoever has to make the hard call. You are not the decision-maker, but you want to be there while they decide.',
    'Giving what you can. If money or material resources can help, yours are available.',
  ],
};

const ALL_GIFTS = [
  'Administration', 'Discernment', 'Encouragement', 'Evangelism',
  'Faith', 'Giving', 'Helps / Service', 'Hospitality', 'Leadership',
  'Mercy', 'Pastoring / Shepherding', 'Teaching',
];

// scorePillar7: returns { primary, secondary, tertiary } from QG1-QG25 answers.
// Returns null if no QG answers are present (Pillar 7 did not fire).
// Tiebreaker: count how many of a gift's hits came from Q14-Q25 (the scenario
// questions which are more discriminating than the instinct questions Q1-Q13).
function scorePillar7(conditionalAnswers) {
  if (!conditionalAnswers || typeof conditionalAnswers !== 'object') return null;

  const counts = {};
  const secondHalfCounts = {}; // Q14-Q25 for tiebreaking
  ALL_GIFTS.forEach(g => { counts[g] = 0; secondHalfCounts[g] = 0; });

  let found = 0;
  for (let i = 1; i <= 25; i++) {
    const key = `QG${i}`;
    const text = conditionalAnswers[key];
    if (!text) continue;

    const options = PILLAR_7_OPTIONS[key];
    const giftMap = PILLAR_7_GIFT_MAP[key];
    if (!options || !giftMap) continue;

    let idx = -1;
    const v = String(text).trim();
    idx = options.indexOf(v);
    if (idx < 0) {
      // GHL sometimes prepends "A) " etc. — strip and retry
      const stripped = v.replace(/^[a-dA-D]\)\s+/, '');
      idx = options.indexOf(stripped);
    }
    if (idx < 0) {
      // Partial match on first 30 chars as last resort
      idx = options.findIndex(o => o.startsWith(v.substring(0, 30)) || v.startsWith(o.substring(0, 30)));
    }
    if (idx < 0 || idx > 3) {
      console.warn(`[scoring] Pillar 7 ${key}: could not map answer "${v}" to a gift`);
      continue;
    }

    const gift = giftMap[idx];
    if (!gift) continue;

    counts[gift]++;
    if (i >= 14) secondHalfCounts[gift]++;
    found++;
  }

  if (found === 0) return null;

  // Sort by count desc, tiebreak by second-half count desc
  const ranked = ALL_GIFTS
    .map(g => ({ gift: g, count: counts[g], secondHalf: secondHalfCounts[g] }))
    .sort((a, b) => b.count - a.count || b.secondHalf - a.secondHalf);

  return {
    primary:   ranked[0].gift,
    secondary: ranked[1].gift,
    tertiary:  ranked[2].gift,
  };
}

// =======================================================================
// MASTER SCORING FUNCTION
// =======================================================================
// Takes the full assessment payload from GHL webhook
// Returns the complete scored profile that gets sent to Claude

function scoreAssessment(rawAnswers) {
  const conditionalAnswers = rawAnswers.conditionalAnswers || {};
  return {
    pillar1: scoreBehaviorProfile(rawAnswers.behaviorProfile || []),
    pillar2: scorePersonalityCode(rawAnswers.personalityCode || {}),
    pillar3: scoreActionStyle(rawAnswers.actionStyle || []),
    pillar4: scoreConnectionCurrency(rawAnswers.connectionCurrency || []),
    pillar5: scoreLearningChannel(rawAnswers.learningChannel || []),
    pillar6: scoreSpiritualCompass(rawAnswers.spiritualCompass || {}),
    conditionalAnswers,
    spiritualGifts: scorePillar7(conditionalAnswers),
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
    conditionalAnswers: {},
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

    // Handle conditional questions (Sets A through E)
    if (q.conditionalKey) {
      const optText = q.options[idx];
      if (optText !== undefined) {
        const shortKey = q.conditionalKey.replace('srConditional_', '');
        rawAnswers.conditionalAnswers[shortKey] = optText;
      } else {
        console.warn(`[scoring] Conditional field ${q.conditionalKey}: idx ${idx} out of range (options.length=${q.options.length})`);
      }
      continue;
    }

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
  scorePillar7,
  scoreAssessment,
  buildRawAnswersFromCustomFields,
};
