/* ============================================================
   POST /api/friend-finish-explain
   ------------------------------------------------------------
   Body: { code, playerId, cardId }
   Returns: { ok, room } or { ok:false, error }
   Errors: room_not_found, wrong_phase, not_subject,
           not_explain_card, not_reveal_phase, card_mismatch

   The current Subject taps "Done. Next card." in the EXPLAIN
   panel of a Choice+Explain card. Validates the caller is the
   current Subject and the current card requires an explain step,
   then advances exactly like friend-next-card (rotate Subject,
   advance deck, reset round state). No timer, no scoring; the
   advance is fully Subject-controlled.
   ============================================================ */
'use strict';
const { finishExplain } = require('../lib/friend-state.js');
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
    const cardId = body.cardId;
    if (!code || !playerId) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }
    res.status(200).json(await finishExplain({ code, playerId, cardId }));
  } catch (err) {
    console.error('[friend-finish-explain] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
