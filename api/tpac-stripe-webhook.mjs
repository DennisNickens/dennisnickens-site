/* ============================================================
   POST /api/tpac-stripe-webhook — T-PAC subscription lifecycle.
   ------------------------------------------------------------
   Kept SEPARATE from the SR Blueprint, YCYF, LQ, and apparel
   webhooks so those products are untouched. Point a dedicated
   Stripe webhook endpoint here with events:
     checkout.session.completed
     customer.subscription.updated
     customer.subscription.deleted

   On checkout completion (metadata.product === 'tpac') the
   user's subStatus becomes the subscription's status (usually
   'trialing' thanks to the 7-day trial) and the Stripe customer
   id is linked. Subscription updates and cancellations sync the
   status so access follows billing automatically.

   Requires env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET_TPAC
   (falls back to STRIPE_WEBHOOK_SECRET for a shared endpoint).
   ============================================================ */

import Stripe from 'stripe';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const store = require('../lib/tpac-store.js');

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function syncStatus(uid, customerId, status) {
  const user = await store.getUserByUid(uid);
  if (!user) return;
  user.subStatus = status;
  if (customerId) user.stripeCustomerId = customerId;
  await store.saveUser(user);
  if (customerId) await store.kv.set('tpac:stripe:' + customerId, uid);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_TPAC || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[tpac-stripe-webhook] STRIPE_WEBHOOK_SECRET_TPAC not configured');
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[tpac-stripe-webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if ((session.metadata || {}).product !== 'tpac') { res.status(200).send('ignored'); return; }
      const uid = String(session.metadata.uid || '').trim();
      if (!uid) { res.status(200).send('bad metadata'); return; }
      let status = 'active';
      if (session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription));
          status = sub.status; // 'trialing' with the 7-day trial
        } catch (_) { /* default to active */ }
      }
      await syncStatus(uid, String(session.customer || ''), status);
      res.status(200).send('ok');
      return;
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const isTpac = (sub.metadata || {}).product === 'tpac';
      const customerId = String(sub.customer || '');
      let uid = (sub.metadata || {}).uid;
      if (!uid && customerId) uid = await store.kv.get('tpac:stripe:' + customerId);
      if (!uid) { res.status(200).send(isTpac ? 'no uid' : 'ignored'); return; }
      if (!isTpac) {
        // Customer id mapped to a T-PAC user but metadata missing: only
        // sync when we know the mapping came from tpac:stripe:.
        const mapped = await store.kv.get('tpac:stripe:' + customerId);
        if (!mapped) { res.status(200).send('ignored'); return; }
      }
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      await syncStatus(String(uid), customerId, status);
      res.status(200).send('ok');
      return;
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('[tpac-stripe-webhook] handler error:', err);
    res.status(500).send('handler error');
  }
}
