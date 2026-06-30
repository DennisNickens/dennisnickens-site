/* ============================================================
   POST /api/apparel-stripe-webhook
   ------------------------------------------------------------
   Stripe pings this endpoint after events. We act only on
   checkout.session.completed for an apparel session.

   On success:
     1. Pull variant + shipping info out of the session.
     2. Create the Printify print order.
     3. Email the buyer a confirmation via Resend.

   Stripe verifies the signature against the RAW request bytes, so
   the body must not be parsed first. This file is an ES module
   (.mjs) so "export const config = { api: { bodyParser: false } }"
   is detected by Vercel and the default body parser stays off. This
   matches the fix applied to the Lovers Quest and YCYF webhooks.

   STAGED, not live. Do not create the production Stripe webhook
   destination or set STRIPE_WEBHOOK_SECRET_APPAREL until task 107
   is verified and a test order has flowed end to end.
   ============================================================ */

import Stripe from 'stripe';
import { createPrintifyOrder } from '../lib/printify-api.js';
import { sendApparelConfirmation } from '../lib/apparel-emails.js';

export const config = { api: { bodyParser: false } };

// Read the raw request body as a Buffer. Pass it straight to
// constructEvent. Never parse or re-stringify it; that changes the
// bytes and breaks the signature.
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

// Stripe has moved the collected shipping address around across API
// versions. Check the common locations and fall back to the billing
// address so we always have something to ship to.
function shippingAddressFrom(session) {
  if (session.shipping_details && session.shipping_details.address) return session.shipping_details.address;
  if (session.collected_information && session.collected_information.shipping_details && session.collected_information.shipping_details.address) {
    return session.collected_information.shipping_details.address;
  }
  if (session.customer_details && session.customer_details.address) return session.customer_details.address;
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_APPAREL;
  if (!webhookSecret) {
    console.error('[apparel-stripe-webhook] STRIPE_WEBHOOK_SECRET_APPAREL not configured');
    res.status(500).send('Webhook secret not configured');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[apparel-stripe-webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  // Acknowledge anything we do not act on so Stripe stops retrying.
  if (event.type !== 'checkout.session.completed') {
    res.status(200).send('ok');
    return;
  }

  const session = event.data.object;
  const meta = session.metadata || {};
  if (meta.product !== 'apparel') {
    console.log('[apparel-stripe-webhook] not an apparel session:', meta.product);
    res.status(200).send('ignored');
    return;
  }

  // Fulfill via Printify. If this throws we return 500 so Stripe retries.
  // external_id is the Stripe session id, which lets us trace duplicates
  // in the Printify dashboard if a retry slips through.
  let printifyOrder;
  try {
    printifyOrder = await createPrintifyOrder({
      stripeSessionId: session.id,
      printifyProductId: meta.printify_product_id,
      printifyVariantId: meta.printify_variant_id,
      quantity: meta.quantity,
      customer: session.customer_details,
      shippingAddress: shippingAddressFrom(session)
    });
    console.log('[apparel-stripe-webhook] printify order created:', printifyOrder && printifyOrder.id, 'for session', session.id);
  } catch (err) {
    console.error('[apparel-stripe-webhook] printify order failed:', err.message, 'session', session.id);
    res.status(500).send('printify order failed');
    return;
  }

  // Email is best effort. A mail failure must not make Stripe retry a
  // charge that already produced a print order.
  try {
    await sendApparelConfirmation({
      email: (session.customer_details && session.customer_details.email) || session.customer_email,
      firstName: firstNameFromStripe(session),
      productTitle: meta.product_title,
      variantLabel: meta.variant_label,
      quantity: meta.quantity,
      printifyOrderId: printifyOrder && printifyOrder.id
    });
    console.log('[apparel-stripe-webhook] confirmation email sent for session', session.id);
  } catch (mailErr) {
    console.error('[apparel-stripe-webhook] email send failed:', mailErr.message);
  }

  res.status(200).send('ok');
}
