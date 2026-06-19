/* ============================================================
   POST /api/friend-pair-players
   ------------------------------------------------------------
   Body: { code, hostId, playerIdA, playerIdB }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, cannot_pair_with_self,
           player_a_not_in_room, player_b_not_in_room,
           a_already_paired, b_already_paired
   Host pairs two players together.
   ============================================================ */
'use strict';
const { pairPlayers } = require('../lib/friend-state.js');
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
    const playerIdA = String(body.playerIdA || '').trim();
    const playerIdB = String(body.playerIdB || '').trim();
    if (!code || !hostId || !playerIdA || !playerIdB) {
      res.status(400).json({ ok: false, error: 'missing_fields' }); return;
    }
    res.status(200).json(await pairPlayers({ code, hostId, playerIdA, playerIdB }));
  } catch (err) {
    console.error('[friend-pair-players] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
