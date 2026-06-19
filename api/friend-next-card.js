/* ============================================================
   POST /api/friend-next-card
   ------------------------------------------------------------
   Body: { code, playerId }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, wrong_phase, not_subject,
           not_reveal_phase

   The current Subject advances the game:
     - On a scoring card → must be in reveal phase. Rotate Subject,
       advance deck, reset guesses, subPhase = 'guessing'.
     - On a talk card (reflection/discussion) → advance directly,
       no scoring required.
     - If a winner was locked in during the prior reveal, the
       phase transitions to 'gameOver' instead of dealing a new
       card.
   Round counter increments whenever the turn pointer wraps.
   ============================================================ */
'use strict';
const { nextCard } = require('../lib/friend-state.js');
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
    res.status(200).json(await nextCard({ code, playerId }));
  } catch (err) {
    console.error('[friend-next-card] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
