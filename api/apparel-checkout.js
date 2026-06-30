/* ============================================================
   POST /api/apparel-checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session for one apparel item. The
   product page posts the chosen variant, we look the variant up
   server side in lib/apparel-products.json (so the browser can
   never set its own price), then create the session.

   After payment Stripe pings /api/apparel-stripe-webhook, which
   creates the Printify order and emails the buyer.

   Body:
     {
       slug,                  product slug, e.g. "leading-the-pack-tee"
       printify_variant_id,   the chosen variant id
       quantity               1 to 5 (optional, defaults to 1)
     }
   We trust slug + printify_variant_id only. Price, label, and the
   printify_product_id are read from the source of truth, not the body.

   Response: { url } -> redirect the browser here.

   NOTE: this endpoint is staged and not live until task 107 is
   verified and the apparel env vars are set. Do not point a Stripe
   webhook at production until then.
   ============================================================ */

'use strict';

const Stripe = require('stripe');
const catalog = require('../lib/apparel-products.json');

// Countries we will ship to for v1. Expand this list as Printify
// fulfillment coverage is confirmed.
const SHIP_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'NZ', 'IE'];

function findVariant(slug, variantId) {
  const product = catalog && catalog.products && catalog.products[slug];
  if (!product) return { error: 'unknown product' };
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    return { error: 'not available yet' };
  }
  const variant = product.variants.find(function (v) {
    return String(v.printify_variant_id) === String(variantId);
  });
  if (!variant) return { error: 'unknown variant' };
  if (variant.is_available === false) return { error: 'variant unavailable' };
  if (!variant.price_cents) return { error: 'variant has no price' };
  return { product: product, variant: variant };
}

module.exports = async (req, res) => {
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
    let body = {};
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else if (typeof req.body === 'string' && req.body) {
      try { body = JSON.parse(req.body); } catch (e) { body = {}; }
    }
    const slug = String(body.slug || '');
    const variantId = body.printify_variant_id;
    const quantity = Math.min(5, Math.max(1, parseInt(body.quantity, 10) || 1));

    if (!slug || variantId == null) {
      res.status(400).json({ error: 'Missing slug or variant' });
      return;
    }

    const found = findVariant(slug, variantId);
    if (found.error) {
      const code = found.error === 'not available yet' ? 409 : 400;
      res.status(code).json({ error: 'Checkout not available: ' + found.error });
      return;
    }
    const product = found.product;
    const variant = found.variant;
    const variantLabel = [variant.color, variant.size].filter(Boolean).join(' / ');

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

    // Option A: use a pre-created Stripe Price when the setup script has
    // stored one. Otherwise fall back to a dynamic price built from the
    // server side price_cents. Either way the amount comes from our data,
    // never the browser.
    let lineItem;
    if (variant.stripe_price_id) {
      lineItem = { price: variant.stripe_price_id, quantity: quantity };
    } else {
      lineItem = {
        quantity: quantity,
        price_data: {
          currency: (catalog._meta && catalog._meta.currency) || 'usd',
          unit_amount: variant.price_cents,
          product_data: {
            name: product.title + (variantLabel ? ' (' + variantLabel + ')' : ''),
            images: product.hero_image ? [product.hero_image] : undefined
          }
        }
      };
    }

    // Optional flat shipping. If STRIPE_APPAREL_SHIPPING_CENTS is unset,
    // checkout shows free shipping. Dennis decides the shipping charge
    // before go live; we do not invent a number here.
    const shippingCents = parseInt(process.env.STRIPE_APPAREL_SHIPPING_CENTS, 10);
    const shippingOptions = Number.isFinite(shippingCents) && shippingCents > 0
      ? [{
          shipping_rate_data: {
            type: 'fixed_amount',
            display_name: 'Standard shipping',
            fixed_amount: { amount: shippingCents, currency: (catalog._meta && catalog._meta.currency) || 'usd' },
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 7 },
              maximum: { unit: 'business_day', value: 10 }
            }
          }
        }]
      : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      payment_method_types: ['card'],
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: SHIP_COUNTRIES },
      phone_number_collection: { enabled: true },
      customer_creation: 'always',
      shipping_options: shippingOptions,
      success_url: `${baseUrl}/store/apparel-thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/store/${slug}.html?checkout=cancelled`,
      metadata: {
        product: 'apparel',
        source: 'dennisnickens',
        slug: slug,
        product_title: product.title,
        printify_product_id: product.printify_product_id,
        printify_variant_id: String(variant.printify_variant_id),
        variant_label: variantLabel,
        quantity: String(quantity)
      }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[apparel-checkout] failed:', err);
    res.status(500).json({ error: err.message || 'Checkout session failed' });
  }
};
