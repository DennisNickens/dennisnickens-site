/* ============================================================
   POST /api/friend-set-team-name
   ------------------------------------------------------------
   Body: { code, hostId, pairId, teamName }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, not_host, wrong_phase, pair_not_found

   Host sets (or clears) a pair's optional team name during the
   teamSetup phase. Empty string clears the name. Trimmed and
   capped at 24 chars by the state library.
   ============================================================ */
'use strict';
const { setTeamName } = require('../lib/friend-state.js');
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
    // teamName may legitimately be empty (clear); only require the other three.
    if (!code || !hostId || !pairId) {
      res.status(400).json({ ok: false, error: 'missing_fields' }); return;
    }
    res.status(200).json(await setTeamName({ code, hostId, pairId, teamName: body.teamName }));
  } catch (err) {
    console.error('[friend-set-team-name] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
