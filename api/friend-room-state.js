/* ============================================================
   GET /api/friend-room-state?code=ABCD&viewerId=...
   ------------------------------------------------------------
   Polled by every connected device every 1-2 seconds for room
   updates. Returns the room state with the viewer's perspective
   applied (e.g. the Subject's secret answer is stripped from
   everyone else's view during the playing phase).

   Returns: { ok, room } or { ok:false, error:'room_not_found' }
   ============================================================ */

'use strict';

const { getRoom, publicView } = require('../lib/friend-state.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Prevent any CDN caching; this is dynamic state.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  try {
    const code = String((req.query && req.query.code) || '').trim().toUpperCase();
    const viewerId = String((req.query && req.query.viewerId) || '').trim();
    if (!code) {
      res.status(400).json({ ok: false, error: 'code_required' });
      return;
    }
    const room = await getRoom(code);
    if (!room) {
      res.status(200).json({ ok: false, error: 'room_not_found' });
      return;
    }
    res.status(200).json({ ok: true, room: publicView(room, viewerId) });
  } catch (err) {
    console.error('[friend-room-state] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
