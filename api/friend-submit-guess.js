/* ============================================================
   POST /api/friend-submit-guess
   ------------------------------------------------------------
   Body: { code, playerId, guess }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, wrong_phase, not_guessing_phase,
           subject_cannot_guess, not_in_game, card_not_found,
           card_has_no_guess, invalid_guess

   A non-Subject player records their pick for the current card.
   The guess shape depends on card type:
     mc4 → 'A' | 'B' | 'C' | 'D'
     mc6 → 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
     tf  → 'T' | 'F'
     group_vote → a playerId in the room (cannot vote for self)
   ============================================================ */
'use strict';
const { submitGuess } = require('../lib/friend-state.js');
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
    const guess = String(body.guess || '').trim();
    if (!code || !playerId || !guess) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }
    res.status(200).json(await submitGuess({ code, playerId, guess }));
  } catch (err) {
    console.error('[friend-submit-guess] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
