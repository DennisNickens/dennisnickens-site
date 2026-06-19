/* ============================================================
   POST /api/friend-create-room
   ------------------------------------------------------------
   Body: { hostName }
   Returns: { ok, code, hostId, room }

   Creates a new game room in KV with the caller as the host
   (first player in the players list). Returns the join code,
   the host's session id (which the client stores locally), and
   the initial room state.
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
    const { room, hostId } = await createRoom({ hostName: hostName });
    res.status(200).json({ ok: true, code: room.code, hostId: hostId, room: room });
  } catch (err) {
    console.error('[friend-create-room] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
