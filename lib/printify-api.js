/* ============================================================
   printify-api.js
   ------------------------------------------------------------
   Thin REST client for the Printify Orders API. The apparel
   Stripe webhook calls createPrintifyOrder after a successful
   payment to push the print job to Printify.

   Auth: Bearer PRINTIFY_API_TOKEN (generate in Printify dashboard,
   Account, Connections, with Read products and Manage orders).
   Shop: PRINTIFY_SHOP_ID, defaults to 21428039.

   This module is CommonJS so it matches the rest of lib/. The
   .mjs webhook imports the named export, the same way the Lovers
   Quest webhook imports lib/lq-licenses.js.
   ============================================================ */

'use strict';

const API_BASE = 'https://api.printify.com/v1';

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Valued', last: 'Customer' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/*
  Create a Printify order from a completed Stripe Checkout session.

  Params:
    stripeSessionId    string  becomes external_id (also used for idempotency)
    printifyProductId  string  from session metadata
    printifyVariantId  number  from session metadata
    quantity           number  defaults to 1
    customer           object  session.customer_details (name, email, phone)
    shippingAddress    object  Stripe address (line1, line2, city, state, postal_code, country)

  Returns the parsed Printify order object (includes id) on success.
  Throws on a non 2xx response so the webhook can return 500 and let
  Stripe retry.
*/
async function createPrintifyOrder(opts) {
  const token = process.env.PRINTIFY_API_TOKEN;
  const shopId = process.env.PRINTIFY_SHOP_ID || '21428039';
  if (!token) throw new Error('PRINTIFY_API_TOKEN not configured');

  const customer = opts.customer || {};
  const addr = opts.shippingAddress || {};
  const name = splitName(customer.name);
  const quantity = Math.min(5, Math.max(1, parseInt(opts.quantity, 10) || 1));

  const payload = {
    external_id: opts.stripeSessionId,
    label: 'Order from dennisnickens.com',
    line_items: [
      {
        product_id: opts.printifyProductId,
        variant_id: Number(opts.printifyVariantId),
        quantity: quantity
      }
    ],
    shipping_method: 1,
    is_printify_express: false,
    is_economy_shipping: false,
    send_shipping_notification: true,
    address_to: {
      first_name: name.first,
      last_name: name.last,
      email: customer.email || '',
      phone: customer.phone || '',
      country: addr.country || '',
      region: addr.state || '',
      address1: addr.line1 || '',
      address2: addr.line2 || '',
      city: addr.city || '',
      zip: addr.postal_code || ''
    }
  };

  const url = API_BASE + '/shops/' + shopId + '/orders.json';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      // Printify rejects requests with no User-Agent (returns 403). Required.
      'User-Agent': 'dennisnickens-apparel'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }

  if (!res.ok) {
    const detail = body && (body.message || body.error) ? (body.message || body.error) : text.slice(0, 400);
    throw new Error('Printify order create failed: ' + res.status + ' ' + detail);
  }

  return body;
}

module.exports = { createPrintifyOrder, splitName };
