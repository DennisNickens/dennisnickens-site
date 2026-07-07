/* ============================================================
   T-PAC bracket engine: single elimination, live simultaneous
   matches, lazy state advancement.
   ------------------------------------------------------------
   Serverless has no background workers, so every state
   transition that depends on the clock (scheduled starts, ready
   check forfeits, round breaks) happens lazily inside
   reconcileBracket(), which the polling endpoints call. That
   keeps all competition rules in one place.

   All timestamps are stored UTC ISO; clients render local time.

   KV keys:
     tpac:bracket:{bid}            bracket doc (meta + entries +
                                   rounds of match ids + chat)
     tpac:bracket-index            set of bracket ids
     tpac:match:{mid}              match doc (slots, status,
                                   timing, winner)
     tpac:match:{mid}:f:{uid}      that bowler's frames (only the
                                   owner writes it, so live frame
                                   entry never races the meta doc)
     tpac:match:{mid}:ready:{uid}  ready check flag
     tpac:match:{mid}:photo:{uid}  score-screen photo URL
     tpac:match:{mid}:confirm:{uid} uid confirmed OPPONENT's score
     tpac:lock:{bid}               10s mutation lock (kv NX) so two
                                   concurrent polls don't both
                                   build the next round
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const { scoreGame, computeHandicap, computePayouts, validateSplit, seedOrder } = require('./tpac-scoring.js');
const { ContestPayments } = require('./tpac-contest-payments.js');

const SIZES = [4, 8, 16];
const READY_OPEN_MINUTES = 10;   // ready check opens this long before start
const READY_GRACE_MINUTES = 5;   // no-show forfeits this long after start
const SLOW_FLAG_FORFEIT_COUNT = 3;

function now() { return new Date(); }
function iso(d) { return d.toISOString(); }
function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }

async function getBracket(bid) { return await kv.get('tpac:bracket:' + bid); }
async function saveBracket(b) { await kv.set('tpac:bracket:' + b.id, b); }
async function getMatch(mid) { return await kv.get('tpac:match:' + mid); }
async function saveMatch(m) { await kv.set('tpac:match:' + m.id, m); }

async function listBrackets() {
  const ids = (await kv.smembers('tpac:bracket-index')) || [];
  const brackets = [];
  for (const id of ids) {
    const b = await getBracket(id);
    if (b) brackets.push(b);
  }
  brackets.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return brackets;
}

/* ------------------------------------------------------------
   Creation and joining
   ------------------------------------------------------------ */

function createBracketDoc(user, handle, opts) {
  const size = Number(opts.size);
  if (!SIZES.includes(size)) return { error: 'size_must_be_4_8_16' };
  const entryFee = Math.round(Number(opts.entryFee || 0) * 100) / 100;
  if (isNaN(entryFee) || entryFee < 0 || entryFee > 500) return { error: 'bad_entry_fee' };
  const format = opts.format === 'handicap' ? 'handicap' : 'scratch';
  const entryType = opts.entryType === 'pickup' ? 'pickup' : 'scheduled';

  let scheduledStartUtc = null;
  if (entryType === 'scheduled') {
    const t = new Date(String(opts.scheduledStartUtc || ''));
    if (isNaN(t.getTime()) || t.getTime() < Date.now() - 60000) return { error: 'bad_start_time' };
    scheduledStartUtc = iso(t);
  }

  const splitPercents = Array.isArray(opts.splitPercents) && opts.splitPercents.length
    ? opts.splitPercents.map(Number)
    : [62.5, 25];
  const rakePercent = opts.rakePercent === undefined ? 12.5 : Number(opts.rakePercent);
  const splitErr = validateSplit(splitPercents, rakePercent);
  if (splitErr) return { error: splitErr };

  return {
    bracket: {
      id: crypto.randomUUID().slice(0, 8).toUpperCase(),
      name: String(opts.name || 'T-PAC Bracket').trim().slice(0, 80),
      size,
      entryFee,
      format,
      entryType,
      scheduledStartUtc,
      roundBreakMinutes: Math.min(60, Math.max(1, Number(opts.roundBreakMinutes) || 10)),
      frameTimeLimitSeconds: Math.min(600, Math.max(60, Number(opts.frameTimeLimitSeconds) || 180)),
      slowPolicy: opts.slowPolicy === 'forfeit' ? 'forfeit' : 'flag',
      base: Math.min(300, Math.max(150, Number(opts.base) || 220)),
      percent: Math.min(100, Math.max(0, Number(opts.percent) || 90)),
      splitPercents,
      rakePercent,
      organizerUid: user.uid,
      organizerHandle: handle,
      status: 'open',
      entries: [],
      rounds: [],
      champion: null,
      chat: [],
      createdAt: iso(now()),
    },
  };
}

async function joinBracket(bracket, user, handle, average) {
  if (bracket.status !== 'open') return { error: 'bracket_not_open' };
  if (bracket.entries.length >= bracket.size) return { error: 'bracket_full' };
  if (bracket.entries.some(e => e.uid === user.uid)) return { error: 'already_joined' };
  bracket.entries.push({
    uid: user.uid,
    handle,
    average: Number(average) || 0,
    seed: bracket.entries.length + 1, // join order seeds; byes go to top seeds
    joinedAt: iso(now()),
  });
  await ContestPayments.recordEntry(bracket.id, user.uid, handle, bracket.entryFee);
  await saveBracket(bracket);
  return { bracket };
}

/* ------------------------------------------------------------
   Starting: build round 1 from the seed order, byes to top seeds
   ------------------------------------------------------------ */

function aceSays(bracket, text) {
  bracket.chat.push({ from: 'Ace', text, at: iso(now()) });
  if (bracket.chat.length > 60) bracket.chat = bracket.chat.slice(-60);
}

async function createMatchDoc(bracket, round, slotA, slotB, startAt) {
  const match = {
    id: crypto.randomUUID().slice(0, 12),
    bid: bracket.id,
    round,
    slots: [slotA, slotB],
    status: slotA && slotB ? 'ready_check' : 'bye',
    startAtUtc: iso(startAt),
    readyDeadlineUtc: iso(addMinutes(startAt, READY_GRACE_MINUTES)),
    startedAtUtc: null,
    resolvedAtUtc: null,
    winnerUid: null,
    forfeitUid: null,
    tiebreak: {},
  };
  if (!slotB && slotA) { match.winnerUid = slotA.uid; match.resolvedAtUtc = iso(now()); match.status = 'complete'; }
  await saveMatch(match);
  return match;
}

function entrySlot(bracket, entry) {
  if (!entry) return null;
  return {
    uid: entry.uid,
    handle: entry.handle,
    seed: entry.seed,
    average: entry.average,
    handicap: bracket.format === 'handicap' ? computeHandicap(entry.average, bracket.base, bracket.percent) : 0,
  };
}

async function startBracket(bracket, startAt) {
  const order = seedOrder(bracket.size);
  const bySeed = {};
  for (const e of bracket.entries) bySeed[e.seed] = e;

  const round0 = [];
  for (let i = 0; i < order.length; i += 2) {
    const a = entrySlot(bracket, bySeed[order[i]]);
    const b = entrySlot(bracket, bySeed[order[i + 1]]);
    // Keep the filled slot first so byes always advance a real bowler.
    const match = await createMatchDoc(bracket, 0, a || b, a ? b : null, startAt);
    round0.push(match.id);
  }
  bracket.rounds = [round0];
  bracket.status = 'live';
  aceSays(bracket, 'Round 1 is live. Bowl your game, trust your spare shot, and let the bracket take care of itself. Good luck out there!');
  await saveBracket(bracket);
}

/* ------------------------------------------------------------
   Match scoring helpers
   ------------------------------------------------------------ */

async function getFrames(mid, uid) {
  return (await kv.get('tpac:match:' + mid + ':f:' + uid)) || { frames: [], lastFrameAt: null, slowFlags: 0 };
}

function finalScore(match, slot, framesDoc) {
  const scored = scoreGame(framesDoc.frames);
  return {
    raw: scored.total,
    complete: scored.complete,
    handicap: slot.handicap || 0,
    withHandicap: scored.total + (slot.handicap || 0),
    frameScores: scored.frameScores,
  };
}

/* ------------------------------------------------------------
   Lazy reconciler: run on every bracket/match poll
   ------------------------------------------------------------ */

async function withLock(bid, fn) {
  const key = 'tpac:lock:' + bid;
  const token = crypto.randomUUID();
  const acquired = await kv.set(key, token, { nx: true, ex: 10 });
  if (!acquired) return false; // another poller is reconciling; readers just read
  try { await fn(); } finally {
    const current = await kv.get(key);
    if (current === token) await kv.del(key);
  }
  return true;
}

async function reconcileBracket(bid) {
  const bracket = await getBracket(bid);
  if (!bracket) return null;

  await withLock(bid, async () => {
    const fresh = await getBracket(bid);
    if (!fresh) return;
    Object.assign(bracket, fresh);

    // Open -> live transitions
    if (bracket.status === 'open') {
      const full = bracket.entries.length >= bracket.size;
      const timeUp = bracket.entryType === 'scheduled' && bracket.scheduledStartUtc && now() >= new Date(bracket.scheduledStartUtc);
      if (bracket.entries.length >= 2 && (full || timeUp)) {
        await startBracket(bracket, bracket.entryType === 'scheduled' ? new Date(bracket.scheduledStartUtc) : now());
      }
    }

    if (bracket.status !== 'live') { await saveBracket(bracket); return; }

    // Advance matches in the latest round
    const roundIdx = bracket.rounds.length - 1;
    const matchIds = bracket.rounds[roundIdx] || [];
    const matches = [];
    for (const mid of matchIds) matches.push(await getMatch(mid));

    for (const match of matches) {
      if (!match || match.status === 'complete' || match.status === 'bye') continue;
      await reconcileMatch(bracket, match);
    }

    // Round complete? Build the next one (or crown a champion).
    const resolved = matches.filter(m => m && m.winnerUid);
    if (resolved.length === matches.length && matches.length > 0) {
      if (matches.length === 1) {
        const winner = matches[0].slots.find(s => s && s.uid === matches[0].winnerUid);
        bracket.champion = winner ? { uid: winner.uid, handle: winner.handle } : null;
        bracket.status = 'complete';
        await recordFinalPayouts(bracket, matches[0]);
        aceSays(bracket, (winner ? winner.handle : 'Your champion') + ' takes the bracket! Great bowling all around. Log those games and let us build on what worked.');
        await saveBracket(bracket);
      } else if (bracket.rounds.length === roundIdx + 1) {
        const latestResolve = resolved
          .map(m => new Date(m.resolvedAtUtc || m.startAtUtc))
          .reduce((a, b) => (a > b ? a : b));
        const nextStart = addMinutes(latestResolve, bracket.roundBreakMinutes);
        const nextRound = [];
        for (let i = 0; i < matches.length; i += 2) {
          const winA = matches[i].slots.find(s => s && s.uid === matches[i].winnerUid) || null;
          const winB = matches[i + 1] ? (matches[i + 1].slots.find(s => s && s.uid === matches[i + 1].winnerUid) || null) : null;
          const m = await createMatchDoc(bracket, roundIdx + 1, winA || winB, winA ? winB : null, nextStart);
          nextRound.push(m.id);
        }
        bracket.rounds.push(nextRound);
        aceSays(bracket, 'Round ' + (roundIdx + 2) + ' starts after a ' + bracket.roundBreakMinutes + ' minute break. Winners, get some water and reset. One shot at a time.');
        await saveBracket(bracket);
      }
    }
  });

  return await getBracket(bid);
}

async function reconcileMatch(bracket, match) {
  const [a, b] = match.slots;
  if (!a || !b) return;

  const [readyA, readyB] = await Promise.all([
    kv.get('tpac:match:' + match.id + ':ready:' + a.uid),
    kv.get('tpac:match:' + match.id + ':ready:' + b.uid),
  ]);

  // Ready check window
  if (match.status === 'ready_check') {
    if (readyA && readyB) {
      match.status = 'live';
      match.startedAtUtc = iso(now());
      await saveMatch(match);
      return;
    }
    if (now() > new Date(match.readyDeadlineUtc)) {
      // No-show forfeits. Both absent: higher seed advances.
      let winner, forfeiter;
      if (readyA && !readyB) { winner = a; forfeiter = b; }
      else if (readyB && !readyA) { winner = b; forfeiter = a; }
      else { winner = a.seed <= b.seed ? a : b; forfeiter = winner === a ? b : a; }
      match.winnerUid = winner.uid;
      match.forfeitUid = forfeiter.uid;
      match.status = 'complete';
      match.resolvedAtUtc = iso(now());
      await saveMatch(match);
      return;
    }
    return;
  }

  if (match.status !== 'live' && match.status !== 'awaiting_verification') return;

  const [framesA, framesB] = await Promise.all([getFrames(match.id, a.uid), getFrames(match.id, b.uid)]);

  // Slow-play forfeit (organizer setting)
  if (bracket.slowPolicy === 'forfeit') {
    const over = fd => (fd.slowFlags || 0) >= SLOW_FLAG_FORFEIT_COUNT;
    if (over(framesA) !== over(framesB)) {
      const forfeiter = over(framesA) ? a : b;
      const winner = forfeiter === a ? b : a;
      match.winnerUid = winner.uid;
      match.forfeitUid = forfeiter.uid;
      match.status = 'complete';
      match.resolvedAtUtc = iso(now());
      await saveMatch(match);
      return;
    }
  }

  const scoreA = finalScore(match, a, framesA);
  const scoreB = finalScore(match, b, framesB);
  if (!scoreA.complete || !scoreB.complete) return;

  if (match.status === 'live') { match.status = 'awaiting_verification'; await saveMatch(match); }

  // Verification: each bowler uploads their score-screen photo, the
  // OPPONENT confirms it. Both photos + both confirms resolve the match.
  const [photoA, photoB, confA, confB] = await Promise.all([
    kv.get('tpac:match:' + match.id + ':photo:' + a.uid),
    kv.get('tpac:match:' + match.id + ':photo:' + b.uid),
    kv.get('tpac:match:' + match.id + ':confirm:' + a.uid),
    kv.get('tpac:match:' + match.id + ':confirm:' + b.uid),
  ]);
  if (!photoA || !photoB || !confA || !confB) return;

  const useHandicap = bracket.format === 'handicap';
  let totalA = useHandicap ? scoreA.withHandicap : scoreA.raw;
  let totalB = useHandicap ? scoreB.withHandicap : scoreB.raw;

  if (totalA === totalB) {
    // Tiebreak: each bowler enters one extra frame (0-30). Equal
    // tiebreaks clear and go again.
    const tA = match.tiebreak[a.uid];
    const tB = match.tiebreak[b.uid];
    if (typeof tA !== 'number' || typeof tB !== 'number') return;
    if (tA === tB) { match.tiebreak = {}; await saveMatch(match); return; }
    totalA = tA; totalB = tB;
  }

  match.winnerUid = totalA > totalB ? a.uid : b.uid;
  match.status = 'complete';
  match.resolvedAtUtc = iso(now());
  await saveMatch(match);
}

async function recordFinalPayouts(bracket, finalMatch) {
  const pool = bracket.entries.length * bracket.entryFee;
  if (pool <= 0) return;
  const { places, rake } = computePayouts(pool, bracket.splitPercents, bracket.rakePercent);
  const winner = finalMatch.slots.find(s => s && s.uid === finalMatch.winnerUid);
  const runnerUp = finalMatch.slots.find(s => s && s.uid !== finalMatch.winnerUid);
  const payouts = [];
  if (places[0] !== undefined && winner) payouts.push({ uid: winner.uid, handle: winner.handle, place: 1, amount: places[0] });
  if (places[1] !== undefined && runnerUp) payouts.push({ uid: runnerUp.uid, handle: runnerUp.handle, place: 2, amount: places[1] });
  // Splits beyond 2nd place (semifinal losers etc.) are supported by the
  // math; v1 records 1st/2nd and leaves deeper places to the organizer.
  await ContestPayments.recordPayouts(bracket.id, payouts, rake, { uid: bracket.organizerUid, handle: bracket.organizerHandle });
}

module.exports = {
  SIZES,
  READY_OPEN_MINUTES,
  READY_GRACE_MINUTES,
  getBracket,
  saveBracket,
  getMatch,
  saveMatch,
  getFrames,
  listBrackets,
  createBracketDoc,
  joinBracket,
  reconcileBracket,
  finalScore,
};
