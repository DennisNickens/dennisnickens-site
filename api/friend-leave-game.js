/* ============================================================
   POST /api/friend-leave-game
   ------------------------------------------------------------
   Body: { code, playerId }
   Returns: { ok }

   A joiner leaves at game-over (#82). Removes them from the room
   roster server-side (enforced, not just a client hide). Called on
   the Leave button and on the 30s auto-disconnect timer.
   ============================================================ */
'use strict';
const { leaveGame } = require('../lib/friend-state.js');
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
    const playerId = String(body.playerId || '').trim();
    if (!code || !playerId) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }
    res.status(200).json(await leaveGame({ code, playerId }));
  } catch (err) {
    console.error('[friend-leave-game] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
