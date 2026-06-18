/* ============================================================
   Lovers Quest  app.js
   Single-device couples card shuffler. No backend, no scoring.
   State persists in localStorage; deck data from cards.json.
   ============================================================ */
(function () {
  'use strict';

  // ---------- localStorage keys ----------
  var K = {
    opened: 'lq_has_opened',
    order: 'lq_current_deck_order',
    pos: 'lq_current_position',
    favs: 'lq_favorites',
    date: 'lq_last_session_date',
    filter: 'lq_active_filter'
  };

  // ---------- SVG icons (gold line art) ----------
  var ICONS = {
    flame: '<svg viewBox="0 0 24 24"><path d="M12 2.5c.6 3.2-1.8 4.3-2.8 6.2-1.4 2.6.3 4.1.3 4.1s-1.6-.4-2.3-2.2c-1 1.3-1.4 2.8-1.4 4.1A6.2 6.2 0 0 0 12 21.5a6.2 6.2 0 0 0 6.2-6.2c0-4.3-3.4-6.1-4.6-9.1-.5-1.3-1.4-2.7-1.6-3.7z"/><path d="M12 21.5c-1.6 0-2.9-1.2-2.9-2.9 0-1.7 1.6-2.6 1.9-4.3.9 1 4 1.7 4 4.3 0 1.7-1.4 2.9-3 2.9z"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="4.2"/><path d="M11 11l8 8M16 16l2-2M18.5 18.5l2-2"/></svg>',
    compass: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2"/><path d="M15.5 8.5l-2 5.2-5.2 2 2-5.2z"/><circle cx="12" cy="12" r=".6"/></svg>',
    'hand-leaf': '<svg viewBox="0 0 24 24"><path d="M3 20c2-3.6 5.5-5.6 9.4-5.6h3.1"/><path d="M15.5 14.4c2.9 0 5.3-2.4 5.3-5.4 0-1.8-.6-3.3-1.4-4.6-1.4 1-3.9 1.4-5.2 3-1 1.2-1.3 2.8-1 4.3"/><path d="M14.2 13.1c1.2-2 3-3.4 5.2-4.1"/></svg>',
    rose: '<svg viewBox="0 0 24 24"><path d="M12 11.5c0-2.2 1.4-4 3.2-4 .9 0 1.6.4 1.6 1.3 0 1.7-2.1 2.7-4.8 2.7z"/><path d="M12 11.5c0-2.2-1.4-4-3.2-4-.9 0-1.6.4-1.6 1.3 0 1.7 2.1 2.7 4.8 2.7z"/><path d="M12 8.2c0-2 1-3.7 2-3.7s2 .9 2 2.6"/><path d="M12 11.5v5.5"/><path d="M12 14.2c1.8 0 3.4-1 4.2-2.6M12 15.4c-1.8 0-3.4-1-4.2-2.6"/><path d="M12 21.5c-.4-2 .3-3.6 1.8-4.6M12 21.5c.4-2-.3-3.6-1.8-4.6"/></svg>',
    crown: '<svg viewBox="0 0 24 24"><path d="M3 8l3.2 3L12 5l5.8 6L21 8l-1.6 10.5H4.6z"/><path d="M4.6 18.5h14.8"/><circle cx="3" cy="8" r="1"/><circle cx="21" cy="8" r="1"/><circle cx="12" cy="5" r="1"/></svg>'
  };

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  // ---------- App state ----------
  var DATA = null;          // cards.json
  var byId = {};            // id -> card
  var catByKey = {};        // key -> category
  var deck = [];            // array of card ids in current order
  var pos = 0;              // index into deck
  var favs = [];            // favorited ids
  var filter = null;        // active category key or null (full deck)

  var SCREENS = ['screen-splash', 'screen-welcome', 'screen-card', 'screen-done'];

  // Fisher-Yates shuffle (returns a new array)
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function allIds(filterKey) {
    return DATA.cards
      .filter(function (c) { return !filterKey || c.category === filterKey; })
      .map(function (c) { return c.id; });
  }

  function buildDeck(filterKey) {
    filter = filterKey || null;
    deck = shuffle(allIds(filter));
    pos = 0;
    persist();
  }

  function persist() {
    save(K.order, deck);
    save(K.pos, pos);
    save(K.favs, favs);
    save(K.filter, filter);
    save(K.date, new Date().toISOString());
  }

  // ---------- Screen switching ----------
  function showScreen(id, withFade) {
    function swap() {
      SCREENS.forEach(function (s) {
        var el = $(s);
        if (s === id) { el.hidden = false; el.classList.remove('fading'); }
        else { el.hidden = true; }
      });
    }
    if (withFade) {
      var current = SCREENS.map($).filter(function (el) { return el && !el.hidden; })[0];
      if (current) {
        current.classList.add('fading');
        setTimeout(swap, 360);
        return;
      }
    }
    swap();
  }

  // ---------- Card rendering ----------
  function renderCard(direction) {
    var card = byId[deck[pos]];
    if (!card) return;
    var cat = catByKey[card.category];
    var qcard = $('qcard');

    function paint() {
      $('card-icon').innerHTML = ICONS[cat.icon] || '';
      $('card-cat').textContent = cat.name;
      $('card-text').textContent = card.text;
      updateFavBtn();
      $('progress-count').textContent = (pos + 1) + ' of ' + deck.length +
        (filter ? ' · ' + cat.name : '');
      $('btn-back').style.visibility = pos > 0 ? 'visible' : 'hidden';
      qcard.classList.remove('out');
    }

    // animate out, swap, animate in
    qcard.classList.toggle('in-back', direction === 'back');
    if (direction) {
      qcard.classList.add('out');
      setTimeout(paint, 320);
    } else {
      paint();
    }
  }

  function updateFavBtn() {
    var id = deck[pos];
    var on = favs.indexOf(id) !== -1;
    var btn = $('btn-fav');
    btn.classList.toggle('is-fav', on);
    btn.setAttribute('aria-label', on ? 'Remove favorite' : 'Favorite this card');
  }

  // ---------- Flow actions ----------
  function goNext() {
    if (pos + 1 >= deck.length) {
      pos = deck.length; persist();
      showScreen('screen-done', true);
      return;
    }
    pos += 1; persist();
    renderCard('next');
  }
  function goBack() {
    if (pos <= 0) return;
    pos -= 1; persist();
    renderCard('back');
  }
  function toggleFav() {
    var id = deck[pos];
    var i = favs.indexOf(id);
    if (i === -1) favs.push(id); else favs.splice(i, 1);
    persist();
    updateFavBtn();
    updateFavCount();
  }

  function startDeck(filterKey) {
    buildDeck(filterKey);
    closeMenu();
    showScreen('screen-card', true);
    renderCard(null);
  }

  // resume an existing deck, or build fresh; route to right screen
  function enterDeck() {
    showScreen('screen-card', true);
    if (pos >= deck.length) { showScreen('screen-done', true); }
    else { renderCard(null); }
  }

  // ---------- Menu drawer ----------
  function openMenu() {
    updateFavCount();
    $('drawer-backdrop').hidden = false;
    $('drawer').hidden = false;
    requestAnimationFrame(function () {
      $('drawer-backdrop').classList.add('show');
      $('drawer').classList.add('show');
    });
  }
  function closeMenu() {
    $('drawer-backdrop').classList.remove('show');
    $('drawer').classList.remove('show');
    setTimeout(function () {
      $('drawer-backdrop').hidden = true;
      $('drawer').hidden = true;
    }, 420);
  }
  function updateFavCount() {
    $('fav-count').textContent = favs.length ? favs.length : '';
  }

  // ---------- Modal ----------
  function openModal(title, html) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    $('modal-backdrop').hidden = false;
    requestAnimationFrame(function () { $('modal-backdrop').classList.add('show'); });
  }
  function closeModal() {
    $('modal-backdrop').classList.remove('show');
    setTimeout(function () { $('modal-backdrop').hidden = true; }, 400);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showHowToPlay() {
    var ins = DATA.instructions;
    var html = '<ol>' + ins.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    html += '<div class="sub-head">' + esc(ins.ground_rules_title) + '</div><ul>' +
      ins.ground_rules.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    html += '<div class="sub-head">' + esc(ins.final_note_title) + '</div><p>' + esc(ins.final_note) + '</p>';
    openModal(ins.title, html);
  }

  function showCategories() {
    var html = DATA.categories.map(function (c) {
      return '<button class="cat-row" data-cat="' + c.key + '">' +
        '<span class="cat-ic">' + (ICONS[c.icon] || '') + '</span>' +
        '<span class="cat-meta"><h4>' + esc(c.name) + '</h4><p>' + esc(c.description) + '</p></span>' +
        '</button>';
    }).join('');
    html += '<p style="text-align:center;margin-top:1.2rem;font-size:.85rem;color:var(--cream-faint);">Tap a category to focus the deck on it. Shuffle Deck returns to all 72.</p>';
    openModal('Categories', html);
  }

  function showFavorites() {
    var html;
    if (!favs.length) {
      html = '<p class="fav-empty">No favorites yet. Tap the heart on a card to keep it here.</p>';
    } else {
      html = favs.map(function (id) {
        var card = byId[id]; if (!card) return '';
        var cat = catByKey[card.category];
        return '<div class="fav-row" data-fav="' + id + '">' +
          '<div style="flex:1 1 auto"><div class="fav-cat">' + esc(cat.name) + '</div>' +
          '<div class="fav-text">' + esc(card.text) + '</div></div>' +
          '<button class="fav-remove" data-removefav="' + id + '" aria-label="Remove favorite">' +
          '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-9.4-8.4C1 8.8 2.3 5.5 5.4 5.5c1.9 0 3.1 1.1 3.9 2.3.8-1.2 2-2.3 3.9-2.3 3.1 0 4.4 3.3 2.8 6.1C19 15.4 12 20 12 20z"/></svg>' +
          '</button></div>';
      }).join('');
    }
    openModal('Favorites', html);
  }

  function showAbout() {
    var a = DATA.about;
    var html = '<p class="about-tag">' + esc(a.tagline) + '</p>' +
      '<p>' + esc(a.body) + '</p>' +
      '<div class="about-link-wrap"><a class="btn btn-ghost about-link" href="' + esc(a.physical_edition_url) +
      '" target="_blank" rel="noopener">' + esc(a.physical_edition_label) + '</a></div>' +
      '<p class="about-credit">' + esc(a.credit) + '</p>';
    openModal('About Lovers Quest', html);
  }

  // ---------- Event wiring ----------
  function onAction(action, target) {
    switch (action) {
      case 'begin': showScreen('screen-welcome', true); break;
      case 'ready':
        save(K.opened, true);
        if (!deck.length) buildDeck(null);
        showScreen('screen-card', true);
        renderCard(null);
        break;
      case 'next': goNext(); break;
      case 'back': goBack(); break;
      case 'favorite': toggleFav(); break;
      case 'menu': openMenu(); break;
      case 'close-menu': closeMenu(); break;
      case 'how-to-play': closeMenu(); showHowToPlay(); break;
      case 'categories': closeMenu(); showCategories(); break;
      case 'favorites': closeMenu(); showFavorites(); break;
      case 'shuffle': startDeck(null); break;
      case 'about': closeMenu(); showAbout(); break;
      case 'close-modal': closeModal(); break;
      case 'reshuffle': startDeck(null); break;
    }
  }

  function wire() {
    document.body.addEventListener('click', function (e) {
      var actEl = e.target.closest('[data-action]');
      if (actEl) { onAction(actEl.getAttribute('data-action'), actEl); return; }

      // category filter selection
      var catEl = e.target.closest('[data-cat]');
      if (catEl) { closeModal(); startDeck(catEl.getAttribute('data-cat')); return; }

      // remove favorite from list
      var rm = e.target.closest('[data-removefav]');
      if (rm) {
        var id = parseInt(rm.getAttribute('data-removefav'), 10);
        var i = favs.indexOf(id);
        if (i !== -1) { favs.splice(i, 1); persist(); }
        showFavorites(); updateFavCount();
        if ($('screen-card') && !$('screen-card').hidden) updateFavBtn();
        return;
      }

      // backdrops close
      if (e.target.id === 'drawer-backdrop') { closeMenu(); return; }
      if (e.target.id === 'modal-backdrop') { closeModal(); return; }
    });

    // keyboard: Escape closes overlays; arrows navigate cards
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('modal-backdrop').hidden) closeModal();
        else if (!$('drawer').hidden) closeMenu();
        return;
      }
      if ($('screen-card') && !$('screen-card').hidden && $('modal-backdrop').hidden && $('drawer').hidden) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); goNext(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      }
    });
  }

  // ---------- Boot ----------
  function boot(data) {
    DATA = data;
    data.cards.forEach(function (c) { byId[c.id] = c; });
    data.categories.forEach(function (c) { catByKey[c.key] = c; });

    // welcome + completion text from data
    var w = data.welcome;
    $('welcome-title').textContent = w.title;
    $('welcome-body').innerHTML = w.body.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    $('welcome-signoff').innerHTML = '<em>' + esc(w.signoff) + '</em>';
    $('done-note').textContent = data.completion.note;
    $('done-crown').innerHTML = ICONS.crown;

    // restore state
    favs = load(K.favs, []) || [];
    deck = load(K.order, []) || [];
    pos = load(K.pos, 0) || 0;
    filter = load(K.filter, null);
    updateFavCount();

    var opened = load(K.opened, false);
    wire();

    if (opened) {
      // returning visitor: skip splash, straight to the deck (restored place)
      if (!deck.length) buildDeck(null);
      enterDeck();
    } else {
      showScreen('screen-splash', false);
    }
  }

  function fail(msg) {
    document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;' +
      'justify-content:center;text-align:center;padding:2rem;color:#f5f1e8;font-family:Georgia,serif;">' +
      '<div><p style="color:#d4a957;font-size:1.4rem;margin-bottom:.6rem;">Lovers Quest</p>' +
      '<p>' + esc(msg) + '</p></div></div>';
  }

  // Load deck data (relative path so it works at any base)
  fetch('cards.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(boot)
    .catch(function () {
      // retry without no-cache (offline / cached SW response)
      fetch('cards.json').then(function (r) { return r.json(); }).then(boot)
        .catch(function () { fail('The deck could not load. Please reconnect once so the cards can be saved for offline use.'); });
    });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }
})();
