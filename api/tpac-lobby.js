/* ============================================================
   POST /api/tpac-lobby — the "I'm bowling live" pickup queue.
   ------------------------------------------------------------
   Body: { action: 'join' | 'poll' | 'leave' }

   A bowler at the lanes taps "I'm bowling live" (join). The
   moment another live bowler is waiting, the app pairs them
   into an instant free scratch head-to-head (a two-person
   bracket that reuses the whole live-match machinery: ready
   check, live scoreboard, photo verification). poll keeps the
   lobby entry fresh and returns the match once paired. Entries
   go stale after 3 minutes without a poll.

   Response: { ok, waiting } or { ok, matched: { bid, mid } }
   ============================================================ */

'use strict';

const crypto = require('crypto');
const store = require('../lib/tpac-store.js');
const engine = require('../lib/tpac-brackets.js');

const STALE_MS = 3 * 60 * 1000;
const ASSIGN_TTL = 60 * 60 * 6;

async function handleFor(user) {
  const profile = await store.kv.get('tpac:profile:' + user.uid);
  return (profile && profile.handle) || user.email.split('@')[0];
}

function freshOnly(lobby) {
  const cutoff = Date.now() - STALE_MS;
  return (lobby || []).filter(e => new Date(e.joinedAt).getTime() > cutoff);
}

async function createQuickMatch(a, b) {
  const bracket = {
    id: 'Q' + crypto.randomUUID().slice(0, 7).toUpperCase(),
    name: 'Live Pickup: ' + a.handle + ' vs ' + b.handle,
    size: 2,
    entryFee: 0,
    format: 'scratch',
    entryType: 'pickup',
    scheduledStartUtc: null,
    roundBreakMinutes: 10,
    frameTimeLimitSeconds: 180,
    slowPolicy: 'flag',
    base: 220,
    percent: 90,
    splitPercents: [100],
    rakePercent: 0,
    organizerUid: a.uid,
    organizerHandle: a.handle,
    status: 'open',
    entries: [
      { uid: a.uid, handle: a.handle, average: a.average, seed: 1, joinedAt: new Date().toISOString() },
      { uid: b.uid, handle: b.handle, average: b.average, seed: 2, joinedAt: new Date().toISOString() },
    ],
    rounds: [],
    champion: null,
    chat: [],
    createdAt: new Date().toISOString(),
  };
  await engine.saveBracket(bracket);
  const started = await engine.reconcileBracket(bracket.id); // full pickup starts instantly
  const mid = started.rounds[0] && started.rounds[0][0];
  const assignment = { bid: bracket.id, mid };
  await store.kv.set('tpac:quick:' + a.uid, assignment, { ex: ASSIGN_TTL });
  await store.kv.set('tpac:quick:' + b.uid, assignment, { ex: ASSIGN_TTL });
  return assignment;
}

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }
    if (!store.hasActiveSubscription(user)) { res.status(402).json({ ok: false, error: 'subscription_required' }); return; }

    const action = String(store.parseBody(req).action || 'poll');

    const existing = await store.kv.get('tpac:quick:' + user.uid);
    if (existing && action !== 'leave') {
      // Only surface an unfinished match; a completed one clears out.
      const match = await engine.getMatch(existing.mid);
      if (match && match.status !== 'complete') {
        res.status(200).json({ ok: true, matched: existing });
        return;
      }
      await store.kv.del('tpac:quick:' + user.uid);
    }

    let lobby = freshOnly(await store.kv.get('tpac:lobby'));

    if (action === 'leave') {
      lobby = lobby.filter(e => e.uid !== user.uid);
      await store.kv.set('tpac:lobby', lobby);
      await store.kv.del('tpac:quick:' + user.uid);
      res.status(200).json({ ok: true, waiting: false });
      return;
    }

    // join and poll behave the same: keep my entry fresh, pair if possible.
    const others = lobby.filter(e => e.uid !== user.uid);
    if (others.length > 0) {
      const opponent = others[0];
      const profile = await store.kv.get('tpac:profile:' + user.uid);
      const me = { uid: user.uid, handle: await handleFor(user), average: (profile && Number(profile.average)) || 0 };
      lobby = lobby.filter(e => e.uid !== user.uid && e.uid !== opponent.uid);
      await store.kv.set('tpac:lobby', lobby);
      const assignment = await createQuickMatch(opponent, me);
      res.status(200).json({ ok: true, matched: assignment });
      return;
    }

    const profile = await store.kv.get('tpac:profile:' + user.uid);
    const mine = lobby.find(e => e.uid === user.uid);
    if (mine) mine.joinedAt = new Date().toISOString();
    else lobby.push({ uid: user.uid, handle: await handleFor(user), average: (profile && Number(profile.average)) || 0, joinedAt: new Date().toISOString() });
    await store.kv.set('tpac:lobby', lobby);
    res.status(200).json({ ok: true, waiting: true });
  } catch (err) {
    console.error('tpac-lobby error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
