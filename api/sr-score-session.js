/* ============================================================
   POST /api/sr-score-session
   ------------------------------------------------------------
   Body: { sessionId }

   Manual trigger / regeneration endpoint. Runs the shared
   Blueprint pipeline (lib/sr-blueprint-pipeline.js): entitlement
   gate, deterministic scoring, rendering, Blob + KV storage, and
   the delivery email with Day 3 / Day 7 follow-ups queued.

   The normal path runs this same pipeline inline from
   /api/sr-assessment-submit; this endpoint exists for re-runs
   (a failed email, a regenerated Blueprint after an engine
   update) and for testing.

   Idempotent: re-running rescores, re-renders, and re-sends.

   Returns: { ok, sessionId, srCode, archetype, tier, blueprintUrl, delivered }
   Errors: session_id_required, session_not_found,
           responses_not_found, payment_required
   ============================================================ */

'use strict';

const { generateAndDeliver } = require('../lib/sr-blueprint-pipeline.js');

const ERROR_STATUS = {
  session_not_found: 404,
  responses_not_found: 404,
  payment_required: 402,
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) { res.status(400).json({ ok: false, error: 'session_id_required' }); return; }

  try {
    const result = await generateAndDeliver(sessionId);
    res.status(200).json(result);
  } catch (err) {
    const status = ERROR_STATUS[err.code];
    if (status) { res.status(status).json({ ok: false, error: err.code }); return; }
    console.error('sr-score-session error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
