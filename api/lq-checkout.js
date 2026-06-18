/* ============================================================
   POST /api/lq-checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session for the Lovers Quest digital
   edition. The buyer is redirected to Stripe Checkout, completes
   payment, then Stripe pings /api/lq-stripe-webhook which creates
   the license and emails the access link.

   Body: { } (no params; we always sell the one digital SKU)
   Response: { url } -> redirect the browser here
   ============================================================ */

'use strict';

const Stripe = require('stripe');

module.exports = async (req, res) => {
  // Allow CORS so the store page (same-origin in prod, but keep it
  // robust for previews) can post to this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

    const priceId = process.env.STRIPE_PRICE_LOVERS_QUEST_DIGITAL;
    if (!priceId) {
      res.status(500).json({ error: 'STRIPE_PRICE_LOVERS_QUEST_DIGITAL not configured' });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card'],
      // Collect the buyer's name so we can personalize the access email
      // and the in-app watermark ("Licensed to <First Name>").
      billing_address_collection: 'auto',
      customer_creation: 'always',
      success_url: `${baseUrl}/store/lovers-quest-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/store/lovers-quest.html?checkout=cancelled`,
      metadata: { product: 'lovers-quest-digital' }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[lq-checkout] failed:', err);
    res.status(500).json({ error: err.message || 'Checkout session failed' });
  }
};
