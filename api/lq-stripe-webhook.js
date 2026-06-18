/* ============================================================
   POST /api/lq-stripe-webhook
   ------------------------------------------------------------
   Stripe pings this endpoint whenever something happens (payment
   success, payment failure, refund, etc.). We only act on
   checkout.session.completed for the Lovers Quest digital SKU.

   On success:
     1. Pull email + name out of the Stripe session.
     2. Generate a license token, store it in KV.
     3. Email the buyer their access link via Resend.

   Stripe requires the request body to be verified against a
   signing secret using the raw bytes, so we disable Vercel's
   automatic body parsing and read the raw buffer ourselves.
   ============================================================ */

'use strict';

const Stripe = require('stripe');
const { createLicense, findLicenseByEmail } = require('../lib/lq-licenses.js');
const { sendAccessLink } = require('../lib/lq-emails.js');

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function firstNameFromStripe(session) {
  // Stripe Checkout collects customer_details.name as a single string.
  const full = (session && session.customer_details && session.customer_details.name) || '';
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[lq-stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[lq-stripe-webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  // Acknowledge anything we don't act on so Stripe doesn't retry.
  if (event.type !== 'checkout.session.completed') {
    res.status(200).send('ok');
    return;
  }

  try {
    const session = event.data.object;
    const product = session.metadata && session.metadata.product;
    if (product !== 'lovers-quest-digital') {
      console.log('[lq-stripe-webhook] session for unrelated product:', product);
      res.status(200).send('ignored');
      return;
    }

    const email = (session.customer_details && session.customer_details.email) ||
                  session.customer_email ||
                  '';
    if (!email) {
      console.error('[lq-stripe-webhook] no email on checkout session', session.id);
      res.status(200).send('no email');
      return;
    }

    const firstName = firstNameFromStripe(session);

    // Idempotency: if this email already has a license (e.g. webhook
    // retried), don't create a second one. Email them the existing token.
    let token;
    const existing = await findLicenseByEmail(email);
    if (existing) {
      token = existing.token;
      console.log(`[lq-stripe-webhook] license already exists for ${email}`);
    } else {
      const created = await createLicense({
        email,
        firstName,
        product: 'lovers-quest',
        stripeSessionId: session.id
      });
      token = created.token;
      console.log(`[lq-stripe-webhook] created license for ${email}: ${token.slice(0, 8)}...`);
    }

    try {
      await sendAccessLink({ email, firstName, token });
      console.log(`[lq-stripe-webhook] access email sent to ${email}`);
    } catch (mailErr) {
      // Don't fail the webhook if email fails. Stripe will mark it
      // success either way; we have the license in KV and can resend.
      console.error('[lq-stripe-webhook] email send failed:', mailErr);
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('[lq-stripe-webhook] handler error:', err);
    res.status(500).send('handler error');
  }
};

// Disable Vercel's default body parser; Stripe signature verification needs the
// raw bytes. This MUST be attached after the handler is assigned to
// module.exports, otherwise the reassignment above would discard it.
module.exports.config = { api: { bodyParser: false } };
