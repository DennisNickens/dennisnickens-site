/* ============================================================
   SPIRITUAL ROMEO STORE — CART FUNCTIONALITY
   cart.js | 2026
   ============================================================ */

(function() {
  'use strict';

  // ── State ──
  var cart = JSON.parse(localStorage.getItem('sr_cart') || '[]');

  // ── Save ──
  function saveCart() {
    localStorage.setItem('sr_cart', JSON.stringify(cart));
  }

  // ── Get total ──
  function getTotal() {
    return cart.reduce(function(sum, item) {
      var price = parseFloat(item.price) || 0;
      return sum + price * item.qty;
    }, 0);
  }

  // ── Update count badge ──
  function updateCount() {
    var total = cart.reduce(function(sum, item) { return sum + item.qty; }, 0);
    var badge = document.getElementById('cartCount');
    if (!badge) return;
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : total;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Render cart items ──
  function renderCart() {
    var container = document.getElementById('cartItems');
    var footer = document.getElementById('cartFooter');
    var empty = document.getElementById('cartEmpty');
    var subtotalEl = document.getElementById('cartSubtotal');
    if (!container) return;

    if (cart.length === 0) {
      if (empty) empty.style.display = 'block';
      if (footer) footer.style.display = 'none';
      // Clear dynamic items
      var existing = container.querySelectorAll('.cart-item');
      existing.forEach(function(el) { el.remove(); });
      return;
    }

    if (empty) empty.style.display = 'none';
    if (footer) footer.style.display = 'block';

    // Clear and re-render
    var existing = container.querySelectorAll('.cart-item');
    existing.forEach(function(el) { el.remove(); });

    cart.forEach(function(item, index) {
      var el = document.createElement('div');
      el.className = 'cart-item';
      var priceNum = parseFloat(item.price) || 0;
      var priceDisplay = priceNum > 0 ? ('$' + (priceNum * item.qty).toFixed(2)) : 'TBD';
      el.innerHTML =
        '<div class="cart-item-img"><span>' + (item.icon || '&#128218;') + '</span></div>' +
        '<div class="cart-item-info">' +
          '<div class="cart-item-name">' + escHtml(item.name) + '</div>' +
          (item.variant ? '<div class="cart-item-variant">' + escHtml(item.variant) + '</div>' : '') +
          '<div class="cart-item-price">' + priceDisplay + '</div>' +
          '<div class="cart-item-controls">' +
            '<button class="qty-btn" onclick="window.SRCart.changeQty(' + index + ',-1)" aria-label="Decrease">&#8722;</button>' +
            '<span class="qty-display">' + item.qty + '</span>' +
            '<button class="qty-btn" onclick="window.SRCart.changeQty(' + index + ',1)" aria-label="Increase">+</button>' +
          '</div>' +
        '</div>' +
        '<button class="cart-item-remove" onclick="window.SRCart.removeItem(' + index + ')" aria-label="Remove item">&times;</button>';
      container.appendChild(el);
    });

    if (subtotalEl) {
      var total = getTotal();
      subtotalEl.textContent = total > 0 ? ('$' + total.toFixed(2)) : 'TBD';
    }
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  // ── Public API ──
  window.SRCart = {

    add: function(name, price, options) {
      options = options || {};
      var variant = [];
      if (options.size) variant.push('Size: ' + options.size);
      if (options.color) variant.push('Color: ' + options.color);
      if (options.format) variant.push(options.format);
      var variantStr = variant.join(' | ');

      // Check if item already in cart
      var existing = cart.find(function(i) {
        return i.name === name && i.variant === variantStr;
      });
      if (existing) {
        existing.qty++;
      } else {
        cart.push({
          name: name,
          price: price,
          variant: variantStr,
          qty: 1,
          icon: options.icon || '&#128218;'
        });
      }
      saveCart();
      updateCount();
      renderCart();
      // Open cart
      toggleCart(true);
      // Show toast
      showToast(name + ' added to cart!');
    },

    remove: function(name) {
      cart = cart.filter(function(i) { return i.name !== name; });
      saveCart(); updateCount(); renderCart();
    },

    removeItem: function(index) {
      cart.splice(index, 1);
      saveCart(); updateCount(); renderCart();
    },

    changeQty: function(index, delta) {
      if (!cart[index]) return;
      cart[index].qty += delta;
      if (cart[index].qty <= 0) cart.splice(index, 1);
      saveCart(); updateCount(); renderCart();
    },

    getItems: function() { return cart.slice(); },
    getTotal: getTotal,
    getCount: function() { return cart.reduce(function(s,i){ return s+i.qty; }, 0); },
    clear: function() { cart = []; saveCart(); updateCount(); renderCart(); }
  };

  // ── Toggle cart drawer ──
  window.toggleCart = function(forceOpen) {
    var drawer = document.getElementById('cartDrawer');
    var overlay = document.getElementById('cartOverlay');
    if (!drawer) return;
    var isOpen = drawer.classList.contains('open');
    if (forceOpen === true && isOpen) return;
    if (isOpen || forceOpen === false) {
      drawer.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      document.body.style.overflow = '';
    } else {
      renderCart();
      drawer.classList.add('open');
      if (overlay) overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  };

  // ── Size / Color selectors ──
  window.selectSize = function(btn) {
    var group = btn.closest('.size-options');
    if (!group) return;
    group.querySelectorAll('.size-btn').forEach(function(b){ b.classList.remove('selected'); });
    btn.classList.add('selected');
  };

  window.selectColor = function(btn) {
    var group = btn.closest('.color-options');
    if (!group) return;
    group.querySelectorAll('.color-swatch').forEach(function(b){ b.classList.remove('selected'); });
    btn.classList.add('selected');
  };

  // ── Add to cart from a card (apparel, store page) ──
  window.addToCartFromCard = function(btn, name, price) {
    var card = btn.closest('.product-card, .rp-card');
    var size = '', color = '', colorName = '';
    if (card) {
      var sizeBtn = card.querySelector('.size-btn.selected');
      var colorSwatch = card.querySelector('.color-swatch.selected');
      if (!sizeBtn) {
        showToast('Please select a size first', 'warning');
        return;
      }
      size = sizeBtn.textContent;
      if (colorSwatch) colorName = colorSwatch.getAttribute('title') || '';
    }
    window.SRCart.add(name, price, { size: size, color: colorName, icon: '&#128085;' });
  };

  // ── Add to cart from product page ──
  window.addBookToCart = function(name, price, options) {
    options = options || {};
    // Check digital download checkbox
    var cb = document.getElementById('digitalDownload');
    if (cb && cb.checked) {
      options.format = 'Digital Download';
      options.icon = '&#128196;';
    } else {
      options.icon = '&#128218;';
    }
    window.SRCart.add(name, price, options);
  };

  window.addBundleToCart = function(bundleName, price) {
    window.SRCart.add(bundleName, price, { icon: '&#127873;' });
  };

  // ── Toast notification ──
  function showToast(msg, type) {
    var existing = document.querySelector('.sr-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'sr-toast' + (type === 'warning' ? ' sr-toast-warn' : '');
    toast.innerHTML = '<span>' + escHtml(msg) + '</span>';
    toast.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(20px);' +
      'background:' + (type === 'warning' ? 'rgba(220,38,38,0.9)' : 'rgba(124,58,237,0.95)') + ';' +
      'color:#fff;padding:14px 28px;border-radius:50px;font-size:14px;font-weight:600;' +
      'z-index:9999;opacity:0;transition:all 0.3s ease;white-space:nowrap;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.4);';
    document.body.appendChild(toast);
    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
    }, 2800);
  }

  // ── Init on DOM ready ──
  function init() {
    updateCount();
    renderCart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
