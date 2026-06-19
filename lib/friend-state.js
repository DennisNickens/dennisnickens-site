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

const ROOM_TTL_SECONDS = 8 * 60 * 60;  // rooms auto-expire after 8 hours

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

async function createRoom({ hostName }) {
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

async function joinRoom(code, name) {
  var upper = String(code || '').toUpperCase();
  var room = await getRoom(upper);
  if (!room) return { ok: false, error: 'room_not_found' };
  if (room.phase !== 'lobby') return { ok: false, error: 'game_already_started' };
  if ((room.players || []).length >= 10) return { ok: false, error: 'room_full' };
  var trimmed = String(name || '').trim().slice(0, 32);
  if (!trimmed) return { ok: false, error: 'name_required' };
  // Allow duplicate names but warn in the UI (handled client-side).
  var pid = newSessionId();
  room.players.push({
    id: pid,
    name: trimmed,
    joinedAt: new Date().toISOString(),
    isHost: false
  });
  await saveRoom(room);
  return { ok: true, room: room, playerId: pid };
}

// Strip any fields the client shouldn't see (e.g. the Subject's secret answer
// when other players are guessing). Always include the caller's own perspective.
function publicView(room, viewerId) {
  if (!room) return null;
  var out = JSON.parse(JSON.stringify(room));
  // Hide subject's answer until the reveal phase.
  if (out.phase === 'playing' && viewerId !== out.currentSubjectId) {
    out.subjectAnswer = null;
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

// Host transitions from pairing → playing once everyone is paired up.
async function startGame({ code, hostId }) {
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
  room.phase = 'playing';
  room.round = 1;
  room.turn = 0;
  // Shuffle the order players take their Subject turn (Fisher-Yates).
  var order = allPlayerIds.slice();
  for (var i = order.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = order[i]; order[i] = order[j]; order[j] = t;
  }
  room.turnOrder = order;
  room.currentSubjectId = order[0];
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
  startGame,
  publicView
};
