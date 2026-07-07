/* ============================================================
   POST /api/sr-blueprint-stripe-webhook
   ------------------------------------------------------------
   Mirrors api/ycyf-stripe-webhook.mjs but for paid Blueprint
   tiers. Kept SEPARATE from the YCYF and LQ webhooks so those
   products are untouched.

   On checkout.session.completed for product 'sr-blueprint':
     1. Pull cid + tier from the session metadata.
     2. Record the entitlement in KV: sr:entitlement:{cid}
        (idempotent; a re-delivered event overwrites with the
        same value).
     3. Stamp the GHL contact's sr_sku_tier so the rest of the
        funnel and any GHL automations see the paid tier.

   Linked Pair Light ('linked_pair_light') additionally:
     - The entitlement is written at tier 'deep' (the primary
       takes the full Deep assessment) with the SKU preserved.
     - An 8-char invite code is generated and a pair record is
       created: sr:pair:{code}, plus sr:pair-by-cid:{cid} so the
       pipeline and complete.html can find the pair from a cid,
       and sr:session:{stripeSessionId}:pair for session lookup.
     - Idempotent: a re-delivered event reuses the existing pair
       record instead of minting a second code.
     - The GHL tier stamp is 'Deep' so the funnel routes the
       primary into the Deep assessment.

   Stripe verifies the signature against the RAW request bytes.
   This file is an ES module (.mjs) so the "export const config"
   below disables Vercel's body parser, leaving the raw stream
   intact for constructEvent.

   Requires env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET_BLUEPRINT
   (falls back to STRIPE_WEBHOOK_SECRET for a shared endpoint).
   ============================================================ */

import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateInviteCode } = require('../lib/blueprint-invite-codes.js');

export const config = { api: { bodyParser: false } };

const ENTITLEMENT_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const PAIR_TTL_SECONDS = 60 * 60 * 24 * 90; // codes promised active 30 days; keep 90

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function stampContactTier(cid, assessmentTier, sku) {
  // The funnel and GHL automations match on capitalized tier values.
  const tierCapitalized = assessmentTier.charAt(0).toUpperCase() + assessmentTier.slice(1);
  const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
  const r = await fetch(baseUrl + '/api/sr-update-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: cid, sr_sku_tier: tierCapitalized, sr_purchase_type: 'blueprint_' + (sku || assessmentTier) }),
  });
  if (!r.ok) throw new Error('sr-update-contact returned ' + r.status);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_BLUEPRINT || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[sr-blueprint-stripe-webhook] STRIPE_WEBHOOK_SECRET_BLUEPRINT not configured');
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[sr-blueprint-stripe-webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') { res.status(200).send('ok'); return; }

  try {
    const session = event.data.object;
    const meta = session.metadata || {};
    if (meta.product !== 'sr-blueprint') { res.status(200).send('ignored'); return; }

    const cid = String(meta.cid || '').trim();
    const tier = String(meta.tier || '').trim().toLowerCase();
    if (!cid || ['light', 'medium', 'deep', 'linked_pair_light'].indexOf(tier) === -1) {
      console.error('[sr-blueprint-stripe-webhook] bad metadata:', JSON.stringify(meta));
      res.status(200).send('bad metadata'); // 200 so Stripe stops retrying a permanently bad event
      return;
    }

    const email = (session.customer_details && session.customer_details.email) || '';
    const isLinkedPair = tier === 'linked_pair_light';
    // A Linked Pair primary takes the full Deep assessment, so the
    // entitlement (what the pipeline gates on) is 'deep'; the SKU keeps
    // the commercial truth.
    const assessmentTier = isLinkedPair ? 'deep' : tier;

    await kv.set('sr:entitlement:' + cid, {
      cid,
      tier: assessmentTier,
      sku: tier,
      stripeSessionId: session.id,
      amountTotal: session.amount_total,
      email,
      paidAt: new Date().toISOString(),
    }, { ex: ENTITLEMENT_TTL_SECONDS });

    if (isLinkedPair) {
      // Reuse the existing pair on webhook re-delivery; never mint twice.
      const existingRef = await kv.get('sr:pair-by-cid:' + cid);
      if (!existingRef || !existingRef.code || !(await kv.get('sr:pair:' + existingRef.code))) {
        const code = await generateInviteCode(kv);
        const now = new Date().toISOString();
        const firstName = (session.customer_details && session.customer_details.name || '').split(' ')[0] || '';
        const pair = {
          code,
          tier: 'linked_pair_light',
          primary: {
            session_id: session.id,
            cid,
            first_name: firstName,
            email,
            completed_at: null,
          },
          secondary: {
            session_id: null,
            cid: null,
            first_name: null,
            email: null,
            completed_at: null,
          },
          status: 'awaiting_secondary',
          created_at: now,
          comparison_generated_at: null,
        };
        await kv.set('sr:pair:' + code, pair, { ex: PAIR_TTL_SECONDS });
        await kv.set('sr:pair-by-cid:' + cid, { code, role: 'primary' }, { ex: PAIR_TTL_SECONDS });
        await kv.set('sr:session:' + session.id + ':pair', { code }, { ex: PAIR_TTL_SECONDS });
      }
    }

    // GHL stamp is best-effort: the KV entitlement is the source of truth
    // for the assessment, and a GHL hiccup should not make Stripe retry.
    // Linked Pair stamps 'Deep' so the funnel routes into the Deep
    // assessment; the purchase type keeps the Linked Pair SKU visible.
    try { await stampContactTier(cid, assessmentTier, tier); }
    catch (err) { console.error('[sr-blueprint-stripe-webhook] GHL stamp failed (non-fatal):', err.message); }

    res.status(200).send('ok');
  } catch (err) {
    console.error('[sr-blueprint-stripe-webhook] handler error:', err);
    res.status(500).send('handler error'); // 5xx so Stripe retries transient failures
  }
}
