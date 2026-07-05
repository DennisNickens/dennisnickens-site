// /lib/trilens-renderer.js
// Blueprint renderer for TriLens scoring output. Ported from the
// validated blueprintRenderer.service.js (Postgres scaffold), adapted
// for serverless: no database, no Puppeteer. Takes a scoring result
// from lib/trilens-scoring.js plus contact info and returns the
// enriched Blueprint data and rendered HTML.
//
// All customer-facing names follow the SR Pillar Naming Canon.

'use strict';

const { PILLAR_ORDER, PILLAR_TYPES } = require('./trilens-scoring.js');

const DISPLAY_NAMES = {
  core: 'Behavior Profile',
  currency: 'Connection Currency',
  channel: 'Learning Channel',
  compass: 'Spiritual Compass',
  partnership: 'Partnership Dynamics',
  family: 'Family Dynamics',
  career: 'Career Dynamics',
  ministry: 'Ministry Dynamics',
};

const TIER_CONFIG = {
  light: {
    pillars: ['core'],
    includeInsights: true,
    // Blend gating: Light shows the primary type only.
    includeSecondary: false,
    includeDualProfiles: false,
    includeCrossPillarMatrix: false,
    includeRecommendations: false,
    includeGrowthAreas: false,
    includeIdealPartners: false,
    include30DayPlan: false,
    includeSpiritualGifts: false,
    includeLegacyPlanning: false,
  },
  medium: {
    pillars: ['core', 'currency', 'channel', 'compass'],
    includeInsights: true,
    // Medium unlocks primary + secondary (Dual Profile) on its 4 pillars.
    includeSecondary: true,
    includeDualProfiles: true,
    includeCrossPillarMatrix: false,
    includeRecommendations: true,
    includeGrowthAreas: true,
    includeIdealPartners: true,
    include30DayPlan: true,
    includeSpiritualGifts: false,
    includeLegacyPlanning: false,
  },
  deep: {
    pillars: PILLAR_ORDER,
    includeInsights: true,
    // Deep gets the full blend on all 8 pillars plus the matrix.
    includeSecondary: true,
    includeDualProfiles: true,
    includeCrossPillarMatrix: true,
    includeRecommendations: true,
    includeGrowthAreas: true,
    includeIdealPartners: true,
    include30DayPlan: true,
    includeSpiritualGifts: true,
    includeLegacyPlanning: true,
  },
};

// ---------------------------------------------------------------
// The 16 SR Behavior Archetypes (canonical names, locked canon).
// Voice: direct, second person, practical, faith-rooted but never
// preachy. No em dashes.
// ---------------------------------------------------------------

const ARCHETYPE_DETAILS = {
  'The Commander': {
    description: 'Pure decisive action. You are direct, results-driven, and you take the wheel when others hesitate. People may not always agree with you, but they always know where you stand, and when things fall apart you are the one they look to.',
    strengths: ['Decisive under pressure', 'Clear, direct communication', 'Relentless follow-through on goals'],
    challenges: ['Listening fully before acting', 'Softening delivery without losing honesty', 'Letting others lead sometimes'],
    idealPartners: ['The Relator', 'The Diplomat', 'The Caretaker'],
    growthAreas: ['Patience with slower processors', 'Asking instead of telling', 'Rest without guilt'],
  },
  'The Organizer': {
    description: 'Pure precision and depth. You are analytical, thorough, and you build things that last. Where others see good enough, you see what is missing, and your standards protect everyone around you from sloppy outcomes.',
    strengths: ['Accuracy and attention to detail', 'Systems that outlive the moment', 'Calm, well-reasoned judgment'],
    challenges: ['Perfectionism that stalls progress', 'Trusting others with the details', 'Expressing warmth as readily as correctness'],
    idealPartners: ['The Energizer', 'The Champion', 'The Connector'],
    growthAreas: ['Shipping before it feels perfect', 'Leading with encouragement', 'Flexibility when plans change'],
  },
  'The Relator': {
    description: 'Pure stability and loyalty. You are patient, reliable, and protective of the people you love. You are the steady ground others build on, and your consistency is a form of love that louder people cannot fake.',
    strengths: ['Deep loyalty and dependability', 'Patience in conflict', 'Making people feel safe'],
    challenges: ['Saying no and holding limits', 'Voicing your own needs', 'Moving quickly when change demands it'],
    idealPartners: ['The Commander', 'The Visionary', 'The Strategist'],
    growthAreas: ['Self-advocacy', 'Comfort with healthy conflict', 'Initiating instead of accommodating'],
  },
  'The Energizer': {
    description: 'Pure energy and persuasion. You are magnetic, optimistic, and you draw people in without trying. Rooms change when you walk into them, and your gift is making people believe things can be better than they are.',
    strengths: ['Contagious optimism', 'Winning people over', 'Momentum and enthusiasm'],
    challenges: ['Following through after the excitement fades', 'Depth over breadth in relationships', 'Sitting with hard emotions instead of performing past them'],
    idealPartners: ['The Organizer', 'The Sage', 'The Sentinel'],
    growthAreas: ['Consistency', 'Listening without planning your reply', 'Finishing what you start'],
  },
  'The Visionary': {
    description: 'Bold leader who inspires followers. You combine decisive drive with real charisma. You do not just see the future, you sell it, and people sign up for missions they never would have attempted alone because you called them into it.',
    strengths: ['Casting compelling vision', 'Rallying people to a cause', 'Bold decisions with conviction'],
    challenges: ['Details and follow-through', 'Overpromising in the excitement', 'Slowing down for people still catching up'],
    idealPartners: ['The Sage', 'The Caretaker', 'The Organizer'],
    growthAreas: ['Execution discipline', 'Under-promising and over-delivering', 'Valuing maintenance as much as launch'],
  },
  'The Anchor': {
    description: 'Decisive but rooted. You act firmly without bulldozing. You carry authority and steadiness in the same frame, which makes you the person people trust in a storm: strong enough to decide, grounded enough not to panic.',
    strengths: ['Firm decisions without drama', 'Steadiness under pressure', 'Protecting people while moving them forward'],
    challenges: ['Appearing immovable when you are actually listening', 'Absorbing too much weight silently', 'Asking for support'],
    idealPartners: ['The Energizer', 'The Storyteller', 'The Diplomat'],
    growthAreas: ['Expressing what you carry', 'Delegating real weight, not just tasks', 'Celebrating wins before the next climb'],
  },
  'The Strategist': {
    description: 'Decisive and analytical. You act only after the math checks out, and then you act without flinching. You see three moves ahead, and your decisions look risky to others only because they cannot see the calculations you already ran.',
    strengths: ['Seeing moves ahead of everyone else', 'Decisions backed by real analysis', 'Composure in complexity'],
    challenges: ['Impatience with emotional reasoning', 'Coming across as cold when you are just focused', 'Over-optimizing what needs a human touch'],
    idealPartners: ['The Relator', 'The Connector', 'The Diplomat'],
    growthAreas: ['Leading with empathy before logic', 'Explaining your reasoning out loud', 'Letting some decisions be felt, not solved'],
  },
  'The Champion': {
    description: 'Charismatic warrior. You inspire people, then lead them into the fight. Your energy is not just enthusiasm, it is courage that spreads. People do brave things around you because you make brave feel normal.',
    strengths: ['Courage that lifts a whole room', 'Persuasion with backbone', 'Turning belief into action'],
    challenges: ['Picking battles instead of fighting all of them', 'Hearing caution as commitment, not cowardice', 'Recovery time between fights'],
    idealPartners: ['The Organizer', 'The Sage', 'The Caretaker'],
    growthAreas: ['Strategic patience', 'Valuing quiet contributors', 'Rest as a discipline'],
  },
  'The Connector': {
    description: 'Warm relationship builder. You are a steady presence with magnetic energy. You do not network, you genuinely bond, and the web of trust you build becomes the infrastructure everything else in your life runs on.',
    strengths: ['Genuine warmth that builds trust fast', 'Loyalty people can feel', 'Bringing the right people together'],
    challenges: ['Overextending for others', 'Avoiding necessary confrontation', 'Losing yourself in everyone else’s needs'],
    idealPartners: ['The Strategist', 'The Commander', 'The Master Builder'],
    growthAreas: ['Boundaries without guilt', 'Direct conversations early', 'Investing in yourself as intentionally as you invest in others'],
  },
  'The Storyteller': {
    description: 'Persuasive and thoughtful. You make complex ideas land emotionally. You are the translator between the head and the heart, and when you speak, people do not just understand the idea, they feel why it matters.',
    strengths: ['Making ideas unforgettable', 'Reading a room and meeting it', 'Depth wrapped in warmth'],
    challenges: ['Polishing the message instead of delivering it', 'Needing the response to feel validated', 'Analysis dressed up as preparation'],
    idealPartners: ['The Anchor', 'The Sentinel', 'The Commander'],
    growthAreas: ['Speaking before it is perfect', 'Letting silence do some of the work', 'Measuring impact by change, not applause'],
  },
  'The Sentinel': {
    description: 'Steady but ready to act. You are the calm watchman who moves decisively when it counts. Most days you hold the perimeter quietly, and the people you protect may never know how many problems never reached them because of you.',
    strengths: ['Vigilance without anxiety', 'Decisive action at the right moment', 'Unshakable reliability'],
    challenges: ['Being under-appreciated because prevention is invisible', 'Speaking up before the threshold is crossed', 'Letting people in behind the watch post'],
    idealPartners: ['The Energizer', 'The Storyteller', 'The Dreamer types who need your ground'],
    growthAreas: ['Naming your contributions', 'Acting on opportunity, not just threat', 'Sharing the watch'],
  },
  'The Diplomat': {
    description: 'Steady and warm. You bridge divides and smooth conflicts. You can sit between two people who cannot stand each other and leave them both feeling heard, and that is not a trick, it is a calling.',
    strengths: ['De-escalating conflict', 'Making every side feel heard', 'Patience that outlasts tension'],
    challenges: ['Burying your own position to keep the peace', 'Peace-keeping when the moment needs truth-telling', 'Decision fatigue from holding every perspective'],
    idealPartners: ['The Commander', 'The Strategist', 'The Anchor'],
    growthAreas: ['Having a side and saying so', 'Letting some conflicts happen', 'Deciding faster'],
  },
  'The Caretaker': {
    description: 'Steady and precise. You nurture with discipline. Your care does not just comfort, it actually fixes things, because you pair a soft heart with exacting standards. People in your care are both loved and well managed.',
    strengths: ['Care that produces real outcomes', 'Reliability in the details of people’s lives', 'Quiet, consistent service'],
    challenges: ['Care that slides into control', 'Resentment when care is not reciprocated', 'Receiving help as readily as you give it'],
    idealPartners: ['The Visionary', 'The Champion', 'The Energizer'],
    growthAreas: ['Letting people struggle productively', 'Asking for care out loud', 'Serving from overflow, not depletion'],
  },
  'The Master Builder': {
    description: 'Precise and decisive. You are the methodical executor. You do not chase inspiration, you build systems that do not depend on it, and what you construct works long after flashier efforts have collapsed.',
    strengths: ['Execution that compounds', 'Quality that holds under load', 'Turning plans into finished reality'],
    challenges: ['Dismissing what cannot be measured', 'Working past the point of diminishing returns', 'Impatience with people who build differently'],
    idealPartners: ['The Connector', 'The Energizer', 'The Diplomat'],
    growthAreas: ['Building relationships with the rigor you build systems', 'Flexibility as a feature, not a flaw', 'Celebrating the build, not just inspecting it'],
  },
  'The Curator': {
    description: 'Precise and warm. You are the thoughtful teacher. You collect what is true and beautiful and useful, and then you hand it to people at exactly the moment they need it. Your precision serves your warmth, not the other way around.',
    strengths: ['Teaching that actually transfers', 'Taste and discernment', 'Warmth backed by real substance'],
    challenges: ['Hoarding knowledge until it feels complete', 'Being overlooked by louder voices', 'Perfectionism about how things are shared'],
    idealPartners: ['The Champion', 'The Visionary', 'The Commander'],
    growthAreas: ['Sharing work in progress', 'Claiming the room when it is yours', 'Volume as an act of service'],
  },
  'The Sage': {
    description: 'Precise and patient. You carry deep wisdom that compounds over time. You are not in a hurry because you have learned that truth does not expire, and the people who slow down long enough to really hear you never forget what you said.',
    strengths: ['Wisdom people return to for years', 'Judgment that improves with pressure', 'Depth without ego'],
    challenges: ['Waiting to be asked instead of offering', 'Undervaluing your own counsel', 'Isolation disguised as contentment'],
    idealPartners: ['The Energizer', 'The Visionary', 'The Champion'],
    growthAreas: ['Offering wisdom unprompted', 'Staying connected between the big conversations', 'Letting people see your process, not just your conclusions'],
  },
};

// Safety net; with the canonical blend rule every profile resolves to one
// of the 16, so this should rarely fire.
const DEFAULT_ARCHETYPE = {
  description: 'You are a one-of-a-kind combination of strengths that does not fit a single pattern. That is not a limitation. It is range.',
  strengths: ['Unique perspective', 'Adaptability', 'Versatility across contexts'],
  challenges: ['Finding your clearest lane', 'Communicating your style to others'],
  idealPartners: [],
  growthAreas: ['Self-awareness', 'Intentional communication', 'Naming your core identity'],
};

// ---------------------------------------------------------------
// Type descriptions, all 8 pillars, canon names only.
// ---------------------------------------------------------------

const TYPE_DESCRIPTIONS = {
  core: {
    commander: 'You lead with clarity and conviction. You naturally take charge, set direction, and move people toward goals with decisive energy.',
    relator: 'You lead with warmth and steadiness. Building trust and making people feel safe is your superpower, and it is what lets relationships around you go deep.',
    organizer: 'You lead with structure and precision. Where others see chaos, you see a sequence, and you have the discipline to execute it.',
    energizer: 'You lead with enthusiasm and momentum. Your energy is contagious and your optimism moves people to act.',
  },
  currency: {
    spoken: 'Your primary currency is Spoken. Verbal affirmation, encouragement, and appreciation said out loud are how care lands deepest for you.',
    presence: 'Your primary currency is Presence. Undivided, intentional time is how you give and receive care most deeply. When someone chooses to be fully with you, you feel it at the core.',
    contact: 'Your primary currency is Contact. Physical closeness, a hand on the shoulder, a real hug, communicates safety and connection to you in ways words cannot.',
    action: 'Your primary currency is Action. You feel most cared for when someone shows up and does something for you without being asked. You give the same way: by doing.',
    tokens: 'Your primary currency is Tokens. Thoughtful gifts carry weight for you, not because of the object, but because of what it proves: someone was thinking of you and went out of their way.',
  },
  channel: {
    sight: 'Your Learning Channel is Sight. You process and retain best when you can see it: diagrams, written layouts, and visual demonstration.',
    sound: 'Your Learning Channel is Sound. You learn best through listening and conversation, and you often think out loud. What you hear stays with you.',
    word: 'Your Learning Channel is Word. Reading and writing are how you process the world. You take notes, you re-read, and you express yourself best on the page.',
    touch: 'Your Learning Channel is Touch. You learn by doing. Concepts are not real for you until your hands have tried them.',
  },
  compass: {
    faith: 'Your Spiritual Compass points to faith. Your beliefs and sense of calling are the lens through which you navigate every major decision.',
    family: 'Your Spiritual Compass points to family. The people you call yours are your deepest motivation, and your biggest decisions flow from your commitment to them.',
    career: 'Your Spiritual Compass points to career. Purpose-driven work is central to your identity, and you are energized by building something that matters and lasts.',
    community: 'Your Spiritual Compass points to community. You feel most alive when you belong to and contribute to something larger than yourself.',
  },
  partnership: {
    initiator: 'In Partnership Dynamics you are an Initiator. You pursue, you plan, you create direction. Partners feel chosen and invested in because you move first.',
    responder: 'In Partnership Dynamics you are a Responder. You read your partner well and meet them exactly where they are. You love people in the specific way they need to be loved.',
    balancer: 'In Partnership Dynamics you are a Balancer. You keep investment mutual and the dynamic fair and sustainable. You catch imbalances other people never notice.',
    adapter: 'In Partnership Dynamics you are an Adapter. You bend without breaking and adjust without resentment. Your flexibility is a genuine gift to any relationship.',
  },
  family: {
    nurturer: 'In Family Dynamics you are the Nurturer. You tend the emotional atmosphere of your home, and your family knows they are loved because you make it undeniable.',
    provider: 'In Family Dynamics you are the Provider. Stability, security, and practical foundations are your domain. Your household rests easier because of what you carry.',
    peacemaker: 'In Family Dynamics you are the Peacemaker. You hold the relational space of the home together, de-escalating conflict and restoring harmony when things get hard.',
    director: 'In Family Dynamics you are the Director. You set the tone, establish expectations, and move your family toward something. Your home has direction because you lead it.',
  },
  career: {
    visionary: 'In Career Dynamics you have a Visionary work style. You see possibilities others miss and articulate futures that inspire action.',
    executor: 'In Career Dynamics you have an Executor work style. You get things done. Where others discuss, you ship, and your track record speaks for itself.',
    collaborator: 'In Career Dynamics you have a Collaborator work style. You build the trust and alignment that make great work possible. The how matters to you as much as the what.',
    specialist: 'In Career Dynamics you have a Specialist work style. You go deep where others stay shallow, and your expertise raises the standard of everything you touch.',
  },
  ministry: {
    teacher: 'In Ministry Dynamics you are a Teacher. You equip people with truth they can use, and your greatest impact comes through what others learn from you.',
    encourager: 'In Ministry Dynamics you are an Encourager. You speak life into people at exactly the right moment, and your words change trajectories.',
    giver: 'In Ministry Dynamics you are a Giver. Your generosity is a lifestyle. You meet needs others walk past, and you do it without keeping score.',
    leader: 'In Ministry Dynamics you are a Leader. You take responsibility for direction, create structure out of chaos, and call people into their purpose.',
  },
};

function getTypeDescription(pillar, typeName) {
  const p = TYPE_DESCRIPTIONS[(pillar || '').toLowerCase()];
  return (p && p[typeName]) || 'A distinct strength that shapes how you engage with the world.';
}

// ---------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------

function generateInsights(scores, pillars, config) {
  const insights = {};
  for (const pillar of pillars) {
    const s = scores[pillar];
    if (!s) continue;
    insights[pillar] = {
      displayName: DISPLAY_NAMES[pillar],
      primary: {
        type: s.primaryType,
        percentage: s.percentages[s.primaryType],
        description: getTypeDescription(pillar, s.primaryType),
      },
      // Blend gating: Light tier sees the primary type only.
      secondary: (config.includeSecondary && s.secondaryType) ? {
        type: s.secondaryType,
        percentage: s.percentages[s.secondaryType],
        description: getTypeDescription(pillar, s.secondaryType),
      } : null,
      dualProfile: config.includeDualProfiles ? (s.dualProfile || null) : null,
      percentages: s.percentages,
      flags: s.flags,
    };
  }
  return insights;
}

// ---------------------------------------------------------------
// Cross-Pillar Matrix (Deep tier). Every pillar's primary against
// every other, with the Dual Profile on the diagonal. The four
// highlight pairings get a written read.
// ---------------------------------------------------------------

function generateCrossPillarMatrix(scores) {
  const pillars = PILLAR_ORDER.filter(p => scores[p]);
  const cells = {};
  for (const row of pillars) {
    cells[row] = {};
    for (const col of pillars) {
      if (row === col) {
        cells[row][col] = scores[row].dualProfile ? scores[row].dualProfile.code : '';
      } else {
        cells[row][col] = capitalize(scores[row].primaryType) + ' x ' + capitalize(scores[col].primaryType);
      }
    }
  }

  const highlights = [];
  const p = k => scores[k] ? capitalize(scores[k].primaryType) : null;

  if (p('core') && p('currency')) {
    highlights.push({
      pair: 'Behavior x Currency',
      text: 'Your ' + p('core') + ' wiring decides how you act, and your ' + p('currency') + ' currency decides how you love. When these two pull in different directions, people experience your actions without feeling your care. Lead with the currency first, then the action.',
    });
  }
  if (p('core') && p('compass')) {
    highlights.push({
      pair: 'Behavior x Compass',
      text: 'Your ' + p('core') + ' style is the engine and your ' + p('compass') + ' compass is the steering. Seasons where you feel busy but empty are usually the engine running without the steering. Check the compass before adding more speed.',
    });
  }
  if (p('partnership') && p('family')) {
    highlights.push({
      pair: 'Partnership x Family',
      text: 'You show up as ' + p('partnership') + ' in romance and ' + p('family') + ' at home. Where those two roles agree, home feels effortless. Where they disagree is where your closest people get different versions of you, and naming that difference out loud is the fix.',
    });
  }
  if (p('career') && p('ministry')) {
    highlights.push({
      pair: 'Career x Ministry',
      text: 'Your ' + p('career') + ' work style and your ' + p('ministry') + ' way of serving draw from the same well. When work drains you, serve. When serving feels like work, rest. The two are designed to recharge each other, not compete.',
    });
  }

  return { pillars, cells, highlights };
}

function generateRecommendations(scores, archetype, details) {
  const currency = scores.currency;
  const recs = [
    { category: 'Leverage Your Strengths', items: details.strengths || [] },
    { category: 'Watch Your Blind Spots', items: details.challenges || [] },
  ];
  const comms = [
    'Lead with your ' + (archetype || 'natural') + ' wiring, but check that the people around you feel heard, not just directed.',
  ];
  if (currency) {
    comms.push('Your primary Connection Currency is ' + capitalize(currency.primaryType) + '. When a relationship feels off, check whether this currency is being spoken and received before assuming something bigger is broken.');
  }
  recs.push({ category: 'Communication Strategy', items: comms });
  recs.push({
    category: 'Relationship Investment',
    items: [
      'Invest most intentionally in relationships where your growth areas show up. Those relationships will stretch you the furthest.',
      'Look for people who are strong where you are still growing. Complement beats mirror.',
    ],
  });
  return recs;
}

function generate30DayPlan(scores, details) {
  const strength = (details.strengths && details.strengths[0]) || 'your core strength';
  const challenge = (details.challenges && details.challenges[0]) || 'your primary challenge';
  const growthArea = (details.growthAreas && details.growthAreas[0]) || 'self-awareness';
  const currencyLabel = scores.currency ? capitalize(scores.currency.primaryType) : 'your Connection Currency';
  const compassLabel = scores.compass ? scores.compass.primaryType : 'your core value';
  const coreLabel = scores.core ? capitalize(scores.core.primaryType) : 'your behavior style';

  return [
    { day: 1, title: 'Know Your Starting Point', action: 'Write down three ways "' + strength + '" showed up in your relationships this past month. Be specific: what did you do, and what happened because of it?' },
    { day: 3, title: 'Name the Gap', action: 'Reflect on "' + challenge + '". Identify one relationship where it has created friction and write what you would do differently operating from your best self.' },
    { day: 7, title: 'Speak Your Currency', action: 'Have a direct conversation with someone important to you about ' + currencyLabel + ' as your Connection Currency. Give one specific example, then ask what theirs is.' },
    { day: 14, title: 'Align Your Compass', action: 'Audit one area of your life against your ' + compassLabel + ' priority. Does your time, energy, and money actually reflect what you say matters most? Make one adjustment this week.' },
    { day: 21, title: 'Practice ' + coreLabel + ' With Intention', action: 'Pick one relationship and apply your Blueprint deliberately: lead from your ' + coreLabel + ' wiring while working on "' + growthArea + '". Journal what you notice.' },
    { day: 30, title: 'Measure the Distance', action: 'Review your Day 1 notes. What shifted? Pick the one behavior you want to keep permanently and commit to it in writing.' },
  ];
}

function generateSpiritualGifts(scores) {
  const m = scores.ministry;
  if (!m) return null;
  return {
    primaryGift: m.primaryType,
    primaryPercentage: m.percentages[m.primaryType],
    secondaryGift: m.secondaryType,
    description: getTypeDescription('ministry', m.primaryType),
  };
}

function generateLegacyPlanning(scores, archetype, details) {
  const strengths = details.strengths || [];
  const growthAreas = details.growthAreas || [];
  return {
    visionStatement: 'As ' + (archetype || 'who you are') + ', your legacy will be built through ' + (strengths[0] || 'your strengths').toLowerCase() + '. The people you touch will carry the mark of how you showed up for them.',
    nextSteps: [
      'Identify one person to mentor or invest in using "' + (strengths[0] || 'your strengths') + '".',
      'Treat "' + (growthAreas[0] || 'your primary growth area') + '" as a long-term commitment, not a one-time fix.',
      'Write what you want said about you at the end of your life, then work backwards from it.',
    ],
  };
}

function capitalize(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}

function enrichBlueprintData(scoring, contact) {
  const config = TIER_CONFIG[scoring.tier] || TIER_CONFIG.light;
  const details = ARCHETYPE_DETAILS[scoring.archetype] || DEFAULT_ARCHETYPE;

  const data = {
    tier: scoring.tier,
    srCode: scoring.srCode,
    archetype: scoring.archetype,
    archetypeDetails: details,
    displayName: (contact && contact.name) || '',
    generatedAt: new Date().toISOString(),
    scores: scoring.scores,
    engineVersion: scoring.engineVersion,
  };

  if (config.includeInsights) data.insights = generateInsights(scoring.scores, config.pillars, config);
  if (config.includeCrossPillarMatrix) data.crossPillarMatrix = generateCrossPillarMatrix(scoring.scores);
  if (config.includeRecommendations) data.recommendations = generateRecommendations(scoring.scores, scoring.archetype, details);
  if (config.includeGrowthAreas) data.growthAreas = details.growthAreas || [];
  if (config.includeIdealPartners) data.idealPartners = details.idealPartners || [];
  if (config.include30DayPlan) data.plan30Day = generate30DayPlan(scoring.scores, details);
  if (config.includeSpiritualGifts) data.spiritualGifts = generateSpiritualGifts(scoring.scores);
  if (config.includeLegacyPlanning) data.legacyPlanning = generateLegacyPlanning(scoring.scores, scoring.archetype, details);

  return data;
}

// ---------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replaceTemplate(template, replacements) {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(key).join(String(value == null ? '' : value));
  }
  return out;
}

const TYPE_LABELS = {
  spoken: 'Spoken', presence: 'Presence', contact: 'Contact', action: 'Action', tokens: 'Tokens',
  sight: 'Sight', sound: 'Sound', word: 'Word', touch: 'Touch',
};

function typeLabel(t) { return TYPE_LABELS[t] || capitalize(t); }

function renderBars(percentages) {
  const sorted = Object.entries(percentages).sort(([, a], [, b]) => b - a);
  return sorted.map(([type, pct]) =>
    '<div class="bar-row"><span class="type-label">' + esc(typeLabel(type)) + '</span>'
    + '<div class="bar-container"><div class="bar-segment" style="width:' + Math.round(pct) + '%"></div></div>'
    + '<span class="percentage">' + Math.round(pct) + '%</span></div>'
  ).join('');
}

function renderPillarSections(insights) {
  return Object.entries(insights || {}).map(([pillar, ins]) =>
    '<div class="pillar-section">'
    + '<h3 class="pillar-title">' + esc(ins.displayName) + '</h3>'
    + (ins.dualProfile ? '<div class="dual-badge">' + esc(ins.dualProfile.display) + '</div>' : '')
    + '<div class="primary-type">' + esc(typeLabel(ins.primary.type)) + ' <span class="percentage">' + Math.round(ins.primary.percentage) + '%</span></div>'
    + renderBars(ins.percentages)
    + '<p class="analysis">' + esc(ins.primary.description) + '</p>'
    + (ins.secondary ? '<p class="analysis secondary">Your secondary lean is ' + esc(typeLabel(ins.secondary.type)) + ' at ' + Math.round(ins.secondary.percentage) + '%. ' + esc(ins.secondary.description) + '</p>' : '')
    + '</div>'
  ).join('\n');
}

function renderMatrix(matrix) {
  if (!matrix) return '';
  const head = '<tr><th></th>' + matrix.pillars.map(p => '<th>' + esc(DISPLAY_NAMES[p]) + '</th>').join('') + '</tr>';
  const rows = matrix.pillars.map(row =>
    '<tr><th>' + esc(DISPLAY_NAMES[row]) + '</th>'
    + matrix.pillars.map(col => '<td class="' + (row === col ? 'diag' : '') + '">' + esc(matrix.cells[row][col]) + '</td>').join('')
    + '</tr>'
  ).join('');
  const highlights = matrix.highlights.map(h =>
    '<div class="matrix-highlight"><strong>' + esc(h.pair) + '</strong><p>' + esc(h.text) + '</p></div>'
  ).join('');
  return '<div class="matrix-scroll"><table class="matrix">' + head + rows + '</table></div>' + highlights;
}

function renderToHTML(data) {
  const recsHTML = (data.recommendations || []).map(r =>
    '<div class="recommendation-block"><h4>' + esc(r.category) + '</h4><ul>'
    + r.items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></div>'
  ).join('');

  const growthHTML = (data.growthAreas || []).length
    ? '<ul>' + data.growthAreas.map(g => '<li>' + esc(g) + '</li>').join('') + '</ul>' : '';

  const partnersHTML = (data.idealPartners || []).join(', ');

  const planHTML = (data.plan30Day || []).map(m =>
    '<div class="milestone"><span class="day-label">Day ' + m.day + ': ' + esc(m.title) + '</span><p>' + esc(m.action) + '</p></div>'
  ).join('');

  const giftsHTML = data.spiritualGifts
    ? '<p><strong>' + esc(typeLabel(data.spiritualGifts.primaryGift)) + '</strong></p><p>' + esc(data.spiritualGifts.description) + '</p>' : '';

  const legacyHTML = data.legacyPlanning
    ? '<p>' + esc(data.legacyPlanning.visionStatement) + '</p><ul>'
      + data.legacyPlanning.nextSteps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>'
    : '';

  const optional = (label, cls, inner) => inner
    ? '<div class="' + cls + '"><h3>' + label + '</h3>' + inner + '</div>' : '';

  return replaceTemplate(getTemplate(), {
    '{{SR_CODE}}': esc(data.srCode || ''),
    '{{ARCHETYPE}}': esc(data.archetype || 'Your Blueprint'),
    '{{ARCHETYPE_DESCRIPTION}}': esc(data.archetypeDetails.description || ''),
    '{{TIER}}': esc((data.tier || '').toUpperCase()),
    '{{DISPLAY_NAME}}': esc(data.displayName || ''),
    '{{GENERATED_AT}}': esc((data.generatedAt || '').slice(0, 10)),
    '{{PILLAR_SECTIONS}}': renderPillarSections(data.insights),
    '{{RECOMMENDATIONS}}': recsHTML ? '<div class="recommendations-section"><h3>Your Recommendations</h3>' + recsHTML + '</div>' : '',
    '{{GROWTH_AREAS}}': optional('Growth Areas', 'growth-section', growthHTML),
    '{{IDEAL_PARTNERS}}': optional('Archetypes You Pair Well With', 'partners-section', partnersHTML ? '<p>' + esc(partnersHTML) + '</p>' : ''),
    '{{CROSS_PILLAR_MATRIX}}': optional('Your Cross-Pillar Matrix', 'matrix-section', renderMatrix(data.crossPillarMatrix)),
    '{{PLAN_30_DAY}}': optional('Your 30-Day Growth Plan', 'plan-section', planHTML),
    '{{SPIRITUAL_GIFTS}}': optional('Ministry Dynamics: Your Gift', 'plan-section', giftsHTML),
    '{{LEGACY_PLANNING}}': optional('Legacy Planning', 'legacy-section', legacyHTML),
  });
}

function getTemplate() {
  return '<!DOCTYPE html>'
  + '<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
  + '<title>Your Blueprint | Dennis Nickens</title><style>'
  + "@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@300;400;600&display=swap');"
  + "body{font-family:'Inter',sans-serif;background:#0F172A;color:#E2E8F0;margin:0;padding:32px 18px;}"
  + ".sheet{max-width:760px;margin:0 auto;}"
  + "h1,h2,h3,h4{font-family:'Playfair Display',serif;}"
  + '.header{text-align:center;padding:36px 0;border-bottom:2px solid #7C3AED;margin-bottom:28px;}'
  + '.sr-code{font-size:2rem;color:#FFD700;letter-spacing:.18em;}'
  + '.archetype{font-size:1.5rem;color:#A78BFA;margin-top:8px;}'
  + '.meta{font-size:.85rem;color:#94A3B8;margin-top:6px;}'
  + '.description{font-style:italic;color:#CBD5E1;max-width:600px;margin:20px auto 0;line-height:1.7;}'
  + '.pillar-section,.recommendations-section,.growth-section,.partners-section,.plan-section,.legacy-section{margin:26px 0;padding:24px;background:#1E293B;border-radius:10px;break-inside:avoid;}'
  + '.pillar-title{color:#7C3AED;margin:0 0 14px;}'
  + '.primary-type{font-weight:600;font-size:1.05rem;margin-bottom:12px;}'
  + '.percentage{color:#94A3B8;font-size:.9rem;}'
  + '.bar-row{display:flex;align-items:center;gap:10px;margin:6px 0;}'
  + '.type-label{flex:0 0 90px;font-size:.85rem;text-transform:capitalize;}'
  + '.bar-container{flex:1;background:#334155;border-radius:4px;height:8px;overflow:hidden;}'
  + '.bar-segment{height:100%;border-radius:4px;background:linear-gradient(90deg,#7C3AED,#FFD700);}'
  + '.analysis{color:#CBD5E1;line-height:1.7;}'
  + '.analysis.secondary{color:#94A3B8;font-size:.92rem;}'
  + '.recommendation-block{margin-bottom:18px;}'
  + '.recommendation-block h4{color:#A78BFA;margin:0 0 8px;}'
  + 'ul{margin:0;padding-left:20px;line-height:1.8;color:#CBD5E1;}'
  + '.milestone{margin-bottom:18px;}'
  + '.day-label{font-weight:600;color:#A78BFA;display:block;margin-bottom:4px;}'
  + '.dual-badge{display:inline-block;background:rgba(255,215,0,.12);border:1px solid #FFD700;color:#FFD700;border-radius:6px;padding:4px 12px;font-size:.85rem;font-weight:600;margin-bottom:12px;letter-spacing:.06em;}'
  + '.matrix-section{margin:26px 0;padding:24px;background:#1E293B;border-radius:10px;}'
  + '.matrix-scroll{overflow-x:auto;}'
  + '.matrix{border-collapse:collapse;font-size:.72rem;min-width:640px;}'
  + '.matrix th,.matrix td{border:1px solid #334155;padding:6px 8px;text-align:center;color:#CBD5E1;}'
  + '.matrix th{color:#A78BFA;font-family:Inter,sans-serif;font-weight:600;}'
  + '.matrix td.diag{background:rgba(124,58,237,.18);color:#FFD700;font-weight:700;}'
  + '.matrix-highlight{margin-top:16px;}'
  + '.matrix-highlight strong{color:#A78BFA;}'
  + '.matrix-highlight p{color:#CBD5E1;line-height:1.7;margin:6px 0 0;}'
  + '.footer{text-align:center;margin-top:50px;padding-top:20px;border-top:1px solid #334155;font-size:.8rem;color:#64748B;}'
  + '@media print{.pillar-section,.plan-section,.recommendations-section{break-inside:avoid;}body{background:#fff;color:#111;}}'
  + '</style></head><body><div class="sheet">'
  + '<div class="header"><div class="sr-code">{{SR_CODE}}</div>'
  + '<div class="archetype">{{ARCHETYPE}}</div>'
  + '<div class="meta">{{TIER}} Blueprint | {{DISPLAY_NAME}} | {{GENERATED_AT}}</div>'
  + '<p class="description">{{ARCHETYPE_DESCRIPTION}}</p></div>'
  + '{{PILLAR_SECTIONS}}'
  + '{{CROSS_PILLAR_MATRIX}}'
  + '{{RECOMMENDATIONS}}'
  + '{{GROWTH_AREAS}}'
  + '{{IDEAL_PARTNERS}}'
  + '{{PLAN_30_DAY}}'
  + '{{SPIRITUAL_GIFTS}}'
  + '{{LEGACY_PLANNING}}'
  + '<div class="footer">THE BLUEPRINT Assessment<br>Dennis Nickens, Communication &amp; Behavior Consultant | dennisnickens.com</div>'
  + '</div></body></html>';
}

module.exports = {
  enrichBlueprintData,
  renderToHTML,
  getTypeDescription,
  generate30DayPlan,
  replaceTemplate,
  ARCHETYPE_DETAILS,
  DEFAULT_ARCHETYPE,
  TIER_CONFIG,
  DISPLAY_NAMES,
};
