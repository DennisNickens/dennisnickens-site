/* ============================================================
   POST /api/sr-blueprint-checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session for a paid Blueprint tier.
   Mirrors api/ycyf-create-checkout.js. The buyer pays on Stripe,
   then Stripe pings /api/sr-blueprint-stripe-webhook which marks
   the entitlement in KV and stamps the GHL contact, and the buyer
   lands back on confirm.html to continue the funnel.

   Body: { cid, tier, email? }
     cid   — GHL contact id (required, carried in metadata)
     tier  — 'light' | 'medium' | 'deep' (all tiers are paid:
             Light $47, Medium $97, Deep $147)
     email — optional, prefills the Stripe email field

   Response: { ok, url } -> redirect the browser here

   Requires env: STRIPE_SECRET_KEY, STRIPE_PRICE_BLUEPRINT_LIGHT,
   STRIPE_PRICE_BLUEPRINT_MEDIUM, STRIPE_PRICE_BLUEPRINT_DEEP,
   PUBLIC_SITE_URL
   ============================================================ */

'use strict';

const Stripe = require('stripe');

const TIER_PRICES = {
  light: 'STRIPE_PRICE_BLUEPRINT_LIGHT',
  medium: 'STRIPE_PRICE_BLUEPRINT_MEDIUM',
  deep: 'STRIPE_PRICE_BLUEPRINT_DEEP',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { body = {}; }

  try {
    const cid = String(body.cid || '').trim();
    if (!cid) { res.status(400).json({ ok: false, error: 'cid_required' }); return; }

    const tier = String(body.tier || '').trim().toLowerCase();
    const priceEnv = TIER_PRICES[tier];
    if (!priceEnv) { res.status(400).json({ ok: false, error: 'invalid_tier' }); return; }

    const priceId = process.env[priceEnv];
    if (!priceId) {
      res.status(500).json({ ok: false, error: priceEnv + ' not configured' });
      return;
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
    const email = String(body.email || '').trim();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card'],
      billing_address_collection: 'auto',
      customer_creation: 'always',
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: {
        product: 'sr-blueprint',
        cid: cid,
        tier: tier,
      },
      success_url: baseUrl + '/assessment/confirm.html?cid=' + encodeURIComponent(cid) + '&paid=1',
      cancel_url: baseUrl + '/assessment/tiers.html?cid=' + encodeURIComponent(cid) + '&canceled=1',
    });

    res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error('sr-blueprint-checkout error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
