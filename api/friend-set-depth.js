/* ============================================================
   POST /api/friend-set-depth
   ------------------------------------------------------------
   Body: { code, hostId, depth }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, invalid_depth,
           depth_coming_soon

   Host picks the deck depth during the teamSetup phase. Valid
   values come from VALID_DEPTHS (light/real/deep). Only depths in
   SELECTABLE_DEPTHS are actually playable today; the rest return
   depth_coming_soon and the picker UI displays them as locked
   "Coming soon" tiles. Default depth is 'real' (set on entry to
   teamSetup).
   ============================================================ */
'use strict';
const { setDepth } = require('../lib/friend-state.js');
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
    const depth = String(body.depth || '').trim().toLowerCase();
    if (!code || !hostId || !depth) {
      res.status(400).json({ ok: false, error: 'missing_fields' }); return;
    }
    res.status(200).json(await setDepth({ code, hostId, depth }));
  } catch (err) {
    console.error('[friend-set-depth] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
