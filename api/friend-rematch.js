/* ============================================================
   POST /api/friend-rematch
   ------------------------------------------------------------
   Body: { code, hostId }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, pair_not_found

   Host taps Rematch on the game-over screen. Same teams (icons,
   names, members preserved), fresh deck, fresh pair turn order,
   scores back to 0, subjectIndex back to 0 on every pair so the
   alternation restarts. Routes back into the playing phase.
   ============================================================ */
'use strict';
const { rematch } = require('../lib/friend-state.js');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  let body; try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }
  try {
    const code = String(body.code || '').trim().toUpperCase();
    const hostId = String(body.hostId || '').trim();
    if (!code || !hostId) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }
    res.status(200).json(await rematch({ code, hostId }));
  } catch (err) {
    console.error('[friend-rematch] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
