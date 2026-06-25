/* ============================================================
   POST /api/ycyf-stripe-webhook
   ------------------------------------------------------------
   Mirrors api/lq-stripe-webhook.js but for the YCYF digital SKU.
   Kept SEPARATE from the LQ webhook so Lovers Quest is untouched.

   On checkout.session.completed for product 'ycyf-digital':
     1. Pull email + name from the Stripe session.
     2. Create a ycyf:license:<token> record in KV (idempotent).
     3. Email the buyer their ?access=<token> link via Resend.

   Stripe signature verification needs the raw request bytes, so we
   disable Vercel's body parser and read the buffer ourselves.

   Requires env: STRIPE_SECRET_KEY, plus STRIPE_WEBHOOK_SECRET_YCYF
   (the signing secret for the YCYF webhook endpoint Dennis adds in
   the Stripe Dashboard). Falls back to STRIPE_WEBHOOK_SECRET if a
   YCYF-specific secret is not set (e.g. one shared endpoint).
   ============================================================ */

'use strict';

const Stripe = require('stripe');
const { createLicense, findLicenseByEmail } = require('../lib/ycyf-licenses.js');
const { sendAccessLink } = require('../lib/ycyf-emails.js');

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function firstNameFromStripe(session) {
  const full = (session && session.customer_details && session.customer_details.name) || '';
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_YCYF || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[ycyf-stripe-webhook] STRIPE_WEBHOOK_SECRET_YCYF not configured');
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[ycyf-stripe-webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') { res.status(200).send('ok'); return; }

  try {
    const session = event.data.object;
    const product = session.metadata && session.metadata.product;
    if (product !== 'ycyf-digital') {
      // Not ours (e.g. an LQ event also delivered to this endpoint). Ignore.
      res.status(200).send('ignored');
      return;
    }

    const email = (session.customer_details && session.customer_details.email) ||
                  session.customer_email || '';
    if (!email) {
      console.error('[ycyf-stripe-webhook] no email on checkout session', session.id);
      res.status(200).send('no email');
      return;
    }

    const firstName = firstNameFromStripe(session);

    // Idempotency: if a webhook retry fires, do not create a second license.
    let token;
    const existing = await findLicenseByEmail(email);
    if (existing) {
      token = existing.token;
      console.log(`[ycyf-stripe-webhook] license already exists for ${email}`);
    } else {
      const created = await createLicense({
        email,
        firstName,
        product: 'ycyf',
        stripeSessionId: session.id
      });
      token = created.token;
      console.log(`[ycyf-stripe-webhook] created license for ${email}: ${token.slice(0, 8)}...`);
    }

    try {
      await sendAccessLink({ email, firstName, token });
      console.log(`[ycyf-stripe-webhook] access email sent to ${email}`);
    } catch (mailErr) {
      console.error('[ycyf-stripe-webhook] email send failed:', mailErr);
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('[ycyf-stripe-webhook] handler error:', err);
    res.status(500).send('handler error');
  }
};

// Disable Vercel's default body parser; Stripe signature verification needs the
// raw bytes. Attached after module.exports is assigned.
module.exports.config = { api: { bodyParser: false } };
