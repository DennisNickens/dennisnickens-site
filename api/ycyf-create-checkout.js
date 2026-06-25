/* ============================================================
   POST /api/ycyf-create-checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session for the You Call Yourself A
   Friend digital edition. Mirrors api/lq-checkout.js. The buyer
   pays on Stripe, then Stripe pings /api/ycyf-stripe-webhook which
   creates the license and emails the access link.

   Body: { email? }  (optional, prefills the Stripe email field)
   Response: { url } -> redirect the browser here

   Requires env: STRIPE_SECRET_KEY, STRIPE_PRICE_YCYF
   ============================================================ */

'use strict';

const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { body = {}; }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

    const priceId = process.env.STRIPE_PRICE_YCYF;
    if (!priceId) {
      res.status(500).json({ error: 'STRIPE_PRICE_YCYF not configured' });
      return;
    }

    const email = String(body.email || '').trim();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card'],
      // Collect the buyer's name so we can personalize the access email.
      billing_address_collection: 'auto',
      customer_creation: 'always',
      customer_email: email || undefined,
      success_url: `${baseUrl}/games/friend/?activated=ycyf&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/store/you-call-yourself-a-friend.html?checkout=cancelled`,
      metadata: { product: 'ycyf-digital' }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[ycyf-create-checkout] failed:', err);
    res.status(500).json({ error: err.message || 'Checkout session failed' });
  }
};
