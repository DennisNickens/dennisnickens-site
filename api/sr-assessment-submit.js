/* ============================================================
   POST /api/sr-assessment-submit
   ------------------------------------------------------------
   Body: { cid, tier, answers }
     cid     — GHL contact id (system of record for the person)
     tier    — 'light' | 'medium' | 'deep'
     answers — { core_q1: {a:1,b:3,c:2,d:4}, ... } ranked-choice
               maps, one entry per question id, rank 1 = most
               like the respondent.

   Stores the raw response set in KV under sr:responses:{sessionId}
   and a session record under sr:session:{sessionId}, then runs the
   shared Blueprint pipeline inline (lib/sr-blueprint-pipeline.js):
   entitlement gate, scoring, rendering, storage, delivery email,
   and Day 3 / Day 7 follow-up queueing. Rendering is deterministic
   and fast (no model calls), so inline generation keeps the flow
   simple: when this endpoint returns ok, the Blueprint exists and
   the email is on its way.

   Returns: { ok, sessionId, srCode, archetype, blueprintUrl, delivered }
   Errors: cid_required, invalid_tier, answers_required,
           too_few_answers, payment_required
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const { generateAndDeliver } = require('../lib/sr-blueprint-pipeline.js');

const VALID_TIERS = ['light', 'medium', 'deep'];
// Minimum answer counts per tier; deep allows the engine's 80%
// completeness threshold rather than demanding all 170.
const MIN_ANSWERS = { light: 18, medium: 62, deep: 136 };
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

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
    const cid = String(body.cid || '').trim();
    if (!cid) { res.status(400).json({ ok: false, error: 'cid_required' }); return; }

    const tier = String(body.tier || '').trim().toLowerCase();
    if (VALID_TIERS.indexOf(tier) === -1) {
      res.status(400).json({ ok: false, error: 'invalid_tier' });
      return;
    }

    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      res.status(400).json({ ok: false, error: 'answers_required' });
      return;
    }

    const answerCount = Object.keys(answers).length;
    if (answerCount < (MIN_ANSWERS[tier] || 18)) {
      res.status(400).json({ ok: false, error: 'too_few_answers', received: answerCount });
      return;
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const session = {
      id: sessionId,
      cid: cid,
      tier: tier,
      status: 'assessment_complete',
      answerCount: answerCount,
      createdAt: now,
    };

    await kv.set('sr:session:' + sessionId, session, { ex: SESSION_TTL_SECONDS });
    await kv.set('sr:responses:' + sessionId, { sessionId: sessionId, cid: cid, tier: tier, answers: answers, submittedAt: now }, { ex: SESSION_TTL_SECONDS });
    // Pointer so the contact's latest session is findable by cid.
    await kv.set('sr:latest-session:' + cid, sessionId, { ex: SESSION_TTL_SECONDS });

    // Run the full pipeline inline: gate, score, render, store, deliver.
    try {
      const result = await generateAndDeliver(sessionId);
      res.status(200).json(result);
    } catch (err) {
      if (err.code === 'payment_required') {
        res.status(402).json({ ok: false, error: 'payment_required', sessionId: sessionId });
        return;
      }
      // Answers are safely stored; generation can be retried via
      // /api/sr-score-session without the customer re-answering.
      console.error('sr-assessment-submit pipeline error:', err);
      res.status(200).json({ ok: true, sessionId: sessionId, generated: false, note: 'answers_stored_generation_pending' });
    }
  } catch (err) {
    console.error('sr-assessment-submit error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
