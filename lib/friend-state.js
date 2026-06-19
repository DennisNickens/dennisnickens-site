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
  publicView
};
