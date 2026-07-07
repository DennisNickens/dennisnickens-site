/* ============================================================
   /api/tpac-match — the live head-to-head match surface.
   ------------------------------------------------------------
   GET ?mid=ID -> full match state for the live scoreboard. Both
   bowlers poll this every couple of seconds; each poll also runs
   the bracket reconciler so ready-check forfeits, verification,
   and round advancement happen in real time.

   POST { action, mid, ... }:
     ready                    confirm presence for the ready check
     frame { frameIndex, rolls }  enter one frame of YOUR game
     photo { imageBase64 }    upload your overhead score screen
     confirm                  confirm your OPPONENT's score
     tiebreak { score }       one extra frame (0-30) on a tie

   Frame pace: entering a frame more than the bracket's per-frame
   time limit after your previous one adds a slow flag. Under the
   organizer's 'forfeit' policy, three flags forfeit the match.
   ============================================================ */

'use strict';

const { put } = require('@vercel/blob');
const store = require('../lib/tpac-store.js');
const engine = require('../lib/tpac-brackets.js');
const { validateFrame, scoreGame } = require('../lib/tpac-scoring.js');

async function matchView(match, bracket) {
  const view = { ...match, frames: {}, ready: {}, photos: {}, confirms: {}, scores: {} };
  for (const slot of match.slots) {
    if (!slot) continue;
    const fd = await engine.getFrames(match.id, slot.uid);
    const scored = scoreGame(fd.frames);
    view.frames[slot.uid] = fd.frames;
    view.scores[slot.uid] = {
      raw: scored.total,
      frameScores: scored.frameScores,
      complete: scored.complete,
      handicap: slot.handicap || 0,
      withHandicap: scored.total + (slot.handicap || 0),
      slowFlags: fd.slowFlags || 0,
    };
    view.ready[slot.uid] = !!(await store.kv.get('tpac:match:' + match.id + ':ready:' + slot.uid));
    view.photos[slot.uid] = (await store.kv.get('tpac:match:' + match.id + ':photo:' + slot.uid)) || null;
    view.confirms[slot.uid] = !!(await store.kv.get('tpac:match:' + match.id + ':confirm:' + slot.uid));
  }
  view.settings = {
    format: bracket.format,
    frameTimeLimitSeconds: bracket.frameTimeLimitSeconds,
    slowPolicy: bracket.slowPolicy,
    roundBreakMinutes: bracket.roundBreakMinutes,
  };
  return view;
}

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }
    if (!store.hasActiveSubscription(user)) { res.status(402).json({ ok: false, error: 'subscription_required' }); return; }

    const isGet = req.method === 'GET';
    const body = isGet ? {} : store.parseBody(req);
    const mid = String(isGet ? ((req.query && req.query.mid) || '') : (body.mid || '')).trim();
    if (!mid) { res.status(400).json({ ok: false, error: 'mid_required' }); return; }

    let match = await engine.getMatch(mid);
    if (!match) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    const bracket = await engine.getBracket(match.bid);
    if (!bracket) { res.status(404).json({ ok: false, error: 'bracket_not_found' }); return; }

    if (isGet) {
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, match: await matchView(match, bracket), myUid: user.uid, serverTimeUtc: new Date().toISOString() });
      return;
    }

    const mySlot = match.slots.find(s => s && s.uid === user.uid);
    if (!mySlot) { res.status(403).json({ ok: false, error: 'not_in_match' }); return; }
    const action = String(body.action || '');

    if (action === 'ready') {
      const opensAt = new Date(new Date(match.startAtUtc).getTime() - engine.READY_OPEN_MINUTES * 60000);
      if (new Date() < opensAt) { res.status(400).json({ ok: false, error: 'ready_check_not_open' }); return; }
      if (match.status !== 'ready_check') { res.status(400).json({ ok: false, error: 'not_in_ready_check' }); return; }
      await store.kv.set('tpac:match:' + mid + ':ready:' + user.uid, true, { ex: 60 * 60 * 6 });
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, match: await matchView(match, bracket), myUid: user.uid });
      return;
    }

    if (action === 'frame') {
      if (match.status !== 'live') { res.status(400).json({ ok: false, error: 'match_not_live' }); return; }
      const frameIndex = Number(body.frameIndex);
      const rolls = Array.isArray(body.rolls) ? body.rolls.map(Number) : [];
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 9) { res.status(400).json({ ok: false, error: 'bad_frame_index' }); return; }
      const invalid = validateFrame(rolls, frameIndex);
      if (invalid) { res.status(400).json({ ok: false, error: invalid }); return; }

      const key = 'tpac:match:' + mid + ':f:' + user.uid;
      const fd = await engine.getFrames(mid, user.uid);
      if (frameIndex > fd.frames.length) { res.status(400).json({ ok: false, error: 'frames_in_order' }); return; }

      // Pace clock: measured from the previous frame entry (or match start).
      const since = fd.lastFrameAt || match.startedAtUtc;
      if (frameIndex === fd.frames.length && since) {
        const elapsed = (Date.now() - new Date(since).getTime()) / 1000;
        if (elapsed > bracket.frameTimeLimitSeconds) fd.slowFlags = (fd.slowFlags || 0) + 1;
      }
      fd.frames[frameIndex] = rolls;
      fd.lastFrameAt = new Date().toISOString();
      await store.kv.set(key, fd);
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, match: await matchView(match, bracket), myUid: user.uid });
      return;
    }

    if (action === 'photo') {
      const b64 = String(body.imageBase64 || '');
      const commaIdx = b64.indexOf(',');
      const data = Buffer.from(commaIdx > -1 ? b64.slice(commaIdx + 1) : b64, 'base64');
      if (!data.length || data.length > 4 * 1024 * 1024) { res.status(400).json({ ok: false, error: 'bad_image' }); return; }
      const blob = await put('tpac/matches/' + mid + '-' + user.uid + '.jpg', data, {
        access: 'public',
        contentType: 'image/jpeg',
        addRandomSuffix: true,
      });
      await store.kv.set('tpac:match:' + mid + ':photo:' + user.uid, blob.url);
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, url: blob.url, match: await matchView(match, bracket), myUid: user.uid });
      return;
    }

    if (action === 'confirm') {
      const opponent = match.slots.find(s => s && s.uid !== user.uid);
      const oppPhoto = opponent ? await store.kv.get('tpac:match:' + mid + ':photo:' + opponent.uid) : null;
      if (!oppPhoto) { res.status(400).json({ ok: false, error: 'opponent_photo_missing' }); return; }
      await store.kv.set('tpac:match:' + mid + ':confirm:' + user.uid, true);
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, match: await matchView(match, bracket), myUid: user.uid });
      return;
    }

    if (action === 'tiebreak') {
      const score = Number(body.score);
      if (!Number.isInteger(score) || score < 0 || score > 30) { res.status(400).json({ ok: false, error: 'tiebreak_0_to_30' }); return; }
      match.tiebreak[user.uid] = score;
      await engine.saveMatch(match);
      await engine.reconcileBracket(bracket.id);
      match = await engine.getMatch(mid);
      res.status(200).json({ ok: true, match: await matchView(match, bracket), myUid: user.uid });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('tpac-match error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
