/* ============================================================
   POST /api/friend-start-pairing
   ------------------------------------------------------------
   Body: { code, hostId }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, too_few_players,
           odd_player_count
   Host moves the room from lobby -> pairing.
   ============================================================ */
'use strict';
const { startPairing } = require('../lib/friend-state.js');
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
    res.status(200).json(await startPairing({ code, hostId }));
  } catch (err) {
    console.error('[friend-start-pairing] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
