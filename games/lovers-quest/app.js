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
    filter: 'lq_active_filter',
    // license-related
    licenseToken: 'lq_license_token',
    deviceFingerprint: 'lq_device_fp',
    licenseFirstName: 'lq_license_first_name',
    licenseEmail: 'lq_license_email',
    onboarded: 'lq_onboarded'
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

  var SCREENS = ['screen-activate', 'screen-onboarding', 'screen-home', 'screen-splash', 'screen-welcome', 'screen-card', 'screen-done'];

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
      var iconSvg = ICONS[cat.icon] || '';
      $('card-icon').innerHTML = iconSvg;
      // mirror the category icon into the side watermarks so the empty space
      // around the card carries the category's meaning instead of staying dead.
      var wmL = $('sr-wm-left'); if (wmL) wmL.innerHTML = iconSvg;
      var wmR = $('sr-wm-right'); if (wmR) wmR.innerHTML = iconSvg;
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

  function showContext() {
    var card = byId[deck[pos]];
    if (!card) return;
    var cat = catByKey[card.category];
    var ctx = card.context || 'Context for this card is coming soon.';
    // split on blank lines into paragraphs
    var paras = ctx.split(/\n\s*\n/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var html = '<div class="ctx-question">' + esc(card.text) + '</div>' +
               '<div class="ctx-body">' + paras + '</div>';
    openModal(cat ? cat.name + ' · Context' : 'Context', html);
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

  // ============================================================
  //   License / activation flow
  // ============================================================

  function makeDeviceFingerprint() {
    // Local-only, stable random id. Stored in localStorage on first
    // generation. Not a real fingerprint, just a per-install identifier
    // so the server can count this device toward the 2-device limit.
    var fp = load(K.deviceFingerprint, null);
    if (fp) return fp;
    var bytes = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    save(K.deviceFingerprint, hex);
    return hex;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  function storeLicense(token, firstName, email) {
    save(K.licenseToken, token);
    save(K.licenseFirstName, firstName || '');
    save(K.licenseEmail, email || '');
  }

  function clearLicense() {
    try {
      localStorage.removeItem(K.licenseToken);
      localStorage.removeItem(K.licenseFirstName);
      localStorage.removeItem(K.licenseEmail);
    } catch (e) {}
  }

  function hasLicense() {
    return !!load(K.licenseToken, null);
  }

  // ---------- Activation UI state ----------
  var pendingActivateEmail = '';

  function showActivateStep(step) {
    $('activate-step-email').hidden = (step !== 'email');
    $('activate-step-code').hidden = (step !== 'code');
    $('activate-email-err').hidden = true;
    $('activate-code-err').hidden = true;
  }

  function showActivateError(elId, msg) {
    var el = $(elId);
    el.textContent = msg;
    el.hidden = false;
  }

  function showActivateScreen() {
    showActivateStep('email');
    $('activate-email').value = load(K.licenseEmail, '') || '';
    showScreen('screen-activate', false);
  }

  async function activateWithUrlToken(urlToken) {
    var fp = makeDeviceFingerprint();
    var r;
    try {
      r = await postJson('/api/lq-activate', {
        action: 'activate',
        token: urlToken,
        fingerprint: fp
      });
    } catch (err) {
      return { ok: false, reason: 'network' };
    }
    if (r.status === 200 && r.body && r.body.ok) {
      storeLicense(urlToken, r.body.firstName, r.body.email);
      return { ok: true };
    }
    return { ok: false, reason: (r.body && r.body.error) || 'unknown' };
  }

  async function sendVerificationCode(email) {
    try {
      var r = await postJson('/api/lq-activate', { action: 'send_code', email: email });
      return r.status === 200 && r.body && r.body.ok;
    } catch (e) { return false; }
  }

  async function verifyCodeAndActivate(email, code) {
    var fp = makeDeviceFingerprint();
    var r;
    try {
      r = await postJson('/api/lq-activate', {
        action: 'verify_code',
        email: email,
        code: code,
        fingerprint: fp
      });
    } catch (err) { return { ok: false, reason: 'network' }; }
    if (r.status === 200 && r.body && r.body.ok) {
      storeLicense(r.body.token, r.body.firstName, r.body.email);
      return { ok: true };
    }
    return { ok: false, reason: (r.body && r.body.error) || 'unknown' };
  }

  async function handleSendCode() {
    var email = String($('activate-email').value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showActivateError('activate-email-err', 'Enter a valid email address.');
      return;
    }
    pendingActivateEmail = email;
    $('activate-email-echo').textContent = email;
    var ok = await sendVerificationCode(email);
    if (!ok) {
      showActivateError('activate-email-err', 'Could not send the code. Try again in a moment.');
      return;
    }
    showActivateStep('code');
  }

  async function handleVerifyCode() {
    var code = String($('activate-code').value || '').replace(/[^0-9]/g, '');
    if (code.length !== 6) {
      showActivateError('activate-code-err', 'Enter the 6-digit code from the email.');
      return;
    }
    var result = await verifyCodeAndActivate(pendingActivateEmail, code);
    if (!result.ok) {
      var msg = 'That code did not work. Check the email or request a new code.';
      if (result.reason === 'invalid_or_expired_code') msg = 'That code is expired or wrong. Request a new one.';
      if (result.reason === 'license_not_found') msg = 'No purchase found for that email. Double-check the address.';
      showActivateError('activate-code-err', msg);
      return;
    }
    // Activated successfully. Drop into the post-activation flow.
    afterActivation();
  }

  function afterActivation() {
    var onboarded = load(K.onboarded, false);
    if (!onboarded) {
      startOnboarding();
    } else {
      // already onboarded previously, go straight to the splash/deck
      enterPostOnboarding();
    }
  }

  // ============================================================
  //   Onboarding flow (4 screens, first time only)
  // ============================================================

  var ONBOARDING = [
    {
      // NEW page 1: cover image + personalized welcome.
      // The title is set dynamically from the buyer's first name in renderOnboardingStep().
      cover: true,
      title: 'Welcome',
      paragraphs: [
        'You and your spouse just chose to spend a quiet hour together. Most couples don\'t. That alone is worth saying out loud.',
        'On the next few screens, a quick word from me on how this deck works, what to expect from it, and one truth you need to hear before you start.'
      ]
    },
    {
      title: 'The Thank You',
      paragraphs: [
        'Welcome to Lovers Quest.',
        'You just made a decision a lot of couples never get around to. You decided your marriage was worth a deliberate hour. That by itself counts for something.',
        'What you are holding is not a card game. It is a tool. The card is the doorway. The conversation that happens between you and your spouse is the actual work.'
      ]
    },
    {
      title: 'How This Helps',
      paragraphs: [
        'Here is what the deck does, if you let it.',
        'The cards ask the questions you both stopped asking. The questions open doors you did not know were closed. The conversations that follow are where your marriage actually changes.',
        'Some cards will land easy. Some will open something you have been quietly carrying. Both are good. Both are the deck doing its job.'
      ]
    },
    {
      title: 'The Honest Part',
      paragraphs: [
        'Before you start, one truth.',
        'This will not work if you treat it like entertainment. It will not work if you scroll between cards, check your phone, or rush through. It will not work if you give half answers because the real ones are uncomfortable.',
        'Anything worth having is worth putting in the work. Your marriage is worth more than most things in your life. Treat the deck like that.',
        'You and your spouse, alone, no distractions, willing to actually answer the question in front of you. That is the deal.'
      ]
    },
    {
      title: "You're In",
      paragraphs: [
        'You are ready.',
        'Tap below and the deck opens. You can revisit this any time from the menu under How to Play.',
        'Welcome to the quest.',
        '<em>Dennis Nickens, AKA Spiritual Romeo</em>'
      ]
    }
  ];

  var onbIndex = 0;

  function renderOnboardingStep() {
    var step = ONBOARDING[onbIndex];
    $('onb-step-num').textContent = (onbIndex + 1) + ' of ' + ONBOARDING.length;

    // Title: personalize Welcome with the buyer's first name when we have it.
    var title = step.title;
    if (step.cover) {
      var name = load(K.licenseFirstName, '') || '';
      title = name ? ('Welcome, ' + name) : 'Welcome';
    }
    $('onb-title').textContent = title;

    // Cover image visible only on pages flagged cover; crown on the rest.
    var cover = $('onb-cover');
    var crown = $('onb-crown');
    if (cover && crown) {
      cover.hidden = !step.cover;
      crown.hidden = !!step.cover;
    }

    $('onb-body').innerHTML = step.paragraphs.map(function (p) { return '<p>' + p + '</p>'; }).join('');
    var backBtn = document.querySelector('.onb-back');
    if (backBtn) backBtn.hidden = (onbIndex === 0);
    $('onb-next-btn').textContent = (onbIndex === ONBOARDING.length - 1) ? 'Open the Deck' : 'Continue';
  }

  function startOnboarding() {
    onbIndex = 0;
    renderOnboardingStep();
    showScreen('screen-onboarding', true);
  }

  function onbAdvance() {
    if (onbIndex < ONBOARDING.length - 1) {
      onbIndex += 1;
      renderOnboardingStep();
      return;
    }
    // Finished onboarding.
    save(K.onboarded, true);
    enterPostOnboarding();
  }

  function onbGoBack() {
    if (onbIndex > 0) {
      onbIndex -= 1;
      renderOnboardingStep();
    }
  }

  // After activation + onboarding (or skipping onboarding if already done),
  // route into the existing flow. First-time users land on the Welcome card
  // ("Before You Start"). Returning users land on the Home screen instead of
  // dropping straight into mid-deck; they can tap Open the Deck to resume.
  function enterPostOnboarding() {
    paintLicenseWatermark();
    var opened = load(K.opened, false);
    if (opened) {
      if (!deck.length) buildDeck(null);
      showHomeScreen();
    } else {
      showScreen('screen-welcome', true);
    }
  }

  function paintLicenseWatermark() {
    var name = load(K.licenseFirstName, '') || '';
    var text = name ? 'Licensed to ' + name : '';
    // Same text appears on the welcome card and the home screen.
    ['license-watermark', 'home-license'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (!text) { el.hidden = true; el.textContent = ''; return; }
      el.textContent = text;
      el.hidden = false;
    });
  }

  // Persistent Home / cover screen. Shown to returning visitors and reachable
  // from the menu drawer at any time.
  function showHomeScreen() {
    var name = load(K.licenseFirstName, '') || '';
    var greet = $('home-greeting');
    if (greet) {
      if (name) { greet.textContent = 'Welcome back, ' + name + '.'; greet.hidden = false; }
      else { greet.textContent = ''; greet.hidden = true; }
    }
    var prog = $('home-progress');
    if (prog) {
      if (deck && deck.length && DATA) {
        var total = DATA.cards.length;
        var current = Math.min(pos + 1, deck.length);
        prog.textContent = 'On card ' + current + ' of ' + total;
      } else {
        prog.textContent = '';
      }
    }
    paintLicenseWatermark();
    showScreen('screen-home', true);
  }

  // ============================================================
  //   Event wiring
  // ============================================================
  function onAction(action, target) {
    // Actions that don't need DATA loaded
    if (action === 'begin') { showScreen('screen-welcome', true); return; }
    if (action === 'send-code')      { handleSendCode(); return; }
    if (action === 'verify-code')    { handleVerifyCode(); return; }
    if (action === 'resend-code')    { handleSendCode(); return; }
    if (action === 'back-to-email')  { showActivateStep('email'); return; }
    if (action === 'onb-next')       { onbAdvance(); return; }
    if (action === 'onb-back')       { onbGoBack(); return; }

    // Everything below needs cards.json to be loaded. If a user taps fast
    // before the deck arrives, swallow the action quietly. boot() will
    // populate the welcome screen content the moment DATA is ready.
    if (!DATA) return;

    switch (action) {
      case 'ready':
        save(K.opened, true);
        if (!deck.length) buildDeck(null);
        showScreen('screen-card', true);
        renderCard(null);
        break;
      case 'next': goNext(); break;
      case 'back': goBack(); break;
      case 'favorite': toggleFav(); break;
      case 'context': showContext(); break;
      case 'menu': openMenu(); break;
      case 'home': closeMenu(); showHomeScreen(); break;
      case 'home-open': enterDeck(); break;
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

    // ----- License gate -----
    // The PWA used to drop you straight into the splash. Now it needs
    // a valid license first. Three boot paths:
    //   1. ?access=<token> in the URL  -> activate that token, store it
    //   2. token already in localStorage -> trust it (offline-safe)
    //   3. nothing                       -> show activation screen
    var params = new URLSearchParams(location.search);
    var urlAccess = params.get('access');

    if (urlAccess) {
      activateWithUrlToken(urlAccess).then(function (result) {
        // Strip the token from the URL so it doesn't get screenshotted
        // or shared accidentally.
        history.replaceState(null, '', location.pathname);
        if (result.ok) {
          paintLicenseWatermark();
          afterActivation();
        } else if (hasLicense()) {
          // The URL token was bad but they already had a working
          // license stored. Honor what's stored.
          paintLicenseWatermark();
          enterPostOnboarding();
        } else {
          showActivateScreen();
        }
      });
      return;
    }

    if (hasLicense()) {
      // Returning visitor with a stored license. Trust it (works offline).
      // Background re-verify; if the server says no, kick them to activation.
      paintLicenseWatermark();
      enterPostOnboarding();
      // Silent server check, fail-open on network errors.
      var fp = makeDeviceFingerprint();
      var tok = load(K.licenseToken, '');
      postJson('/api/lq-verify', { token: tok, fingerprint: fp }).then(function (r) {
        if (r.status === 200 && r.body && r.body.ok === false &&
            (r.body.reason === 'license_not_found' || r.body.reason === 'device_not_registered')) {
          clearLicense();
        }
      }).catch(function () { /* offline, do nothing */ });
      return;
    }

    showActivateScreen();
  }

  function fail(msg) {
    document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;' +
      'justify-content:center;text-align:center;padding:2rem;color:#f5f1e8;font-family:Georgia,serif;">' +
      '<div><p style="color:#d4a957;font-size:1.4rem;margin-bottom:.6rem;">Lovers Quest</p>' +
      '<p>' + esc(msg) + '</p></div></div>';
  }

  // Attach all event handlers IMMEDIATELY so the splash Begin button responds
  // even if cards.json is still in flight. onAction() guards data-dependent
  // actions until DATA is loaded.
  wire();

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
