/* ============================================================
   POST /api/friend-start-another-game
   ------------------------------------------------------------
   Body: { code, hostId }
   Returns: { ok, room, hostId, code } or { ok:false, error }

   Host-only continuation (#82). Dissolves the finished room and
   mints a brand new one with a fresh code + QR. Replaces the old
   Rematch flow. Joiners from the previous game do not carry over.
   ============================================================ */
'use strict';
const { startAnotherGame } = require('../lib/friend-state.js');
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
    res.status(200).json(await startAnotherGame({ code, hostId }));
  } catch (err) {
    console.error('[friend-start-another-game] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
