/* ============================================================
   POST /api/friend-create-room
   ------------------------------------------------------------
   Body: { hostName, gender }
   Returns: { ok, code, hostId, room }
   Errors: host_name_required, invalid_gender

   Creates a new game room in KV with the caller as the host
   (first player in the players list). gender is required and must
   be "male" or "female" (gates gendered Choice+Explain card pools).
   Returns the join code, the host's session id (which the client
   stores locally), and the initial room state.
   ============================================================ */

'use strict';

const { createRoom } = require('../lib/friend-state.js');

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
    const hostName = String(body.hostName || '').trim();
    if (!hostName) {
      res.status(400).json({ ok: false, error: 'host_name_required' });
      return;
    }
    const gender = String(body.gender || '').trim().toLowerCase();
    if (gender !== 'male' && gender !== 'female') {
      res.status(400).json({ ok: false, error: 'invalid_gender' });
      return;
    }
    const result = await createRoom({ hostName: hostName, gender: gender });
    if (result && result.ok === false) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json({ ok: true, code: result.room.code, hostId: result.hostId, room: result.room });
  } catch (err) {
    console.error('[friend-create-room] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
