/* ============================================================
   POST /api/friend-set-team-icon
   ------------------------------------------------------------
   Body: { code, hostId, pairId, icon }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, invalid_icon,
           pair_not_found, icon_taken

   Host assigns an emoji icon to a pair during the pickingIcons
   sub-phase. Each pair must have a unique icon (no duplicates).
   Valid icons come from lib/friend-state.js TEAM_ICONS.
   ============================================================ */
'use strict';
const { setTeamIcon } = require('../lib/friend-state.js');
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
    const pairId = String(body.pairId || '').trim();
    const icon = String(body.icon || '').trim();
    if (!code || !hostId || !pairId || !icon) {
      res.status(400).json({ ok: false, error: 'missing_fields' }); return;
    }
    res.status(200).json(await setTeamIcon({ code, hostId, pairId, icon }));
  } catch (err) {
    console.error('[friend-set-team-icon] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
