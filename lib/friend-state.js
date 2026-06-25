/* ============================================================
   You Call Yourself A Friend - room state library
   ------------------------------------------------------------
   Backed by Vercel KV (Upstash). Every game session lives in
   one KV record: friend:room:<CODE>. State is read by all
   connected devices via polling and mutated by player actions
   from the host or any player.

   Room state shape:
   {
     code,                        // 4-letter join code
     createdAt,                   // ISO timestamp
     hostId,                      // session id of the host (creator)
     phase,                       // 'lobby' | 'pairing' | 'playing' | 'roundEnd' | 'gameOver'
     players: [
       { id, name, joinedAt }
     ],
     pairs: [
       { id, playerIds: [a, b], score: 0 }
     ],
     pendingPicks: { playerId: pickedPartnerId },  // pairing handshakes
     cap: 25,                     // race finish line
     // Game loop fields fill in once the host starts:
     round: 0,
     turn: 0,
     turnOrder: [],               // player ids in turn order for the round
     currentSubjectId: null,
     currentCardId: null,
     subjectAnswer: null,
     partnerGuess: null,
     winnerPairId: null,
     deck: [],                    // shuffled card ids
     deckPos: 0,
     updatedAt
   }
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const CARDS = require('../games/friend/cards.json');

const ROOM_TTL_SECONDS = 8 * 60 * 60;  // rooms auto-expire after 8 hours

// Build a fast id -> card lookup once at module load
const CARDS_BY_ID = {};
(CARDS.cards || []).forEach(function (c) { CARDS_BY_ID[c.id] = c; });

// Fisher-Yates shuffle (returns a new array)
function shuffle(arr) {
  var out = arr.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

function findPairByPlayerId(pid, pairs) {
  return (pairs || []).find(function (pr) { return pr.playerIds.indexOf(pid) !== -1; });
}

// 4-letter room code, no ambiguous chars (no O/0, no I/1)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  var bytes = crypto.randomBytes(4);
  var s = '';
  for (var i = 0; i < 4; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return s;
}

function newSessionId() {
  return crypto.randomBytes(12).toString('base64url');
}

function newPairId() {
  return 'pair_' + crypto.randomBytes(4).toString('base64url');
}

async function getRoom(code) {
  if (!code) return null;
  return await kv.get('friend:room:' + String(code).toUpperCase());
}

async function saveRoom(room) {
  if (!room || !room.code) throw new Error('saveRoom: missing room.code');
  room.updatedAt = new Date().toISOString();
  await kv.set('friend:room:' + room.code, room, { ex: ROOM_TTL_SECONDS });
  return room;
}

// Player gender is a required profile field (Male / Female only, per spec).
// It gates which option pool gendered Choice+Explain cards serve, so it must
// be present and valid for every player. Persisted on the player record so it
// survives reconnects.
function normalizeGender(g) {
  var v = String(g || '').trim().toLowerCase();
  return (v === 'male' || v === 'female') ? v : null;
}

async function createRoom({ hostName, gender }) {
  var g = normalizeGender(gender);
  if (!g) return { ok: false, error: 'invalid_gender' };
  // Try a few times to land a code that isn't already taken.
  for (var attempt = 0; attempt < 8; attempt++) {
    var code = newRoomCode();
    var existing = await kv.get('friend:room:' + code);
    if (existing) continue;
    var hostId = newSessionId();
    var room = {
      code: code,
      createdAt: new Date().toISOString(),
      hostId: hostId,
      phase: 'lobby',
      players: [{
        id: hostId,
        name: String(hostName || 'Host').slice(0, 32),
        gender: g,
        joinedAt: new Date().toISOString(),
        isHost: true
      }],
      pairs: [],
      pendingPicks: {},
      cap: 25,
      round: 0,
      turn: 0,
      turnOrder: [],
      currentSubjectId: null,
      currentCardId: null,
      subjectAnswer: null,
      partnerGuess: null,
      winnerPairId: null,
      deck: [],
      deckPos: 0
    };
    await saveRoom(room);
    return { room: room, hostId: hostId };
  }
  throw new Error('could not allocate room code (collisions)');
}

async function joinRoom(code, name, gender) {
  var upper = String(code || '').toUpperCase();
  var room = await getRoom(upper);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase !== 'lobby') return { ok: false, error: 'game_already_started' };
  if ((room.players || []).length >= 10) return { ok: false, error: 'room_full' };
  var trimmed = String(name || '').trim().slice(0, 32);
  if (!trimmed) return { ok: false, error: 'name_required' };
  var g = normalizeGender(gender);
  if (!g) return { ok: false, error: 'invalid_gender' };
  // Allow duplicate names but warn in the UI (handled client-side).
  var pid = newSessionId();
  room.players.push({
    id: pid,
    name: trimmed,
    gender: g,
    joinedAt: new Date().toISOString(),
    isHost: false
  });
  await saveRoom(room);
  return { ok: true, room: room, playerId: pid };
}

// Strip any fields the client shouldn't see (e.g. the Subject's secret answer
// while the Partner is still guessing, the Partner's guess before reveal).
// Always include the caller's own perspective.
function publicView(room, viewerId) {
  if (!room) return null;
  var out = JSON.parse(JSON.stringify(room));
  // Gendered Choice+Explain cards carry separate optionsMale / optionsFemale
  // pools. Resolve the pool server-side from the current Subject's gender and
  // expose it as currentCardOptions so the client renders the matched pool and
  // never has to pick between the two itself.
  if (out.phase === 'playing' && out.currentCardId != null) {
    var curCard = CARDS_BY_ID[out.currentCardId];
    if (curCard && curCard.genderedOptions) {
      var subj = (room.players || []).find(function (p) { return p.id === room.currentSubjectId; });
      var sg = (subj && subj.gender === 'female') ? 'female' : 'male';
      out.currentCardOptions = (sg === 'female' ? curCard.optionsFemale : curCard.optionsMale) || [];
    }
  }
  if (out.phase === 'playing' && out.subPhase === 'guessing') {
    // Hide Subject's truth from everyone except the Subject
    if (viewerId !== out.currentSubjectId) {
      out.subjectAnswer = null;
    }
    // Phase 5: only the Partner submits a guess. Hide their guess from
    // everyone except themselves. Subject and spectators see only a flag.
    var allGuesses = out.guesses || {};
    var visible = {};
    if (viewerId && allGuesses[viewerId]) visible[viewerId] = allGuesses[viewerId];
    out.guesses = visible;
    out.partnerHasGuessed = Object.keys(room.guesses || {}).length > 0;
  }
  // Overtime: before the reveal, each player sees only their OWN pick. The
  // Subject's truth stays hidden from their partner (who is predicting it) and
  // from the other team; the partner's guess stays hidden from everyone else.
  // truthIn / guessIn booleans let the UI show "locked in" without leaking.
  if (out.phase === 'overtime' && out.subPhase === 'guessing' && out.ot) {
    Object.keys(out.ot).forEach(function (pid) {
      var s = out.ot[pid];
      s.truthIn = s.truth != null;
      s.guessIn = s.guess != null;
      if (s.subjectId !== viewerId) s.truth = null;
      if (s.partnerId !== viewerId) s.guess = null;
    });
  }
  return out;
}

// Host moves the room from lobby to pairing phase. Requires an EVEN number
// of players (the game is pair-based; odd counts leave someone unpaired).
// Minimum 4 players (2 pairs); maximum 10 (5 pairs).
async function startPairing({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'lobby') return { ok: false, error: 'wrong_phase' };
  var n = (room.players || []).length;
  if (n < 4) return { ok: false, error: 'too_few_players' };
  if (n % 2 !== 0) return { ok: false, error: 'odd_player_count' };
  room.phase = 'pairing';
  room.pendingPicks = {};   // playerId -> pickedPartnerId (not yet mutual)
  room.pairs = [];          // confirmed mutual pairs
  await saveRoom(room);
  return { ok: true, room: room };
}

// Player A picks player B as their partner. If B has already picked A,
// the pair is locked in (added to room.pairs, removed from pendingPicks).
// A player who is already paired cannot change their pick. A player can
// re-pick freely until they're paired.
async function pickPartner({ code, playerId, targetPlayerId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase !== 'pairing') return { ok: false, error: 'wrong_phase' };
  if (playerId === targetPlayerId) return { ok: false, error: 'cannot_pair_with_self' };
  var players = room.players || [];
  var me = players.find(function (p) { return p.id === playerId; });
  var target = players.find(function (p) { return p.id === targetPlayerId; });
  if (!me) return { ok: false, error: 'not_in_room' };
  if (!target) return { ok: false, error: 'target_not_in_room' };

  // If either party is already in a confirmed pair, reject.
  var pairs = room.pairs || [];
  var isPaired = function (pid) {
    return pairs.some(function (pr) { return pr.playerIds.indexOf(pid) !== -1; });
  };
  if (isPaired(playerId)) return { ok: false, error: 'already_paired' };
  if (isPaired(targetPlayerId)) return { ok: false, error: 'target_already_paired' };

  // Record the pick
  room.pendingPicks = room.pendingPicks || {};
  room.pendingPicks[playerId] = targetPlayerId;

  // Check for mutual pick → lock in the pair
  if (room.pendingPicks[targetPlayerId] === playerId) {
    room.pairs.push({
      id: newPairId(),
      playerIds: [playerId, targetPlayerId],
      score: 0
    });
    delete room.pendingPicks[playerId];
    delete room.pendingPicks[targetPlayerId];
  }

  await saveRoom(room);
  return { ok: true, room: room };
}

// Host pairs two players together during the pairing phase. Either
// player can already be unpaired; if either is already in a pair the
// request is rejected (host must unpair them first). Colors cycle
// through the available palette so each pair has a distinct hue.
var PAIR_COLORS = ['coral', 'sky', 'sun', 'pink', 'teal'];

// Curated emoji palette teams can pick from after pairing. Twelve distinct
// glyphs that read well at the small race-car size on iOS + Android.
var TEAM_ICONS = ['🔥', '⚡', '💎', '⭐', '🚀', '🌊', '🦁', '🦊', '🐯', '🐺', '🌙', '☀️'];

// Depth modes. 'real' is the only mode with content right now (the existing
// 72 cards are all tagged depth='real'). All three tiers now have content
// shipped (Real 1-72, Deep 73-112, Light 113-148), so all three are live
// and selectable. The valid_depths array is the source of truth for what
// UI surfaces; SELECTABLE_DEPTHS gates what setDepth will actually accept.
var VALID_DEPTHS = ['light', 'real', 'deep'];
var SELECTABLE_DEPTHS = ['real', 'deep', 'light'];

function filterDeckByDepth(depth) {
  return (CARDS.cards || []).filter(function (c) { return (c.depth || 'real') === depth; });
}
async function pairPlayers({ code, hostId, playerIdA, playerIdB }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'pairing') return { ok: false, error: 'wrong_phase' };
  if (playerIdA === playerIdB) return { ok: false, error: 'cannot_pair_with_self' };
  var players = room.players || [];
  if (!players.find(function (p) { return p.id === playerIdA; })) return { ok: false, error: 'player_a_not_in_room' };
  if (!players.find(function (p) { return p.id === playerIdB; })) return { ok: false, error: 'player_b_not_in_room' };
  var pairs = room.pairs || [];
  var inPair = function (pid) {
    return pairs.some(function (pr) { return pr.playerIds.indexOf(pid) !== -1; });
  };
  if (inPair(playerIdA)) return { ok: false, error: 'a_already_paired' };
  if (inPair(playerIdB)) return { ok: false, error: 'b_already_paired' };
  var usedColors = pairs.map(function (pr) { return pr.color; });
  var color = PAIR_COLORS.find(function (c) { return usedColors.indexOf(c) === -1; }) || PAIR_COLORS[pairs.length % PAIR_COLORS.length];
  room.pairs = pairs.concat([{
    id: newPairId(),
    playerIds: [playerIdA, playerIdB],
    score: 0,
    color: color
  }]);
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host removes a player (and their partner) from any existing pair so
// they go back to neutral and can be re-paired.
async function unpairPlayer({ code, hostId, playerId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'pairing') return { ok: false, error: 'wrong_phase' };
  var pairs = room.pairs || [];
  var before = pairs.length;
  room.pairs = pairs.filter(function (pr) { return pr.playerIds.indexOf(playerId) === -1; });
  if (room.pairs.length === before) return { ok: false, error: 'not_in_pair' };
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host transitions from pairing → teamSetup once everyone is paired.
// Initializes the team setup sub-phase so pairs can pick icons.
async function startTeamSetup({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'pairing') return { ok: false, error: 'wrong_phase' };
  var pairedIds = (room.pairs || []).reduce(function (acc, pr) {
    return acc.concat(pr.playerIds);
  }, []);
  var allPlayerIds = (room.players || []).map(function (p) { return p.id; });
  if (pairedIds.length !== allPlayerIds.length) {
    return { ok: false, error: 'not_everyone_paired' };
  }
  room.phase = 'teamSetup';
  room.subPhase = 'pickingIcons';
  // Default depth to 'real' (the only mode with shipped content). Host can
  // change it on the confirm screen via setDepth.
  if (!room.depth) room.depth = 'real';
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host assigns an emoji icon to a pair during the pickingIcons sub-phase.
// Enforces uniqueness: a pair cannot pick the same icon as another pair.
async function setTeamIcon({ code, hostId, pairId, icon }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup' || room.subPhase !== 'pickingIcons') {
    return { ok: false, error: 'wrong_phase' };
  }
  if (TEAM_ICONS.indexOf(icon) === -1) return { ok: false, error: 'invalid_icon' };
  var pairs = room.pairs || [];
  var target = pairs.find(function (pr) { return pr.id === pairId; });
  if (!target) return { ok: false, error: 'pair_not_found' };
  // Reject if another pair already owns this icon
  var taken = pairs.some(function (pr) { return pr.id !== pairId && pr.icon === icon; });
  if (taken) return { ok: false, error: 'icon_taken' };
  target.icon = icon;
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host sets (or clears) a pair's team name. Empty string = no name.
async function setTeamName({ code, hostId, pairId, teamName }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup') return { ok: false, error: 'wrong_phase' };
  var pairs = room.pairs || [];
  var target = pairs.find(function (pr) { return pr.id === pairId; });
  if (!target) return { ok: false, error: 'pair_not_found' };
  target.teamName = String(teamName || '').trim().slice(0, 24);
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host picks a deck depth from the confirm screen. Defaults to 'real'.
// All three tiers (light/real/deep) are live and in SELECTABLE_DEPTHS;
// depth_coming_soon only fires if a valid depth is ever pulled from the
// selectable set in the future.
async function setDepth({ code, hostId, depth }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup') return { ok: false, error: 'wrong_phase' };
  if (VALID_DEPTHS.indexOf(depth) === -1) return { ok: false, error: 'invalid_depth' };
  if (SELECTABLE_DEPTHS.indexOf(depth) === -1) return { ok: false, error: 'depth_coming_soon' };
  room.depth = depth;
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host taps "Next: Confirm Teams" after every pair has an icon.
async function advanceToConfirm({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup' || room.subPhase !== 'pickingIcons') {
    return { ok: false, error: 'wrong_phase' };
  }
  var pairs = room.pairs || [];
  if (pairs.length === 0) return { ok: false, error: 'no_pairs' };
  var missing = pairs.filter(function (pr) { return !pr.icon; });
  if (missing.length > 0) return { ok: false, error: 'icons_missing' };
  room.subPhase = 'confirming';
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host can step back from confirming → pickingIcons to adjust icons.
async function backToPickingIcons({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup' || room.subPhase !== 'confirming') {
    return { ok: false, error: 'wrong_phase' };
  }
  room.subPhase = 'pickingIcons';
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host transitions from teamSetup/confirming → playing once teams are locked.
// Initializes the deck (shuffled card ids), the turn order (shuffled player
// ids), and the first card.
async function startGame({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'teamSetup' || room.subPhase !== 'confirming') {
    return { ok: false, error: 'wrong_phase' };
  }
  var pairs = room.pairs || [];
  var missingIcons = pairs.filter(function (pr) { return !pr.icon; });
  if (missingIcons.length > 0) return { ok: false, error: 'icons_missing' };
  var pairedIds = pairs.reduce(function (acc, pr) {
    return acc.concat(pr.playerIds);
  }, []);
  var allPlayerIds = (room.players || []).map(function (p) { return p.id; });
  if (pairedIds.length !== allPlayerIds.length) {
    return { ok: false, error: 'not_everyone_paired' };
  }
  room.phase = 'playing';
  room.subPhase = 'guessing';
  room.round = 1;
  room.turn = 0;
  // Phase 5: pair-focused turn order. We shuffle pair ids, not player ids;
  // each turn one pair acts (Subject + Partner). Within a pair, subjectIndex
  // alternates each time the pair takes a turn so both members get equal
  // Subject time.
  room.pairs.forEach(function (pr) { pr.subjectIndex = 0; });
  room.turnOrder = shuffle(room.pairs.map(function (pr) { return pr.id; }));
  var firstPair = room.pairs.find(function (pr) { return pr.id === room.turnOrder[0]; });
  room.currentPairId = firstPair.id;
  room.currentSubjectId = firstPair.playerIds[firstPair.subjectIndex || 0];
  // Filter deck by chosen depth. Defaults to 'real' if unset (legacy rooms).
  var chosenDepth = room.depth || 'real';
  var depthCards = filterDeckByDepth(chosenDepth);
  if (depthCards.length === 0) return { ok: false, error: 'depth_empty' };
  room.deck = shuffle(depthCards.map(function (c) { return c.id; }));
  room.deckPos = 0;
  room.currentCardId = room.deck[0];
  room.subjectAnswer = null;
  room.guesses = {};       // Partner's guess only; map keeps the shape compatible
  room.lastReveal = null;
  room.winnerPairId = null;
  clearOvertimeState(room);
  await saveRoom(room);
  return { ok: true, room: room };
}

// Wipe every tie-breaker / overtime field so a fresh game or rematch never
// inherits stale sudden-death state.
function clearOvertimeState(room) {
  delete room.pendingOvertime;
  delete room.otTeams;
  delete room.ot;
  delete room.otReveal;
  delete room.otRound;
  delete room.tieBreaker;
  delete room.wonInOvertime;
}

// Host taps Rematch from the game-over screen. Resets pair scores, reshuffles
// deck and pair turn order, resets each pair's subjectIndex, clears reveal/
// guess state, and routes back into the playing phase. Teams (members, icon,
// color, teamName) are preserved so the same group can keep playing.
async function rematch({ code, hostId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'gameOver') return { ok: false, error: 'wrong_phase' };

  // Reset every pair's runtime state but keep identity (members, icon, teamName, color)
  (room.pairs || []).forEach(function (pr) {
    pr.score = 0;
    pr.subjectIndex = 0;
  });

  // Fresh deck (same depth as the just-finished game) + pair turn order
  var chosenDepth = room.depth || 'real';
  var depthCards = filterDeckByDepth(chosenDepth);
  if (depthCards.length === 0) return { ok: false, error: 'depth_empty' };
  room.deck = shuffle(depthCards.map(function (c) { return c.id; }));
  room.deckPos = 0;
  room.currentCardId = room.deck[0];
  room.turnOrder = shuffle(room.pairs.map(function (pr) { return pr.id; }));
  room.turn = 0;
  var firstPair = room.pairs.find(function (pr) { return pr.id === room.turnOrder[0]; });
  if (!firstPair) return { ok: false, error: 'pair_not_found' };
  room.currentPairId = firstPair.id;
  room.currentSubjectId = firstPair.playerIds[firstPair.subjectIndex || 0];

  // Reset round + reveal state
  room.round = 1;
  room.subjectAnswer = null;
  room.guesses = {};
  room.lastReveal = null;
  room.winnerPairId = null;
  clearOvertimeState(room);

  // Back into the game
  room.phase = 'playing';
  room.subPhase = 'guessing';

  await saveRoom(room);
  return { ok: true, room: room };
}

// Look up the Subject's partner in their pair. Returns playerId or null.
function partnerOfSubject(room) {
  var pair = (room.pairs || []).find(function (pr) { return pr.id === room.currentPairId; });
  if (!pair) return null;
  return pair.playerIds.find(function (pid) { return pid !== room.currentSubjectId; }) || null;
}

// Pair-focused scoring engine.
// Only the Subject's Partner guesses; if their guess matches Subject's truth,
// the pair earns card.scoring.guesserPoints (mc4=+2, mc6=+3, tf=+1,
// group_vote=+2). Talk cards (reflection/discussion) award 0.
// Returns: { cardId, type, truth, partnerId, partnerGuess, correct, pairDeltas }
function scoreCard(card, guesses, truth, subjectId, pairs, partnerId) {
  var partnerGuess = (guesses && partnerId) ? guesses[partnerId] : null;
  var detail = {
    cardId: card.id,
    type: card.type,
    truth: truth,
    partnerId: partnerId,
    partnerGuess: partnerGuess,
    correct: false,
    pairDeltas: {}
  };
  if (card.type === 'reflection' || card.type === 'discussion') return detail;

  if (partnerGuess && partnerGuess === truth) {
    detail.correct = true;
    var subjPair = findPairByPlayerId(subjectId, pairs);
    if (subjPair) {
      var pts = (card.scoring && card.scoring.guesserPoints) || 0;
      // Bonus cards double the points on a correct partner guess.
      if (card.bonus) pts = pts * 2;
      detail.pairDeltas[subjPair.id] = pts;
    }
  }
  // Always surface bonus state so the client can show the badge in
  // both the playing screen and the reveal panel.
  detail.bonus = !!card.bonus;
  return detail;
}

// Pair ids that still have an unplayed turn left in the CURRENT rotation
// (positions after the turn pointer in turnOrder). room.turn still points at the
// pair that just acted when this runs; nextCard advances it afterward.
function pendingPairIdsThisRotation(room) {
  var order = room.turnOrder || [];
  return order.slice((room.turn || 0) + 1);
}

// Decide what a cap-hit means right now, instead of ending the game the instant
// a pair reaches the line:
//   - sole pair at the cap, no opponent can still act this rotation -> winner
//   - two+ pairs tied at the cap, no one else pending -> overtime
//   - an opponent still has a pending turn this rotation -> DEFER (let them try
//     to tie; we re-decide on their submit). The client shows "match point"
//     from (score >= cap && phase === 'playing').
function resolveCapAfterScore(room, cap) {
  var pairs = room.pairs || [];
  var maxScore = pairs.reduce(function (m, pr) { return Math.max(m, pr.score || 0); }, 0);
  if (maxScore < cap) return;
  var leaders = pairs.filter(function (pr) { return (pr.score || 0) === maxScore; });
  var leaderIds = leaders.map(function (pr) { return pr.id; });
  var chasers = pendingPairIdsThisRotation(room).filter(function (pid) {
    return leaderIds.indexOf(pid) === -1;
  });
  if (chasers.length > 0) return;            // a chaser can still tie -> defer
  if (leaders.length === 1) {
    room.winnerPairId = leaders[0].id;       // nextCard ends the game
  } else {
    room.pendingOvertime = leaderIds;        // tie at the line -> overtime
  }
}

function validGuessForCard(card, guess, room, voterId) {
  if (card.type === 'mc4') return ['A','B','C','D'].indexOf(guess) !== -1;
  if (card.type === 'mc6') return ['A','B','C','D','E','F'].indexOf(guess) !== -1;
  if (card.type === 'tf') return ['T','F'].indexOf(guess) !== -1;
  if (card.type === 'group_vote') {
    if (guess === voterId) return false;  // can't vote for yourself
    return (room.players || []).some(function (p) { return p.id === guess; });
  }
  return false;
}

function validTruthForCard(card, truth, room) {
  if (card.type === 'mc4') return ['A','B','C','D'].indexOf(truth) !== -1;
  if (card.type === 'mc6') return ['A','B','C','D','E','F'].indexOf(truth) !== -1;
  if (card.type === 'tf') return ['T','F'].indexOf(truth) !== -1;
  if (card.type === 'group_vote') {
    if (truth === 'NOT_AT_TABLE') return true;
    return (room.players || []).some(function (p) { return p.id === truth; });
  }
  return false;
}

// The Subject's Partner submits a guess about what Subject answered.
// Phase 5: only the Partner can guess. Subject and spectators cannot.
async function submitGuess({ code, playerId, guess }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase === 'overtime') return await submitOvertimePick(room, playerId, 'guess', guess);
  if (room.phase !== 'playing') return { ok: false, error: 'wrong_phase' };
  if (room.subPhase !== 'guessing') return { ok: false, error: 'not_guessing_phase' };
  if (playerId === room.currentSubjectId) return { ok: false, error: 'subject_cannot_guess' };
  var expectedPartner = partnerOfSubject(room);
  if (playerId !== expectedPartner) return { ok: false, error: 'only_partner_can_guess' };

  var card = CARDS_BY_ID[room.currentCardId];
  if (!card) return { ok: false, error: 'card_not_found' };
  if (card.type === 'reflection' || card.type === 'discussion') {
    return { ok: false, error: 'card_has_no_guess' };
  }
  if (!validGuessForCard(card, guess, room, playerId)) {
    return { ok: false, error: 'invalid_guess' };
  }

  room.guesses = room.guesses || {};
  room.guesses[playerId] = guess;
  await saveRoom(room);
  return { ok: true, room: room };
}

// The Subject submits the truth. Requires all non-Subject players to have
// already submitted their guess; otherwise we return waiting_for_guessers
// with the names so the UI can tell the Subject who to nudge.
async function submitTruth({ code, playerId, truth }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase === 'overtime') return await submitOvertimePick(room, playerId, 'truth', truth);
  if (room.phase !== 'playing') return { ok: false, error: 'wrong_phase' };
  if (room.subPhase !== 'guessing') return { ok: false, error: 'not_guessing_phase' };
  if (playerId !== room.currentSubjectId) return { ok: false, error: 'not_subject' };

  var card = CARDS_BY_ID[room.currentCardId];
  if (!card) return { ok: false, error: 'card_not_found' };
  if (card.type === 'reflection' || card.type === 'discussion') {
    return { ok: false, error: 'card_has_no_truth' };
  }
  if (!validTruthForCard(card, truth, room)) {
    return { ok: false, error: 'invalid_truth' };
  }

  // Phase 5: only the Partner's guess matters. Block reveal until Partner submitted.
  var partnerId = partnerOfSubject(room);
  var partner = (room.players || []).find(function (p) { return p.id === partnerId; });
  if (!partnerId || !partner) return { ok: false, error: 'no_partner' };
  if (!(room.guesses && room.guesses[partnerId])) {
    return { ok: false, error: 'waiting_for_partner', waitingOn: [partner.name] };
  }

  room.subjectAnswer = truth;
  var detail = scoreCard(card, room.guesses || {}, truth, room.currentSubjectId, room.pairs, partnerId);

  // Apply per-pair deltas with cap
  var cap = room.cap || 25;
  var beforeAfter = {};
  (room.pairs || []).forEach(function (pr) {
    var before = pr.score || 0;
    var delta = detail.pairDeltas[pr.id] || 0;
    var after = Math.min(cap, before + delta);
    pr.score = after;
    beforeAfter[pr.id] = { before: before, delta: delta, after: after };
  });
  detail.pairBeforeAfter = beforeAfter;

  room.lastReveal = detail;
  room.subPhase = 'reveal';

  // Tie-breaker aware win detection. Instead of ending the moment a pair hits
  // the cap, defer if an opponent still has a pending turn this rotation (they
  // get the chance to tie). Resolves to a winner, an overtime tie, or a defer.
  resolveCapAfterScore(room, cap);

  await saveRoom(room);
  return { ok: true, room: room };
}

// Subject advances the round. From reveal → next guessing card. From a talk
// card (reflection/discussion) → next card directly. If a winner was set
// during the just-completed reveal, the room transitions to gameOver.
async function nextCard({ code, playerId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  // Overtime has its own advance path (evaluate scorers, then next OT card or win).
  if (room.phase === 'overtime') return await advanceOvertime(room, playerId);
  if (room.phase !== 'playing') return { ok: false, error: 'wrong_phase' };
  if (playerId !== room.currentSubjectId) return { ok: false, error: 'not_subject' };

  var card = CARDS_BY_ID[room.currentCardId];
  var isTalkCard = card && (card.type === 'reflection' || card.type === 'discussion');

  // Scoring cards must be in reveal phase before advancing
  if (!isTalkCard && room.subPhase !== 'reveal') {
    return { ok: false, error: 'not_reveal_phase' };
  }

  // Tie at the finish line during the just-finished rotation -> sudden death.
  if (room.pendingOvertime && room.pendingOvertime.length) {
    var tied = room.pendingOvertime;
    delete room.pendingOvertime;
    enterOvertime(room, tied);
    await saveRoom(room);
    return { ok: true, room: room };
  }

  // If a winner was locked in during the prior reveal, end the game now.
  if (room.winnerPairId) {
    room.phase = 'gameOver';
    await saveRoom(room);
    return { ok: true, room: room };
  }

  // Phase 5: turn order is pair-level. Flip the just-played pair's
  // subjectIndex so next time it acts, the other member is Subject.
  var justActedPair = (room.pairs || []).find(function (pr) { return pr.id === room.currentPairId; });
  if (justActedPair) {
    justActedPair.subjectIndex = ((justActedPair.subjectIndex || 0) + 1) % 2;
  }

  var nextTurn = (room.turn || 0) + 1;
  if (nextTurn >= (room.turnOrder || []).length) {
    nextTurn = 0;
    room.round = (room.round || 1) + 1;
    // Reshuffle pair order so the rotation doesn't get predictable across rounds
    room.turnOrder = shuffle(room.turnOrder || []);
  }
  room.turn = nextTurn;
  var nextPair = (room.pairs || []).find(function (pr) { return pr.id === room.turnOrder[nextTurn]; });
  if (!nextPair) return { ok: false, error: 'pair_not_found' };
  room.currentPairId = nextPair.id;
  room.currentSubjectId = nextPair.playerIds[nextPair.subjectIndex || 0];

  // Advance deck (reshuffle if we run out, which shouldn't happen in practice)
  var nextPos = (room.deckPos || 0) + 1;
  if (nextPos >= (room.deck || []).length) {
    room.deck = shuffle((CARDS.cards || []).map(function (c) { return c.id; }));
    nextPos = 0;
  }
  room.deckPos = nextPos;
  room.currentCardId = room.deck[nextPos];

  // Reset card-scoped state
  room.subPhase = 'guessing';
  room.subjectAnswer = null;
  room.guesses = {};
  room.lastReveal = null;

  await saveRoom(room);
  return { ok: true, room: room };
}

// The Subject finishes the EXPLAIN step by tapping "Done. Next card."
// Universal Explain (#86): every scoring card now carries an Explain step after
// the reveal, not just the ~40 Choice+Explain cards, so this no longer gates on
// card.requireExplain. Talk cards have no reveal/answer to explain and advance
// via friend-next-card instead. Downstream behavior is identical to nextCard
// (rotate Subject, advance deck, reset round state); the advance is fully
// Subject-controlled, no timer, no scoring.
async function finishExplain({ code, playerId, cardId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase !== 'playing') return { ok: false, error: 'wrong_phase' };
  if (playerId !== room.currentSubjectId) return { ok: false, error: 'not_subject' };
  var card = CARDS_BY_ID[room.currentCardId];
  if (!card) return { ok: false, error: 'card_not_found' };
  if (card.type === 'reflection' || card.type === 'discussion') {
    return { ok: false, error: 'card_has_no_explain' };
  }
  if (room.subPhase !== 'reveal') return { ok: false, error: 'not_reveal_phase' };
  if (cardId != null && Number(cardId) !== Number(room.currentCardId)) {
    return { ok: false, error: 'card_mismatch' };
  }
  // Identical downstream behavior to friend-next-card.
  return await nextCard({ code, playerId });
}

// ============================================================
//   Tie-breaker overtime (sudden death)
//   ------------------------------------------------------------
//   Reached when two+ pairs are tied at the cap after a rotation.
//   Every tied team answers the SAME card simultaneously: each
//   team's Subject locks a truth, each team's Partner predicts it.
//   When all teams have both, the round reveals. If exactly one
//   team's Partner predicted right, that team wins. If zero or two+
//   teams score, deal the next overtime card and repeat. Overtime
//   scoring lives in room.tieBreaker, separate from pr.score (which
//   stays pinned at the cap) so the game-over breakdown reads clean.
// ============================================================

// Overtime needs one shared prompt, so it only draws plain scoring cards
// (mc4/mc6/tf). Gendered cards resolve a different option pool per Subject and
// talk cards have no scoring, so both are skipped.
function isOvertimeEligible(card) {
  if (!card) return false;
  if (card.genderedOptions) return false;
  return card.type === 'mc4' || card.type === 'mc6' || card.type === 'tf';
}

// Walk the deck forward to the next overtime-eligible card, reshuffling the full
// deck if it runs dry. Returns the chosen card id.
function drawOvertimeCard(room) {
  var deck = room.deck || [];
  var guard = 0;
  while (guard++ < (deck.length + 2)) {
    var pos = (room.deckPos || 0) + 1;
    if (pos >= deck.length) {
      room.deck = shuffle((CARDS.cards || []).map(function (c) { return c.id; }));
      deck = room.deck;
      pos = 0;
    }
    room.deckPos = pos;
    if (isOvertimeEligible(CARDS_BY_ID[deck[pos]])) return deck[pos];
  }
  return deck[room.deckPos || 0];
}

// Build the per-team submission slots for the current overtime card. Subject is
// the pair's current subjectIndex member; partner is the other.
function buildOvertimeSlots(room) {
  var slots = {};
  (room.otTeams || []).forEach(function (pid) {
    var pr = (room.pairs || []).find(function (p) { return p.id === pid; });
    if (!pr) return;
    var si = pr.subjectIndex || 0;
    slots[pid] = {
      subjectId: pr.playerIds[si],
      partnerId: pr.playerIds[(si + 1) % 2],
      truth: null,
      guess: null
    };
  });
  room.ot = slots;
}

function enterOvertime(room, tiedPairIds) {
  room.phase = 'overtime';
  room.subPhase = 'guessing';
  room.otTeams = tiedPairIds.slice();
  room.otRound = 1;
  room.winnerPairId = null;
  room.otReveal = null;
  room.wonInOvertime = false;
  room.tieBreaker = room.tieBreaker || {};
  room.otTeams.forEach(function (pid) {
    if (room.tieBreaker[pid] == null) room.tieBreaker[pid] = 0;
  });
  room.currentCardId = drawOvertimeCard(room);
  buildOvertimeSlots(room);
}

// Shared handler for both overtime picks. kind is 'truth' (Subject) or 'guess'
// (Partner). Records the value on the player's team slot; when every team has
// both a truth and a guess, computes the reveal.
async function submitOvertimePick(room, playerId, kind, value) {
  if (room.subPhase !== 'guessing') return { ok: false, error: 'not_guessing_phase' };
  var card = CARDS_BY_ID[room.currentCardId];
  if (!card) return { ok: false, error: 'card_not_found' };
  var slot = null, role = null;
  Object.keys(room.ot || {}).forEach(function (pid) {
    var s = room.ot[pid];
    if (s.subjectId === playerId) { slot = s; role = 'subject'; }
    else if (s.partnerId === playerId) { slot = s; role = 'partner'; }
  });
  if (!slot) return { ok: false, error: 'not_in_overtime' };
  if (kind === 'truth') {
    if (role !== 'subject') return { ok: false, error: 'not_subject' };
    if (!validTruthForCard(card, value, room)) return { ok: false, error: 'invalid_truth' };
    slot.truth = value;
  } else {
    if (role !== 'partner') return { ok: false, error: 'only_partner_can_guess' };
    if (!validGuessForCard(card, value, room, playerId)) return { ok: false, error: 'invalid_guess' };
    slot.guess = value;
  }
  var complete = (room.otTeams || []).every(function (pid) {
    var s = room.ot[pid];
    return s && s.truth != null && s.guess != null;
  });
  if (complete) {
    var reveal = {};
    (room.otTeams || []).forEach(function (pid) {
      var s = room.ot[pid];
      var correct = !!(s.guess != null && s.truth != null && s.guess === s.truth);
      reveal[pid] = { truth: s.truth, guess: s.guess, subjectId: s.subjectId, partnerId: s.partnerId, correct: correct };
      if (correct) room.tieBreaker[pid] = (room.tieBreaker[pid] || 0) + 1;
    });
    room.otReveal = reveal;
    room.subPhase = 'reveal';
  }
  await saveRoom(room);
  return { ok: true, room: room };
}

// An overtime Subject advances after the reveal. Sole scorer wins; a 0-scorer or
// multi-scorer round flips Subjects and deals the next overtime card.
async function advanceOvertime(room, playerId) {
  if (room.subPhase !== 'reveal') return { ok: false, error: 'not_reveal_phase' };
  var isOtSubject = (room.otTeams || []).some(function (pid) {
    return room.ot[pid] && room.ot[pid].subjectId === playerId;
  });
  if (!isOtSubject) return { ok: false, error: 'not_subject' };
  var scorers = (room.otTeams || []).filter(function (pid) {
    return room.otReveal && room.otReveal[pid] && room.otReveal[pid].correct;
  });
  if (scorers.length === 1) {
    room.winnerPairId = scorers[0];
    room.wonInOvertime = true;
    room.phase = 'gameOver';
    await saveRoom(room);
    return { ok: true, room: room };
  }
  // Inconclusive: flip each tied pair's Subject and deal another overtime card.
  (room.otTeams || []).forEach(function (pid) {
    var pr = (room.pairs || []).find(function (p) { return p.id === pid; });
    if (pr) pr.subjectIndex = ((pr.subjectIndex || 0) + 1) % 2;
  });
  room.otRound = (room.otRound || 1) + 1;
  room.subPhase = 'guessing';
  room.otReveal = null;
  room.currentCardId = drawOvertimeCard(room);
  buildOvertimeSlots(room);
  await saveRoom(room);
  return { ok: true, room: room };
}

// Host removes a player from a room. Only allowed during the lobby phase
// and only by the host (verified via hostId match). The host cannot remove
// themselves; "Leave" is a separate concept that will arrive in Phase 2.
async function removePlayer({ code, hostId, targetPlayerId }) {
  var room = await getRoom(code);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.hostId !== hostId) return { ok: false, error: 'not_host' };
  if (room.phase !== 'lobby') return { ok: false, error: 'game_already_started' };
  if (targetPlayerId === room.hostId) return { ok: false, error: 'cannot_remove_host' };
  var before = (room.players || []).length;
  room.players = (room.players || []).filter(function (p) { return p.id !== targetPlayerId; });
  if (room.players.length === before) return { ok: false, error: 'player_not_found' };
  await saveRoom(room);
  return { ok: true, room: room };
}

module.exports = {
  newSessionId,
  newPairId,
  getRoom,
  saveRoom,
  createRoom,
  joinRoom,
  removePlayer,
  startPairing,
  pickPartner,
  pairPlayers,
  unpairPlayer,
  startTeamSetup,
  setTeamIcon,
  setTeamName,
  advanceToConfirm,
  backToPickingIcons,
  startGame,
  submitGuess,
  submitTruth,
  nextCard,
  finishExplain,
  rematch,
  setDepth,
  publicView,
  TEAM_ICONS,
  VALID_DEPTHS,
  SELECTABLE_DEPTHS,
  CARDS_BY_ID
};
