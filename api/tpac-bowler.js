/* ============================================================
   POST /api/tpac-bowler — profile, bag, and series writes.
   ------------------------------------------------------------
   Bearer auth required. Body: { action, ... }

     profile.save  { profile }          save onboarding answers /
                                        edits; marks the account
                                        onboarded
     balls.add     { ball }             -> { ok, ball } (id assigned)
     balls.update  { ball }             matched by ball.id
     balls.delete  { id }
     series.add    { series }           { date, center, pattern?,
                                          games:[..], notes? }

   Reads come back through GET /api/tpac-me.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const store = require('../lib/tpac-store.js');

const MAX_BALLS = 24;
const MAX_SERIES = 100;

function cleanStr(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 200);
}

function cleanBall(input) {
  return {
    name: cleanStr(input.name, 80),
    coverstock: cleanStr(input.coverstock, 80),
    layout: cleanStr(input.layout, 200),
    surface: cleanStr(input.surface, 80),
    role: cleanStr(input.role, 40),
  };
}

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }

    const body = store.parseBody(req);
    const action = String(body.action || '');

    if (action === 'profile.save') {
      const p = body.profile || {};
      const profile = {
        handle: cleanStr(p.handle, 60),
        hand: cleanStr(p.hand, 20),
        delivery: cleanStr(p.delivery, 20),
        thumb: cleanStr(p.thumb, 20),
        style: cleanStr(p.style, 30),
        ballSpeed: cleanStr(p.ballSpeed, 30),
        revRate: cleanStr(p.revRate, 30),
        average: cleanStr(p.average, 10),
        highGame: cleanStr(p.highGame, 10),
        highSeries: cleanStr(p.highSeries, 10),
        homeCenter: cleanStr(p.homeCenter, 120),
        goal: cleanStr(p.goal, 300),
        updatedAt: new Date().toISOString(),
      };
      await store.kv.set('tpac:profile:' + user.uid, profile);
      if (!user.onboarded) { user.onboarded = true; await store.saveUser(user); }
      res.status(200).json({ ok: true, profile });
      return;
    }

    if (action === 'balls.add' || action === 'balls.update' || action === 'balls.delete') {
      const key = 'tpac:balls:' + user.uid;
      const balls = (await store.kv.get(key)) || [];

      if (action === 'balls.add') {
        if (balls.length >= MAX_BALLS) { res.status(400).json({ ok: false, error: 'bag_full' }); return; }
        const ball = cleanBall(body.ball || {});
        if (!ball.name) { res.status(400).json({ ok: false, error: 'ball_name_required' }); return; }
        ball.id = crypto.randomUUID();
        balls.push(ball);
        await store.kv.set(key, balls);
        res.status(200).json({ ok: true, ball, balls });
        return;
      }

      if (action === 'balls.update') {
        const incoming = body.ball || {};
        const idx = balls.findIndex(b => b.id === incoming.id);
        if (idx === -1) { res.status(404).json({ ok: false, error: 'ball_not_found' }); return; }
        const ball = cleanBall(incoming);
        if (!ball.name) { res.status(400).json({ ok: false, error: 'ball_name_required' }); return; }
        ball.id = incoming.id;
        balls[idx] = ball;
        await store.kv.set(key, balls);
        res.status(200).json({ ok: true, ball, balls });
        return;
      }

      const remaining = balls.filter(b => b.id !== body.id);
      await store.kv.set(key, remaining);
      res.status(200).json({ ok: true, balls: remaining });
      return;
    }

    if (action === 'series.add') {
      const s = body.series || {};
      const games = (Array.isArray(s.games) ? s.games : [])
        .map(Number)
        .filter(g => Number.isInteger(g) && g >= 0 && g <= 300)
        .slice(0, 8);
      if (!games.length) { res.status(400).json({ ok: false, error: 'games_required' }); return; }
      const entry = {
        id: crypto.randomUUID(),
        date: cleanStr(s.date, 20) || new Date().toISOString().slice(0, 10),
        center: cleanStr(s.center, 120),
        pattern: cleanStr(s.pattern, 80),
        games,
        notes: cleanStr(s.notes, 500),
        loggedAt: new Date().toISOString(),
      };
      const key = 'tpac:series:' + user.uid;
      const series = (await store.kv.get(key)) || [];
      series.unshift(entry);
      await store.kv.set(key, series.slice(0, MAX_SERIES));
      res.status(200).json({ ok: true, series: series.slice(0, 10) });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('tpac-bowler error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
