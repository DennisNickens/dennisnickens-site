/* ============================================================
   POST /api/friend-submit-truth
   ------------------------------------------------------------
   Body: { code, playerId, truth }
   Returns: { ok, room } or { ok:false, error, waitingOn? }
   Errors: room_not_found, wrong_phase, not_guessing_phase,
           not_subject, card_not_found, card_has_no_truth,
           invalid_truth, waiting_for_guessers

   The current Subject locks in the truth for the current card.
   Validates that all non-Subject players have already submitted
   their guess; if not, returns waitingOn (names of who hasn't).
   When all guesses are in, runs the scoring engine, applies the
   deltas to pair scores (capped at room.cap, default 25), sets
   subPhase to 'reveal', and writes the full reveal detail to
   room.lastReveal so the clients can render the scoreboard.
   ============================================================ */
'use strict';
const { submitTruth } = require('../lib/friend-state.js');
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
    const truth = String(body.truth || '').trim();
    if (!code || !playerId || !truth) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }
    res.status(200).json(await submitTruth({ code, playerId, truth }));
  } catch (err) {
    console.error('[friend-submit-truth] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
