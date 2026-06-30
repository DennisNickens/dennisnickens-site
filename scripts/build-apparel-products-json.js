#!/usr/bin/env node
/* ============================================================
   build-apparel-products-json.js
   ------------------------------------------------------------
   One time (and re-runnable) setup script. Reads the product
   list in lib/apparel-products.json, pulls each product from
   the Printify API, and fills in the colors, sizes, and
   variants (variant id, color, size, price, availability).

   By default this is READ ONLY against Printify (GET calls).
   Stripe Price creation is opt in with --create-stripe-prices.

   USAGE
     PRINTIFY_API_TOKEN=xxx PRINTIFY_SHOP_ID=21428039 \
       node scripts/build-apparel-products-json.js [--dry-run] [--create-stripe-prices]

   FLAGS
     --dry-run                Print what would change, write nothing.
     --create-stripe-prices   Also create one Stripe Product per tee
                              and one Stripe Price per enabled variant,
                              storing the price id on each variant.
                              Requires STRIPE_SECRET_KEY. Writes to Stripe.

   ENV
     PRINTIFY_API_TOKEN   required. Read products scope is enough for the
                          default run. Generate in Printify dashboard.
     PRINTIFY_SHOP_ID     defaults to 21428039 if unset.
     STRIPE_SECRET_KEY    required only with --create-stripe-prices.

   NOTE
     This script does not touch the checkout endpoint or the webhook.
     It only prepares data. Safe to run before those exist.
   ============================================================ */
const fs = require("fs");
const path = require("path");

// Load scripts/.env (minimal parser, no dependency) so the documented
// command works without exporting vars first. A real process.env value
// always wins over the file.
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();

const ROOT = path.resolve(__dirname, "..");
const JSON_PATH = path.join(ROOT, "lib", "apparel-products.json");

// Canonical apparel size order. Printify returns sizes in a jumbled order,
// so we sort the size list for a clean picker. Unknown sizes (e.g. cap one
// size labels) keep their encounter order at the end.
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
function sortSizes(list) {
  const known = [], unknown = [];
  list.forEach(function (s) {
    (SIZE_ORDER.indexOf(s) !== -1 ? known : unknown).push(s);
  });
  known.sort(function (a, b) { return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b); });
  return known.concat(unknown);
}

const DRY_RUN = process.argv.includes("--dry-run");
const CREATE_STRIPE = process.argv.includes("--create-stripe-prices");

const TOKEN = process.env.PRINTIFY_API_TOKEN;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID || "21428039";

function die(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

if (!TOKEN) die("PRINTIFY_API_TOKEN is not set. Generate one in Printify dashboard, Account, Connections.");
if (typeof fetch !== "function") die("global fetch is missing. Use Node 18 or newer.");

async function getPrintifyProduct(productId) {
  const url = "https://api.printify.com/v1/shops/" + SHOP_ID + "/products/" + productId + ".json";
  // Printify rejects requests with no User-Agent (returns 403). Required.
  const res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN, "User-Agent": "dennisnickens-apparel" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("Printify GET " + productId + " failed: " + res.status + " " + body.slice(0, 300));
  }
  return res.json();
}

// Build a value id to { type, title } map from the product options.
function buildValueMap(printifyProduct) {
  const map = {};
  (printifyProduct.options || []).forEach(function (opt) {
    const type = (opt.type || opt.name || "").toLowerCase();
    (opt.values || []).forEach(function (val) {
      map[val.id] = { type: type, title: val.title };
    });
  });
  return map;
}

function classify(valueMap, variant) {
  let color = null, size = null;
  (variant.options || []).forEach(function (valId) {
    const v = valueMap[valId];
    if (!v) return;
    if (v.type.indexOf("color") !== -1) color = v.title;
    else if (v.type.indexOf("size") !== -1) size = v.title;
    else if (!size) size = v.title; // fall back for single option products
  });
  // Last resort: split the variant title "Black / S".
  if ((!color || !size) && typeof variant.title === "string" && variant.title.indexOf("/") !== -1) {
    const parts = variant.title.split("/").map(function (s) { return s.trim(); });
    if (!color) color = parts[0] || null;
    if (!size) size = parts[1] || parts[0] || null;
  }
  return { color: color, size: size };
}

async function maybeCreateStripePrices(productEntry) {
  if (!CREATE_STRIPE) return;
  if (!process.env.STRIPE_SECRET_KEY) die("--create-stripe-prices needs STRIPE_SECRET_KEY.");
  const Stripe = require("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const stripeProduct = await stripe.products.create({
    name: productEntry.title,
    metadata: { source: "dennisnickens-apparel", slug: productEntry.slug }
  });

  for (const variant of productEntry.variants) {
    if (variant.is_available === false) continue;
    const price = await stripe.prices.create({
      product: stripeProduct.id,
      currency: "usd",
      unit_amount: variant.price_cents,
      nickname: productEntry.title + " " + (variant.color || "") + " " + (variant.size || ""),
      metadata: { slug: productEntry.slug, printify_variant_id: String(variant.printify_variant_id) }
    });
    variant.stripe_price_id = price.id;
    console.log("    stripe price " + price.id + " for " + (variant.color || "") + " " + (variant.size || ""));
  }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const products = data.products || {};
  const slugs = Object.keys(products);
  console.log("Shop " + SHOP_ID + ". Processing " + slugs.length + " products. dryRun=" + DRY_RUN + " stripe=" + CREATE_STRIPE + "\n");

  for (const slug of slugs) {
    const entry = products[slug];
    const pid = entry.printify_product_id;
    if (!pid) { console.log("- " + slug + ": no printify_product_id, skipped"); continue; }

    try {
      const pp = await getPrintifyProduct(pid);
      const valueMap = buildValueMap(pp);
      const colors = [], sizes = [], variants = [];

      (pp.variants || []).forEach(function (v) {
        // Only buyable variants. Printify products carry many disabled
        // variants we never offer; including them would clutter the picker.
        if (v.is_enabled === false) return;
        const cs = classify(valueMap, v);
        if (cs.color && colors.indexOf(cs.color) === -1) colors.push(cs.color);
        if (cs.size && sizes.indexOf(cs.size) === -1) sizes.push(cs.size);
        variants.push({
          color: cs.color,
          size: cs.size,
          printify_variant_id: v.id,
          stripe_price_id: null,
          price_cents: typeof v.price === "number" ? v.price : null,
          is_available: true
        });
      });

      entry.colors = colors;
      entry.sizes = sortSizes(sizes);
      entry.variants = variants;
      entry.variants_status = variants.length ? "fetched" : "no_variants_returned";

      console.log("- " + slug + ": " + variants.length + " variants, " + colors.length + " colors, " + sizes.length + " sizes");

      await maybeCreateStripePrices(entry);
    } catch (e) {
      console.error("- " + slug + ": " + e.message);
      entry.variants_status = "fetch_failed";
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run. No file written. Sample of first product:");
    console.log(JSON.stringify(products[slugs[0]], null, 2));
    return;
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("\nWrote " + JSON_PATH);
  console.log("Next: review the variants, then (when task 107 is verified) build the checkout endpoint and webhook.");
}

main().catch(function (e) { die(e.stack || e.message); });
