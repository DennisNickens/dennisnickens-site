/* ============================================================
   Shared Blueprint generation + delivery pipeline.
   ------------------------------------------------------------
   Used by /api/sr-assessment-submit (inline, right after the
   answers land) and /api/sr-score-session (manual re-run or
   regeneration). One code path so scoring, rendering, storage,
   and delivery can never drift apart.

   Steps:
     1. Entitlement gate — the contact must have a paid
        entitlement (sr:entitlement:{cid}) whose tier covers the
        session tier. Every tier is paid (Light $47, Medium $97,
        Deep $147), so no entitlement means no Blueprint.
     2. Score      — deterministic TriLens engine
     3. Enrich     — Blueprint data (tier-gated sections)
     4. Render     — Blueprint HTML
     5. Store      — Blob (HTML) + KV (scores, blueprint, session)
     6. Deliver    — "Your Blueprint is ready" email via Resend
     7. Queue      — Day 3 + Day 7 follow-ups for the cron sweep
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const { scoreSession } = require('./trilens-scoring.js');
const { enrichBlueprintData, renderToHTML } = require('./trilens-renderer.js');
const { sendBlueprintReady } = require('./sr-blueprint-emails.js');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;
const FOLLOWUP_QUEUE_KEY = 'sr:followup-queue';
const TIER_RANK = { light: 1, medium: 2, deep: 3 };

let cachedBank = null;
function loadBank() {
  if (!cachedBank) {
    const p = path.join(process.cwd(), 'assessment', 'questions', 'bank.json');
    cachedBank = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return cachedBank;
}

async function fetchContact(cid) {
  try {
    const base = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
    const r = await fetch(base + '/api/sr-get-contact?cid=' + encodeURIComponent(cid));
    const data = await r.json();
    if (data && data.success && data.contact) return data.contact;
  } catch (_) { /* contact enrichment is best-effort */ }
  return null;
}

/**
 * Runs the full pipeline for a stored session.
 * Returns { ok, sessionId, tier, srCode, archetype, blueprintUrl }
 * Throws { code } style errors for the caller to map to HTTP.
 */
async function generateAndDeliver(sessionId) {
  const session = await kv.get('sr:session:' + sessionId);
  if (!session) { const e = new Error('session_not_found'); e.code = 'session_not_found'; throw e; }

  const responses = await kv.get('sr:responses:' + sessionId);
  if (!responses || !responses.answers) { const e = new Error('responses_not_found'); e.code = 'responses_not_found'; throw e; }

  // 1. Entitlement gate. A paid tier covers itself and anything below it.
  const entitlement = await kv.get('sr:entitlement:' + session.cid);
  const entitledRank = entitlement ? (TIER_RANK[entitlement.tier] || 0) : 0;
  const neededRank = TIER_RANK[session.tier] || 99;
  if (entitledRank < neededRank) {
    const e = new Error('payment_required');
    e.code = 'payment_required';
    throw e;
  }

  // 2-4. Score, enrich, render.
  const bank = loadBank();
  const scoring = scoreSession(session.tier, responses.answers, bank);

  const contact = await fetchContact(session.cid);
  const firstName = (contact && (contact.firstName || (contact.fields && contact.fields.first_name))) || '';
  const lastName = (contact && contact.lastName) || '';
  const email = (contact && contact.email) || (entitlement && entitlement.email) || '';

  const blueprint = enrichBlueprintData(scoring, { name: [firstName, lastName].filter(Boolean).join(' ') });
  const html = renderToHTML(blueprint);

  // 5. Store.
  const blob = await put('blueprints/' + sessionId + '.html', html, {
    access: 'public',
    contentType: 'text/html; charset=utf-8',
    addRandomSuffix: true,
  });

  await kv.set('sr:scores:' + sessionId, scoring, { ex: SESSION_TTL_SECONDS });
  await kv.set('sr:blueprint:' + sessionId, {
    sessionId,
    cid: session.cid,
    tier: scoring.tier,
    srCode: scoring.srCode,
    archetype: scoring.archetype,
    blueprintUrl: blob.url,
    data: blueprint,
    generatedAt: blueprint.generatedAt,
  }, { ex: SESSION_TTL_SECONDS });

  session.status = 'blueprint_generated';
  session.srCode = scoring.srCode;
  session.archetype = scoring.archetype;
  session.blueprintUrl = blob.url;
  await kv.set('sr:session:' + sessionId, session, { ex: SESSION_TTL_SECONDS });

  // Linked Pair bookkeeping. If this cid belongs to a pair, stamp this
  // side's completion, and when both sides are done mark the pair
  // ready_for_comparison (Phase 2 generates the Combined Report from
  // that status). A primary who still needs their person gets the
  // invite block appended to their delivery email. Non-fatal: a pair
  // hiccup never blocks the individual Blueprint.
  let pairInvite = null;
  try {
    const pairRef = await kv.get('sr:pair-by-cid:' + session.cid);
    if (pairRef && pairRef.code) {
      const pairKey = 'sr:pair:' + pairRef.code;
      const pair = await kv.get(pairKey);
      if (pair) {
        const side = pairRef.role === 'primary' ? pair.primary : pair.secondary;
        if (side) {
          if (!side.completed_at) side.completed_at = new Date().toISOString();
          side.assessment_session_id = sessionId;
          if (pairRef.role === 'secondary') side.session_id = sessionId;
        }
        if (pair.primary && pair.primary.completed_at && pair.secondary && pair.secondary.completed_at) {
          pair.status = 'ready_for_comparison';
        }
        await kv.set(pairKey, pair, { ex: SESSION_TTL_SECONDS });
        await kv.set('sr:session:' + sessionId + ':pair', { code: pairRef.code }, { ex: SESSION_TTL_SECONDS });

        if (pairRef.role === 'primary' && !(pair.secondary && pair.secondary.completed_at)) {
          const base = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
          pairInvite = {
            code: pairRef.code,
            joinUrl: base + '/assessment/?join=' + pairRef.code,
            secondaryFirstName: (pair.secondary && pair.secondary.first_name) || '',
          };
        }
      }
    }
  } catch (err) {
    console.error('[sr-blueprint-pipeline] pair bookkeeping failed (non-fatal):', err.message);
  }

  // 6-7. Deliver + queue follow-ups. Email failure does not undo
  // generation; the Blueprint exists and delivery can be retried by
  // re-running the pipeline (idempotent).
  let delivered = false;
  if (email) {
    try {
      await sendBlueprintReady({
        to: email,
        firstName,
        archetype: scoring.archetype,
        srCode: scoring.srCode,
        blueprintUrl: blob.url,
        pairInvite,
      });
      delivered = true;

      const now = Date.now();
      await kv.set('sr:followup:' + sessionId, {
        sessionId,
        cid: session.cid,
        email,
        firstName,
        archetype: scoring.archetype,
        growthArea: (blueprint.archetypeDetails && blueprint.archetypeDetails.growthAreas && blueprint.archetypeDetails.growthAreas[0]) || '',
        blueprintUrl: blob.url,
        day3DueAt: now + 3 * 24 * 60 * 60 * 1000,
        day7DueAt: now + 7 * 24 * 60 * 60 * 1000,
        day3Sent: false,
        day7Sent: false,
      }, { ex: SESSION_TTL_SECONDS });
      await kv.sadd(FOLLOWUP_QUEUE_KEY, sessionId);
    } catch (err) {
      console.error('[sr-blueprint-pipeline] delivery failed (blueprint still generated):', err.message);
    }
  } else {
    console.error('[sr-blueprint-pipeline] no email on file for cid ' + session.cid + '; blueprint generated but not delivered');
  }

  return {
    ok: true,
    sessionId,
    tier: scoring.tier,
    srCode: scoring.srCode,
    archetype: scoring.archetype,
    blueprintUrl: blob.url,
    delivered,
  };
}

module.exports = { generateAndDeliver, FOLLOWUP_QUEUE_KEY };
