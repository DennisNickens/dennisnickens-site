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

   Stripe verifies the signature against the RAW request bytes, so the
   body must not be parsed before we read it. This file is an ES module
   (.mjs) specifically so the "export const config = { api: { bodyParser:
   false } }" below is detected by Vercel's build, which disables the
   default body parser. The previous CommonJS form (module.exports.config)
   was not being detected on this commonjs project, so Vercel parsed and
   consumed the stream first, leaving the raw read empty and breaking
   signature verification with "No signatures found matching".
   ============================================================ */

import Stripe from 'stripe';
import { createLicense, findLicenseByEmail } from '../lib/lq-licenses.js';
import { sendAccessLink } from '../lib/lq-emails.js';

export const config = { api: { bodyParser: false } };

// Read the raw request body as a Buffer. Pass this Buffer straight to
// constructEvent. Never parse or re-stringify it; that would change the
// bytes and break the signature.
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

export default async function handler(req, res) {
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
    console.log('[lq-stripe-webhook] DIAGNOSTIC event.id=', event.id, 'session.id=', session.id, 'metadata=', JSON.stringify(session.metadata), 'mode=', session.mode, 'livemode=', event.livemode);
    const product = session.metadata && session.metadata.product;
    if (product !== 'lovers-quest-digital') {
      console.log('[lq-stripe-webhook] IGNORED event because product=', JSON.stringify(product), 'expected lovers-quest-digital');
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
}
