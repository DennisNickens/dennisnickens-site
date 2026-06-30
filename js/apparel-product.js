/* ============================================================
   apparel-product.js  -  renders the buy box on an apparel
   product detail page. Reads all variant data from
   /lib/apparel-products.json so nothing is hardcoded in HTML.

   The page sets window.SR_APPAREL_SLUG before loading this file.
   When the variants array is empty (Printify sync has not run
   yet) the buy box shows a finalizing state with checkout off.
   ============================================================ */
(function () {
  "use strict";

  var DATA_URL = "../lib/apparel-products.json";
  var CHECKOUT_URL = "../api/apparel-checkout";

  var state = { product: null, color: null, size: null, qty: 1 };

  function el(id) { return document.getElementById(id); }

  function money(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (v) {
      if (v != null && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  // Printify returns sizes in a jumbled order. Sort the picker into the
  // normal apparel run. Unknown labels (e.g. cap S/M, L/XL) keep their
  // encounter order at the end.
  var SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
  function sortSizes(list) {
    var known = [], unknown = [];
    list.forEach(function (s) {
      (SIZE_ORDER.indexOf(s) !== -1 ? known : unknown).push(s);
    });
    known.sort(function (a, b) { return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b); });
    return known.concat(unknown);
  }

  function variantFor(color, size) {
    if (!state.product) return null;
    return state.product.variants.filter(function (v) {
      return (color == null || v.color === color) && (size == null || v.size === size);
    })[0] || null;
  }

  // Only resolves once the customer has made the selections the product
  // actually requires. Prevents a premature price or an enabled Buy button
  // before a size (and color, when there is more than one) is chosen.
  function currentVariant() {
    var p = state.product;
    if (!p || !p.variants.length) return null;
    var colors = uniq(p.variants.map(function (v) { return v.color; }).filter(function (x) { return x != null; }));
    var hasSizes = p.variants.some(function (v) { return v.size != null; });
    if (colors.length > 1 && !state.color) return null;
    if (hasSizes && !state.size) return null;
    return variantFor(state.color, state.size);
  }

  // A size is buyable for the chosen color when a matching, available variant exists.
  function sizeAvailable(size) {
    return state.product.variants.some(function (v) {
      return v.size === size && (state.color == null || v.color === state.color) && v.is_available !== false;
    });
  }

  function colorAvailable(color) {
    return state.product.variants.some(function (v) {
      return v.color === color && v.is_available !== false;
    });
  }

  function render() {
    var p = state.product;
    var box = el("aprBuyBox");
    if (!box) return;

    if (!p) {
      box.innerHTML =
        '<div class="apr-status-msg">We could not load this product right now. ' +
        'Please head back to the store and try again.</div>' +
        '<a href="../store.html" class="apr-back-btn">Back to Store</a>';
      return;
    }

    var pending = !p.variants || p.variants.length === 0;
    if (pending) {
      box.innerHTML =
        '<div class="apr-status-msg">Online checkout for this design is being finalized and will go live shortly. ' +
        'Thanks for your patience. Browse the rest of the collection in the meantime.</div>' +
        '<a href="../store.html" class="apr-back-btn">Back to Store</a>' +
        '<p class="apr-note">Made to order. Ships within 7 to 10 business days from our print partner.</p>';
      return;
    }

    var colors = uniq(p.variants.map(function (v) { return v.color; }));
    var sizes = sortSizes(uniq(p.variants.map(function (v) { return v.size; })));
    var single = colors.length <= 1;
    if (single && colors.length === 1) state.color = colors[0];

    var html = "";

    // color
    if (!single) {
      html += '<div class="apr-field"><div class="apr-field-label">Color</div><div class="apr-swatches" id="aprColors">';
      colors.forEach(function (c) {
        var dis = colorAvailable(c) ? "" : " disabled";
        var sel = state.color === c ? " is-selected" : "";
        html += '<button type="button" class="apr-swatch' + sel + '" data-color="' + c + '"' + dis + '>' + c + '</button>';
      });
      html += "</div></div>";
    } else if (colors.length === 1) {
      html += '<div class="apr-field"><div class="apr-field-label">Color</div>' +
        '<div class="apr-para" style="margin:0;font-size:0.95rem;color:#e2e8f0;">' + colors[0] + '</div></div>';
    }

    // size
    html += '<div class="apr-field"><div class="apr-field-label"><span>Size</span>' +
      '<button type="button" class="apr-size-link" id="aprSizeChartBtn">Size guide</button></div>' +
      '<div class="apr-sizes" id="aprSizes">';
    sizes.forEach(function (s) {
      var dis = sizeAvailable(s) ? "" : " disabled";
      var sel = state.size === s ? " is-selected" : "";
      html += '<button type="button" class="apr-size' + sel + '" data-size="' + s + '"' + dis + '>' + s + "</button>";
    });
    html += "</div></div>";

    // quantity
    html += '<div class="apr-field"><div class="apr-field-label">Quantity</div>' +
      '<div class="apr-qty-row"><select class="apr-qty-select" id="aprQty">';
    for (var q = 1; q <= 5; q++) {
      html += '<option value="' + q + '"' + (state.qty === q ? " selected" : "") + ">" + q + "</option>";
    }
    html += "</select></div></div>";

    // total
    var v = currentVariant();
    var totalText = v ? money((v.price_cents + (v.size_upcharge_cents || 0)) * state.qty) : "Select options";
    html += '<div class="apr-total"><span class="apr-total-label">Total</span>' +
      '<span class="apr-total-amount" id="aprTotal">' + totalText + "</span></div>";

    // buy
    var canBuy = !!(v && v.is_available !== false && v.printify_variant_id);
    html += '<button type="button" class="apr-buy-btn" id="aprBuyBtn"' + (canBuy ? "" : " disabled") +
      ">Buy Now</button>";
    html += '<a href="../store.html" class="apr-back-btn">Back to Store</a>';
    html += '<div class="apr-error-msg" id="aprError"></div>';
    html += '<p class="apr-note">Made to order. Ships within 7 to 10 business days from our print partner. ' +
      "Shipping and tax are calculated at checkout.</p>";
    html += '<div class="apr-trust"><span>Secure Stripe Checkout</span><span>Tracked Shipping</span></div>';

    box.innerHTML = html;
    wire();
  }

  function swapHeroImage(color) {
    var p = state.product;
    if (!p) return;
    var heroImg = document.querySelector(".apr-img-wrap img");
    if (!heroImg) return;
    var url = (p.color_images && p.color_images[color]) || p.hero_image || null;
    if (!url || heroImg.getAttribute("src") === url) return;
    heroImg.style.transition = "opacity 0.15s";
    heroImg.style.opacity = "0";
    setTimeout(function () {
      heroImg.src = url;
      heroImg.style.opacity = "1";
    }, 150);
  }

  function wire() {
    var colorsWrap = el("aprColors");
    if (colorsWrap) {
      colorsWrap.querySelectorAll(".apr-swatch").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (btn.disabled) return;
          state.color = btn.getAttribute("data-color");
          swapHeroImage(state.color);
          if (state.size && !sizeAvailable(state.size)) state.size = null;
          render();
        });
      });
    }
    var sizesWrap = el("aprSizes");
    if (sizesWrap) {
      sizesWrap.querySelectorAll(".apr-size").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (btn.disabled) return;
          state.size = btn.getAttribute("data-size");
          render();
        });
      });
    }
    var qty = el("aprQty");
    if (qty) qty.addEventListener("change", function () { state.qty = parseInt(qty.value, 10) || 1; updateTotal(); });

    var buy = el("aprBuyBtn");
    if (buy) buy.addEventListener("click", onBuy);

    var chart = el("aprSizeChartBtn");
    if (chart) chart.addEventListener("click", openSizeChart);
  }

  function updateTotal() {
    var v = currentVariant();
    var t = el("aprTotal");
    if (t) t.textContent = v ? money((v.price_cents + (v.size_upcharge_cents || 0)) * state.qty) : "Select options";
    var buy = el("aprBuyBtn");
    if (buy) buy.disabled = !(v && v.is_available !== false && v.printify_variant_id);
  }

  function onBuy() {
    var p = state.product;
    var v = currentVariant();
    if (!v) return;
    var btn = el("aprBuyBtn");
    var errEl = el("aprError");
    if (errEl) errEl.style.display = "none";
    if (btn) { btn.disabled = true; btn.textContent = "Starting checkout..."; }

    var label = [state.color, state.size].filter(Boolean).join(" / ");
    fetch(CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: p.slug,
        printify_product_id: p.printify_product_id,
        printify_variant_id: v.printify_variant_id,
        variant_label: label,
        quantity: state.qty
      })
    })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
          return { ok: r.ok, body: j };
        });
      })
      .then(function (res) {
        if (res.ok && res.body && res.body.url) {
          window.location.href = res.body.url;
          return;
        }
        throw new Error((res.body && res.body.error) || "Checkout is not available yet. Please try again shortly.");
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = "Buy Now"; }
        if (errEl) { errEl.textContent = e.message || "Something went wrong. Please try again."; errEl.style.display = "block"; }
      });
  }

  function openSizeChart() {
    var overlay = el("aprSizeChartOverlay");
    if (overlay) overlay.classList.add("is-open");
  }

  function init() {
    var slug = window.SR_APPAREL_SLUG;
    fetch(DATA_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.product = (data && data.products && data.products[slug]) || null;
        render();
      })
      .catch(function () {
        state.product = null;
        render();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
