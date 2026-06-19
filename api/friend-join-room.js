/* ============================================================
   POST /api/friend-join-room
   ------------------------------------------------------------
   Body: { code, name }
   Returns: { ok, playerId, room } on success
            { ok:false, error } on failure (room_not_found,
            game_already_started, room_full, name_required)
   ============================================================ */

'use strict';

const { joinRoom } = require('../lib/friend-state.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

  try {
    const code = String(body.code || '').trim().toUpperCase();
    const name = String(body.name || '').trim();
    if (!code) {
      res.status(400).json({ ok: false, error: 'code_required' });
      return;
    }
    const result = await joinRoom(code, name);
    if (!result.ok) {
      res.status(200).json(result); // structured failure, not a 500
      return;
    }
    res.status(200).json({
      ok: true,
      playerId: result.playerId,
      room: result.room
    });
  } catch (err) {
    console.error('[friend-join-room] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
