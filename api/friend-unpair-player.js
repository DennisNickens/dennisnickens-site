/* ============================================================
   POST /api/friend-unpair-player
   ------------------------------------------------------------
   Body: { code, hostId, playerId }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, not_in_pair
   Host removes a player (and their partner) from a pair.
   ============================================================ */
'use strict';
const { unpairPlayer } = require('../lib/friend-state.js');
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
    const playerId = String(body.playerId || '').trim();
    if (!code || !hostId || !playerId) {
      res.status(400).json({ ok: false, error: 'missing_fields' }); return;
    }
    res.status(200).json(await unpairPlayer({ code, hostId, playerId }));
  } catch (err) {
    console.error('[friend-unpair-player] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
