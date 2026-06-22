#!/usr/bin/env node
// scripts/build-peshon-recovery.js
//
// One-shot data builder for Peshon Allen's Blueprint recovery.
//
// Reads her 251 recovered answers, cross-references against lib/question-map.js,
// and emits lib/peshon-recovery-data.json: an array of { id, field_value } pairs
// ready to be PUT into her GHL contact's customFields.
//
// The recovery exists because the SR Full Assessment survey collected her June 19
// submission cleanly but never wrote the answers to the question-keyed contact
// fields the Blueprint generator reads. Source data was scraped from GHL's
// survey-submissions panel and saved to Strategy/PESHON-ALLEN-SUBMISSION-RECOVERY.md.
//
// Run:
//   node scripts/build-peshon-recovery.js
//
// Output:
//   lib/peshon-recovery-data.json (committed)
//   warnings on any answer that didn't cleanly map to a question option

const fs = require('fs');
const path = require('path');

const { QUESTION_MAP } = require('../lib/question-map');

// Peshon's 251 recovered answers, in survey-submission order. Each entry is
// either a base question (matched by question text) or a positional conditional
// answer (matched by which conditional set we're in + offset).
//
// Source: Strategy/PESHON-ALLEN-SUBMISSION-RECOVERY.md (extracted via Chrome MCP
// from GHL survey-submissions panel for survey ucgEftbHx3FqnoUYt6Ub).

// Each base entry: { text: "<her answer text>" } — we'll match by text against
// QUESTION_MAP options.
//
// Each conditional entry: { conditional: "<short key>", text: "<her answer>" }
// (e.g., conditional: "QA1") — we match by short key directly.

const PESHON_ANSWERS_BY_QNUM = {
  // Set A (Pillar 1 - Behavior Profile / CORE): Q1-Q24
  1:  'Greet everyone with energy and humor',
  2:  'Rally people and lift the mood',
  3:  'The data and the facts',
  4:  'Cold, unfriendly, or negative',
  5:  'Lead with encouragement and warmth',
  6:  'Re-energize the team and rebuild morale',
  7:  'Personal, full of photos and energy',
  8:  'Laugh at yourself and own it openly',
  9:  'Connecting. Inspiring people.',
  10: 'Build the energy and bring others in',
  11: 'Steamrolling people who think slower than you',
  12: 'Charm them and reframe the room',
  13: 'Knowing your people are safe and cared for',
  14: 'Endless meetings without decisions',
  15: '"Get it done."',
  16: 'Pump up the team and rally them through it',
  17: 'Too much discussion, not enough action',
  18: 'Loyalty, reliability, and steady character',
  19: 'A slow morning, no agenda, comfort food',
  20: 'Lots of emojis, voice notes, exclamation points',
  21: 'Being ignored or talked over',
  22: 'Showing up consistently, no matter what',
  23: '"He\'s the heart of the team. Everyone loves him."',
  24: 'Withdraw. Analyze. Build the case.',

  // Set B (Pillar 2 - Personality Code): Q25-Q52 (Q27 not in map)
  25: 'Drained, needing time alone to recover',
  26: 'People, values, and emotional impact',
  28: 'Plans are made and decisions are settled',
  29: 'Outgoing and expressive',
  30: 'Hands-on experience and step-by-step instructions',
  31: 'To feel the weight of it and process the emotion',
  32: 'Plans set in advance, knowing what\'s happening',
  33: 'Listen more, speak when you have something specific to say',
  34: 'What could be, behind the surface, possible',
  35: 'Tell people the honest truth, even if it stings',
  36: 'Curious or excited, new options just opened',
  37: 'Being alone with your thoughts',
  38: 'Intuition and what could work next',
  39: 'The wellbeing and growth of the people involved',
  40: 'A clear schedule of what\'s happening when',
  41: 'You can\'t move around and meet new people',
  42: 'Is grounded in real, lived experience',
  43: 'Naming the issue clearly and resolving it logically',
  44: 'Lived-in, spontaneous, with stuff around you love',
  45: 'In a team where ideas bounce off each other',
  46: 'Noticing the practical thing that needs doing',
  47: 'They make people feel seen and valued',
  48: 'Like helpful structure that drives focus',
  49: 'In real-time conversation',
  50: 'Let\'s see what\'s actually possible.',
  51: 'Find a way to address it that keeps them encouraged',
  52: 'Exists, gets followed, gets crossed off',

  // Set C (Pillar 3 - Action Style / DRIVE): Q53-Q72
  53: 'Research everything you can find about it',
  54: 'Someone to actually fix the broken thing',
  55: 'The whole thing runs like a well-oiled machine',
  56: 'The one who pushes through when others stall',
  57: 'Build a checklist and work through it methodically',
  58: 'Nobody actually builds the thing, they just talk',
  59: 'Knocking out a list of organized errands',
  60: 'Being capable',
  61: 'You build a step-by-step timeline and pad it',
  62: 'Articles, links, research you\'ve saved',
  63: 'The data point everyone else missed',
  64: 'Research the heck out of every option before deciding',
  65: 'Reading deeply about it',
  66: 'You investigate why before doing anything',
  67: 'Hands-on, practical, gets it done',
  68: 'Talk about doing it instead of doing it',
  69: '"The system is running smoothly"',
  70: 'Practical guides for building things',
  71: 'Agreement on what we\'re actually going to build',
  72: 'Turning chaos into structure',

  // Set D (Pillar 4 - Connection Currency): Q73-Q92
  73: 'Spends focused time with you, no distractions',
  74: 'Show up and just be there with them',
  75: 'You\'re in the same room but never actually present together',
  76: 'Slow dance in the kitchen',
  77: 'Reaching for them, touching them, holding them',
  78: 'Telling someone they did a great job, specifically',
  79: 'Someone says cruel words',
  80: 'Anticipating what you need and handling it',
  81: 'Someone to take dinner off your plate',
  82: 'Forgot every birthday and anniversary',
  83: 'Bring a meaningful gift that fits them',
  84: 'Closeness, touching, being physically wrapped up in each other',
  85: 'You weren\'t physically there when someone needed you',
  86: '"I saw this and thought of you."',
  87: 'You\'re spending real, undistracted time together',
  88: 'Hand it to them in person, with a hug',
  89: 'Brings home something that says they were thinking of you',
  90: 'Look what I got you',
  91: 'A gift, especially an extravagant one',
  92: 'Time, real and undistracted',

  // Set E (Pillar 5 - Learning Channel): Q93-Q108 (Q100 not in map)
  93: 'You try it yourself',
  94: 'You drive the route once',
  95: 'Hands-on labs, demos, practice',
  96: 'Repeat the name out loud',
  97: 'Has visuals, slides, a clear agenda on screen',
  98: 'Look at the picture diagram',
  99: 'Talk through it step by step',
  101: 'Listening to it over and over',
  102: 'Talk it through with someone',
  103: 'Looking at art and exhibits',
  104: 'Is delivered by a great speaker',
  105: 'Test drive it, walk through it, touch everything',
  106: 'Pages of structured, written-out notes',
  107: 'Want a video where someone talks you through it',
  108: 'Did it with your hands',

  // Set F (Pillar 6 - Spiritual Compass): Q109-Q120
  109: 'Spiritual but not tied to a specific religion',
  110: 'Pray or talk to God',
  111: 'Worship in community with others',
  112: 'Love, for self and for others',
  113: 'You\'re helping someone in need',
  114: 'Personal experiences and lessons learned',
  115: 'Looking for the meaning or lesson',
  116: 'Daily, structured, part of a clear path',
  117: 'Someone deeply rooted in a religious tradition',
  118: 'Serving God or a higher calling',
  119: 'Respect their path, stay grounded in yours',
  120: 'How should I love better?',
};

const PESHON_ANSWERS_BY_CONDITIONAL = {
  // Set Parenting (QA1-QA10): submission idx 124-133
  QA1:  'B) Engage immediately. Talk through what they\'re feeling.',
  QA2:  'A) Curiosity. Why did they do that? What\'s underneath it?',
  QA3:  'A) Stop what I\'m doing. They take priority.',
  QA4:  'A) Tell them directly: "I\'m proud of you. That was good work."',
  QA5:  'A little anxious. I want to make sure they\'re on a good path.',
  QA6:  'Conversation first. We talk about what happened and why',
  QA7:  'The Center. We pray, we read scripture, we go to church together',
  QA8:  'Not being present enough. They\'ll grow up and I\'ll miss it.',
  QA9:  'Help them see what they can learn. We problem-solve together.',
  QA10: 'You are deeply loved, no matter what',

  // Set Leadership (QB1-QB10): submission idx 134-143
  QB1:  'Pull the team back together and find consensus.',
  QB2:  'Natural. Other people often do it better than I could.',
  QB3:  'Open direct. State the issue, then talk solutions.',
  QB4:  'Investigate first. What\'s going on under the surface',
  QB5:  'Casting the vision. Telling the story of where we\'re going.',
  QB6:  'The interpersonal friction. Mediating between team members.',
  QB7:  'Fit. How will they mesh with the team?',
  QB8:  'Useful, if it\'s specific. General complaining is not.',
  QB9:  'Give them clear direction. Less ambiguity is better when they\'re new.',
  QB10: 'The shepherd. Cares for each person while still calling them higher.',

  // Set Dating (QC1-QC10): submission idx 144-153
  QC1:  'Watch how they treat the server or other people. Character first',
  QC2:  'How I feel in their presence. Calm and curious means stay.',
  QC3:  'Values mismatch. We were heading different directions.',
  QC4:  'Notice but don\'t reach out. Wait to see what happens.',
  QC5:  'Like a test. How they handle it tells me who they really are.',
  QC6:  'Slowly. Months of dating before exclusivity.',
  QC7:  'Earned. They have to demonstrate trustworthiness first.',
  QC8:  'Faith alignment. Either we share the same foundation or we don\'t.',
  QC9:  'What I need to feel safe. Without that, I shut down.',
  QC10: 'Mission partners. We\'re building something together.',

  // Set Career (QD1-QD10): submission idx 154-163
  QD1:  'B) Work that helps people directly. I want to see the change in their face.',
  QD2:  'B) Lots of conversation and movement. Energy keeps me sharp.',
  QD3:  'A) Calendar-driven. Plan the week, work the plan.',
  QD4:  'C) Freedom. The kind of work that lets me live the life I actually want.',
  QD5:  'B) Resist it. I draw a hard line. After-hours is sacred.',
  QD6:  'B) Sit with it for a day before saying anything. Make sure I\'m reading it right.',
  QD7:  'A) Not enough exposure. The right people don\'t know what I can do.',
  QD8:  'B) Stability versus risk. Leaving something secure to try something new.',
  QD9:  'A) Faith is the foundation. My work is part of how I live it out.',
  QD10: 'B) The builder. The one who creates something that outlasts them.',

  // Set Marriage (QE1-QE10): submission idx 165-174 (idx 164 = "Yes, married" preq)
  QE1:  'A) We have the same fight, over and over. The topics change; the dance is the same.',
  QE2:  'B) Pull back. Take time alone to think, come back later.',
  QE3:  'B) Steady but not what it used to be. We have drifted some.',
  QE4:  'A) Talk it through together until we are aligned, then act.',
  QE5:  'A) The way they handle things without me asking.',
  QE6:  'B) Real but bridgeable. We see it and are working on it.',
  QE7:  'A) Pull closer. The hard thing becomes ours, not mine and theirs.',
  QE8:  'A) The conversations get shorter. Less talk about the real stuff.',
  QE9:  'A) Easier with them than with anyone else. They are my safest person.',
  QE10: 'A) Deeper than what we have now. Same direction, more intimacy.',

  // Set Ministry (QF1-QF10): submission idx 176-185 (idx 175 = "Yes, lay leadership" preq)
  QF1:  'A) Start with the text. Let scripture or the lesson lead the room.',
  QF2:  'A) Sit with them in it. Don\'t rush to fix.',
  QF3:  'D) The loneliness. Hard to be honest with people you also lead.',
  QF4:  'A) Address it directly and quickly. Better to clear the air.',
  QF5:  'A) Preaching and teaching. Standing in front of people with truth.',
  QF6:  'A) Hold the family line. Ministry comes second to home.',
  QF7:  'A) Strong and consistent. Daily, structured, sustaining.',
  QF8:  'A) Depth. Smaller, deeply formed disciples who reproduce.',
  QF9:  'A) Pray about it, then act with clarity once I sense direction.',
  QF10: 'B) Disciples one or two generations into leaders. Reproduces themselves.',

  // Set G Motivational Gifts (QG1-QG25): submission idx 186-210
  QG1:  'A) Sit with them. You do not rush to fix anything. You just want them to feel less alone.',
  QG2:  'A) Find the person standing alone and go to them first.',
  QG3:  'A) Read what is underneath it. You want to understand what is actually happening before you speak.',
  QG4:  'C) Walk through what scripture says on the specific question they are wrestling with.',
  QG5:  'D) Think through the system. Where does this resource fit in the larger picture?',
  QG6:  'C) Pray about it first. You want to know if this is yours to lead before you say yes.',
  QG7:  'B) Encouraging them. Speaking into who they are and what you see in them.',
  QG8:  'B) The person who does not quite fit in. The one who has not connected yet.',
  QG9:  'A) Preparing carefully and wanting to explain the text as accurately as possible.',
  QG10: 'C) You ask questions until they surface the blind spot themselves.',
  QG11: 'B) Watching someone come to faith or renew their faith. That moment is the whole thing for you.',
  QG12: 'C) You ask more questions. The first thing someone asks for is rarely the real ask.',
  QG13: 'C) You go to the person or family in need. They need someone present before they need anything else.',
  QG14: 'B) You read what is underneath the fear before you respond. The surface fear is rarely the whole story.',
  QG15: 'C) You would speak into them. What you see in them, what you sense God is saying about them.',
  QG16: 'C) You pray until you sense something specific, then you act on it.',
  QG17: 'C) You love them well, openly, and without agenda. The life you live is the argument.',
  QG18: 'B) You give to it. Your money goes where your concern goes.',
  QG19: 'A) You want to know each person before you lead them. You get in the room with them one by one.',
  QG20: 'B) Your words. You say things that give people strength when they are running on empty.',
  QG21: 'B) Time. Who you could serve and what you could do with your hands.',
  QG22: 'C) Pray about it. You need to know it is from God before you act on it.',
  QG23: 'B) Time and presence. You showed up with your hands and your hours when it cost you something.',
  QG24: 'C) Walk with them over time. No rushing. The relationship builds while the faith builds.',
  QG25: 'C) Walking beside whoever has to make the hard call. You are not the decision-maker, but you want to be there while they decide.',

  // Set H Manifestation Gifts (QH1-QH20): submission idx 211-230
  QH1:  'A. Receiving a sudden insight that brought clarity to a confusing situation for someone else. [Word of Wisdom]',
  QH2:  'B. You suddenly know a fact about their life or history that they had not shared with you. [Word of Knowledge]',
  QH3:  'C. You feel led to declare a specific word for the room or a specific person. [Prophecy]',
  QH4:  'A. Believing for outcomes that seem impossible until they happen. [Gift of Faith]',
  QH5:  'C. Holding the faith that pulls the breakthrough in. [Gift of Faith]',
  QH6:  'A. You spoke a word over someone and it shifted their direction. [Prophecy]',
  QH7:  'C. Receive an unshakable conviction about something coming. [Gift of Faith]',
  QH8:  'C. See the spirit operating behind the conflict. [Discerning of Spirits]',
  QH9:  'C. A word spoken that aligned with what someone needed to hear. [Prophecy]',
  QH10: 'B. Sense what spiritual influence is operating in their life. [Discerning of Spirits]',
  QH11: 'D. Speaking out the wisdom that comes from above in the moment. [Word of Wisdom]',
  QH12: 'A. To hold faith for an outcome that seems impossible. [Gift of Faith]',
  QH13: 'B. Speaking a prophetic word that was confirmed in the person\'s life. [Prophecy]',
  QH14: 'C. Operates in faith that pulls the room into expectation. [Gift of Faith]',
  QH15: 'C. A wisdom that breaks the spiritual stronghold underneath the symptom. [Word of Wisdom]',
  QH16: 'C. Prophecy that turned out accurate. [Prophecy]',
  QH17: 'C. To stand in faith for them when they cannot stand for themselves. [Gift of Faith]',
  QH18: 'D. Pray in tongues until you sense a shift. [Different Kinds of Tongues]',
  QH19: 'C. Word of Knowledge (knowing what could not be naturally known). [Word of Knowledge]',
  QH20: 'C. A faith-filled declaration over their life. [Gift of Faith]',

  // Set I Fruit of the Spirit (QI1-QI18): submission idx 231-248
  QI1:  'D. Almost Always',
  QI2:  'D. Almost Always',
  QI3:  'B. Sometimes',
  QI4:  'D. Almost Always',
  QI5:  'C. Often',
  QI6:  'D. Almost Always',
  QI7:  'C. Often',
  QI8:  'D. Almost Always',
  QI9:  'D. Almost Always',
  QI10: 'D. Almost Always',
  QI11: 'D. Almost Always',
  QI12: 'D. Almost Always',
  QI13: 'D. Almost Always',
  QI14: 'D. Almost Always',
  QI15: 'D. Almost Always',
  QI16: 'C. Often',
  QI17: 'D. Almost Always',
  QI18: 'D. Almost Always',
};

// =======================================================================
// Matching logic
// =======================================================================

function normalize(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^[a-d][\.\)]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 '"]/g, '')
    .trim();
}

function findMatchingOption(answerText, options) {
  const na = normalize(answerText);
  for (const opt of options) {
    if (normalize(opt) === na) return opt;
  }
  // Substring either way
  for (const opt of options) {
    const no = normalize(opt);
    if (no && na && (no.includes(na) || na.includes(no))) return opt;
  }
  // Try matching first 30 chars
  if (na.length >= 20) {
    for (const opt of options) {
      const no = normalize(opt);
      if (no.startsWith(na.slice(0, 25)) || na.startsWith(no.slice(0, 25))) return opt;
    }
  }
  return null;
}

// =======================================================================
// Build output
// =======================================================================

const customFields = [];
const warnings = [];

for (const [uuid, q] of Object.entries(QUESTION_MAP)) {
  let lookupKey;
  let answer;
  if (q.qnum != null) {
    lookupKey = `Q${q.qnum}`;
    answer = PESHON_ANSWERS_BY_QNUM[q.qnum];
  } else if (q.conditionalKey) {
    lookupKey = q.conditionalKey.replace('srConditional_', '');
    answer = PESHON_ANSWERS_BY_CONDITIONAL[lookupKey];
  } else {
    warnings.push(`uuid=${uuid}: question-map entry has neither qnum nor conditionalKey`);
    continue;
  }

  if (answer == null) {
    warnings.push(`${lookupKey} (uuid=${uuid}): no answer in PESHON_ANSWERS`);
    continue;
  }

  const matched = findMatchingOption(answer, q.options);
  if (!matched) {
    warnings.push(`${lookupKey} (uuid=${uuid}): no option match for "${answer}". Options: ${JSON.stringify(q.options).slice(0, 200)}`);
    continue;
  }

  customFields.push({ id: uuid, field_value: matched, _meta: { key: lookupKey, answer } });
}

// =======================================================================
// Output + report
// =======================================================================

const outputPath = path.join(__dirname, '..', 'lib', 'peshon-recovery-data.json');
fs.writeFileSync(outputPath, JSON.stringify(customFields, null, 2) + '\n');

console.log(`Mapped ${customFields.length} question fields.`);
console.log(`Total entries in QUESTION_MAP: ${Object.keys(QUESTION_MAP).length}`);
console.log(`Warnings: ${warnings.length}`);
for (const w of warnings) console.log('  ! ' + w);

console.log(`\nWrote ${outputPath}`);
