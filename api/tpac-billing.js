/* ============================================================
   POST /api/tpac-billing — Stripe subscription plumbing.
   ------------------------------------------------------------
   Body: { action: 'checkout' | 'portal' }  (Bearer auth required)

   checkout — creates a subscription Checkout Session with a
     7-day free trial on the T-PAC monthly price ($14/mo).
     This is normal SaaS access (the app + Ace). It is NOT a
     contest entry fee; tournament money never touches Stripe.
   portal — creates a Billing Portal session so the user can
     view or cancel their subscription.

   Requires env: STRIPE_SECRET_KEY, STRIPE_PRICE_TPAC,
   PUBLIC_SITE_URL
   ============================================================ */

'use strict';

const Stripe = require('stripe');
const store = require('../lib/tpac-store.js');

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }

    const action = String(store.parseBody(req).action || 'checkout');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

    if (action === 'portal') {
      if (!user.stripeCustomerId) { res.status(400).json({ ok: false, error: 'no_subscription' }); return; }
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: baseUrl + '/tpac/app.html#account',
      });
      res.status(200).json({ ok: true, url: portal.url });
      return;
    }

    const priceId = process.env.STRIPE_PRICE_TPAC;
    if (!priceId) { res.status(500).json({ ok: false, error: 'STRIPE_PRICE_TPAC not configured' }); return; }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 7,
        metadata: { product: 'tpac', uid: user.uid },
      },
      metadata: { product: 'tpac', uid: user.uid },
      success_url: baseUrl + '/tpac/app.html?sub=success',
      cancel_url: baseUrl + '/tpac/app.html?sub=canceled',
    });

    res.status(200).json({ ok: true, url: session.url });
  } catch (err) {
    console.error('tpac-billing error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
