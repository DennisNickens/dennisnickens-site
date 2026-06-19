/* ============================================================
   POST /api/friend-remove-player
   ------------------------------------------------------------
   Body: { code, hostId, targetPlayerId }
   Returns: { ok, room } on success
            { ok:false, error } on failure (room_not_found,
            not_host, game_already_started, cannot_remove_host,
            player_not_found)

   The host removes a player from the lobby. Only the host can call
   this; non-hosts get { ok:false, error:'not_host' }. The host
   cannot remove themselves through this endpoint.
   ============================================================ */

'use strict';

const { removePlayer } = require('../lib/friend-state.js');

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
    const hostId = String(body.hostId || '').trim();
    const targetPlayerId = String(body.targetPlayerId || '').trim();
    if (!code || !hostId || !targetPlayerId) {
      res.status(400).json({ ok: false, error: 'missing_fields' });
      return;
    }
    const result = await removePlayer({ code, hostId, targetPlayerId });
    res.status(200).json(result);
  } catch (err) {
    console.error('[friend-remove-player] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
