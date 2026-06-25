/* ============================================================
   You Call Yourself A Friend - SAMPLE app.js
   ------------------------------------------------------------
   Free 12-card teaser. Single device, no multiplayer, no rooms,
   no pairing, no scoring. Just:
     splash -> lead capture -> language -> welcome -> 12 cards -> CTA
   The cards are a browse-through. Each one shows the question and
   its four options so the visitor can imagine playing it with the
   people in their life.
   Namespaced storage + service worker (ycyfs) so it never collides
   with the full game (ycyf).
   ============================================================ */
(function () {
  'use strict';

  var K = {
    order: 'ycyfs_deck_order',
    pos: 'ycyfs_pos',
    // i18n: separate key from the full game so the sample can be its own
    // language without dragging the multiplayer app along. 'en' | 'es'.
    lang: 'ycyfs_lang',
    // Lead capture: once name + phone are submitted, skip the form on return.
    leadCaptured: 'ycyfs_lead_captured',
    leadContactId: 'ycyfs_lead_contact_id'
  };

  function $(id) { return document.getElementById(id); }
  function load(key, fb) { try { var v = localStorage.getItem(key); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function currentLang() {
    var v = null; try { v = JSON.parse(localStorage.getItem(K.lang)); } catch (e) {}
    return v === 'es' ? 'es' : 'en';
  }
  function cardsUrl() { return currentLang() === 'es' ? 'cards.es.json' : 'cards.json'; }

  var DATA = null;
  var UI = {};
  var byId = {};
  var deck = [];
  var pos = 0;

  var SCREENS = ['screen-splash', 'screen-lead', 'screen-language', 'screen-welcome', 'screen-card', 'screen-done'];
  // Screens that carry the persistent help hamburger. Deliberately excludes the
  // splash, lead form, language picker, and Before You Start (the fab would sit
  // over their inputs / tiles / I'm Ready button).
  var MENU_SCREENS = ['screen-card', 'screen-done'];
  // Where "I'm Ready" returns to when Before You Start was re-opened from the
  // drawer's How to Play. null = normal first-run flow (start the deck at 0).
  var welcomeReturn = null;

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function buildDeck() {
    deck = shuffle(DATA.cards.map(function (c) { return c.id; }));
    pos = 0; persist();
  }
  function persist() { save(K.order, deck); save(K.pos, pos); }

  function showScreen(id, withFade) {
    function swap() {
      SCREENS.forEach(function (s) {
        var el = $(s);
        if (!el) return;
        if (s === id) { el.hidden = false; el.classList.remove('fading'); }
        else { el.hidden = true; }
      });
      var fab = $('menu-fab');
      if (fab) fab.hidden = (MENU_SCREENS.indexOf(id) === -1);
    }
    if (withFade) {
      var current = SCREENS.map($).filter(function (el) { return el && !el.hidden; })[0];
      if (current) { current.classList.add('fading'); setTimeout(swap, 320); return; }
    }
    swap();
  }

  // Substitute the [Subject] token with the sample's generic stand-in
  // ("your friend" / "esa persona"), then capitalize the first letter so
  // cards that open on [Subject] still read as a proper sentence.
  function interp(text) {
    var word = (UI.subject_word || 'your friend');
    var out = String(text == null ? '' : text).replace(/\[Subject\]/g, word);
    return out.charAt(0).toUpperCase() + out.slice(1);
  }

  function letters(card) {
    if (card.type === 'mc4') return ['A', 'B', 'C', 'D'];
    if (card.type === 'mc6') return ['A', 'B', 'C', 'D', 'E', 'F'];
    if (card.type === 'tf') return ['T', 'F'];
    return (card.options || []).map(function (o) { return o.letter; });
  }
  function optText(card, L) {
    var o = (card.options || []).find(function (x) { return x.letter === L; });
    return o ? o.text : '';
  }
  function makeAnswerTile(letter, text) {
    var li = document.createElement('li');
    li.className = 'answer-tile';
    if (letter) {
      var l = document.createElement('span');
      l.className = 'answer-letter'; l.textContent = letter;
      li.appendChild(l);
    }
    var t = document.createElement('span');
    t.className = 'answer-text'; t.textContent = text;
    li.appendChild(t);
    return li;
  }

  function renderCard() {
    var card = byId[deck[pos]];
    if (!card) return;
    $('card-theme').textContent = card.theme || '';
    $('card-text').textContent = interp(card.text);
    var typeLabel = $('card-type-label');
    if (typeLabel) typeLabel.textContent = (UI.card && UI.card.type_label) || '';
    var grid = $('answer-grid');
    grid.innerHTML = '';
    letters(card).forEach(function (L) {
      grid.appendChild(makeAnswerTile(L, interp(optText(card, L))));
    });
    var of = (UI.card && UI.card.of) || 'of';
    $('progress-count').textContent = (pos + 1) + ' ' + of + ' ' + deck.length;
    var back = $('btn-back');
    if (back) back.style.visibility = pos > 0 ? 'visible' : 'hidden';
  }

  function goNext() {
    if (pos + 1 >= deck.length) { pos = deck.length; persist(); showScreen('screen-done', true); return; }
    pos += 1; persist(); renderCard();
  }
  function goBack() {
    if (pos <= 0) return;
    pos -= 1; persist(); renderCard();
  }
  function startSample() {
    buildDeck();
    showScreen('screen-card', true);
    renderCard();
  }

  // ----- Lead capture -----
  function showLeadError(msg) { var e = $('lead-error'); if (e) { e.textContent = msg; e.hidden = false; } }
  function submitLeadForm() {
    var fnameEl = $('lead-first-name'), phoneEl = $('lead-phone');
    var errEl = $('lead-error'), btn = $('lead-submit');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    var firstName = (fnameEl && fnameEl.value || '').trim();
    var digits = String(phoneEl && phoneEl.value || '').replace(/\D/g, '');
    var tenDigit = digits;
    if (tenDigit.length === 11 && tenDigit.charAt(0) === '1') tenDigit = tenDigit.slice(1);
    var L = UI.lead || {};
    if (!firstName) return showLeadError(L.err_name || 'Please add your first name.');
    if (tenDigit.length !== 10) return showLeadError(L.err_phone || 'Please enter a 10-digit US phone number.');

    var saving = L.saving || 'Saving...';
    var submitTxt = L.submit || 'Get the Sample';
    if (btn) { btn.disabled = true; btn.textContent = saving; }
    fetch('/api/ycyf-sample-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: firstName, phone: tenDigit, tcpa_consent: true })
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        if (r.status === 200 && r.body && r.body.success) {
          save(K.leadCaptured, true);
          if (r.body.contact_id) save(K.leadContactId, r.body.contact_id);
          var hasLang = false; try { hasLang = localStorage.getItem(K.lang) !== null; } catch (e) {}
          showScreen(hasLang ? 'screen-welcome' : 'screen-language', true);
        } else {
          showLeadError((r.body && r.body.error) || (L.err_save || 'Could not save your info. Please try again.'));
          if (btn) { btn.disabled = false; btn.textContent = submitTxt; }
        }
      })
      .catch(function () {
        showLeadError(L.err_net || 'Network error. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = submitTxt; }
      });
  }

  // ----- help drawer + about modal -----
  function visibleScreen() {
    return SCREENS.map($).filter(function (el) { return el && !el.hidden; }).map(function (el) { return el.id; })[0] || 'screen-card';
  }
  function openMenu() {
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
    }, 440);
  }
  function openAbout() {
    $('about-backdrop').hidden = false;
    requestAnimationFrame(function () { $('about-backdrop').classList.add('show'); });
  }
  function closeAbout() {
    $('about-backdrop').classList.remove('show');
    setTimeout(function () { $('about-backdrop').hidden = true; }, 320);
  }
  // Home: confirm, reset the deck position to 0, and return to the splash. The
  // lead-capture flag is deliberately left intact so returning visitors are not
  // asked for their info again.
  function drawerHome() {
    var msg = (UI.drawer && UI.drawer.home_confirm) || 'Leave the sample and go back to the start?';
    if (!confirm(msg)) return;
    pos = 0; save(K.pos, 0);
    showScreen('screen-splash', true);
  }
  // How to Play: re-open Before You Start, remembering where we came from so
  // I'm Ready returns the player there (card view at their spot, or done),
  // rather than restarting the deck at card 1.
  function openHowToPlay() {
    welcomeReturn = visibleScreen();
    showScreen('screen-welcome', true);
  }

  function onAction(action) {
    switch (action) {
      case 'begin': {
        var leadDone = false; try { leadDone = JSON.parse(localStorage.getItem(K.leadCaptured) || 'false') === true; } catch (e) {}
        if (!leadDone) { showScreen('screen-lead', true); return; }
        var hasLang = false; try { hasLang = localStorage.getItem(K.lang) !== null; } catch (e) {}
        showScreen(hasLang ? 'screen-welcome' : 'screen-language', true);
        return;
      }
      case 'submit-lead': submitLeadForm(); return;
      case 'lang-en': save(K.lang, 'en'); location.reload(); return;
      case 'lang-es': save(K.lang, 'es'); location.reload(); return;
      // Help drawer + about modal. Safe before DATA loads; the fab that opens
      // them only ever appears on the card / done screens (post-load) anyway.
      case 'open-menu': openMenu(); return;
      case 'close-menu': closeMenu(); return;
      case 'drawer-about': closeMenu(); openAbout(); return;
      case 'close-about': closeAbout(); return;
      case 'drawer-home': closeMenu(); drawerHome(); return;
      case 'how-to-play': closeMenu(); openHowToPlay(); return;
      case 'drawer-language': closeMenu(); showScreen('screen-language', true); return;
    }
    if (!DATA) return;
    switch (action) {
      case 'ready':
        // If Before You Start was re-opened from the drawer, go back to wherever
        // the player was (card view at their spot, or the done screen). Otherwise
        // this is the normal first-run flow: start the deck at card 1.
        if (welcomeReturn) {
          var back = welcomeReturn; welcomeReturn = null;
          if (back === 'screen-done') { showScreen('screen-done', true); }
          else { showScreen('screen-card', true); renderCard(); }
          break;
        }
        if (!deck.length) buildDeck();
        pos = 0; persist();
        showScreen('screen-card', true);
        renderCard();
        break;
      case 'next': goNext(); break;
      case 'back': goBack(); break;
      case 'reshuffle': startSample(); break;
    }
  }

  function wire() {
    document.body.addEventListener('click', function (e) {
      // Tap-out on a backdrop closes it. Matched by exact id (not closest) so a
      // tap on the drawer / modal content never bubbles up to a close.
      if (e.target.id === 'drawer-backdrop') { closeMenu(); return; }
      if (e.target.id === 'about-backdrop') { closeAbout(); return; }
      var el = e.target.closest('[data-action]');
      if (el) { onAction(el.getAttribute('data-action')); }
    });
    document.body.addEventListener('submit', function (e) {
      if (e.target && e.target.id === 'lead-form') { e.preventDefault(); submitLeadForm(); }
    });
    document.addEventListener('keydown', function (e) {
      if ($('screen-card') && !$('screen-card').hidden) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); goNext(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      }
    });
  }

  // Paint all the translatable chrome from the deck's ui block so EN and ES
  // both read fully localized. Called once on boot (we reload on lang change).
  function applyUI() {
    UI = DATA.ui || {};
    function set(id, txt) { var el = $(id); if (el && txt != null) el.textContent = txt; }
    var s = UI.splash || {}, l = UI.lead || {}, w = UI.welcome || {}, c = UI.card || {}, d = UI.done || {};
    set('splash-badge', s.badge);
    set('splash-begin', s.begin);
    set('lead-title', l.title);
    set('lead-sub', l.sub);
    set('lead-first-label', l.first_label);
    set('lead-phone-label', l.phone_label);
    set('lead-tcpa', l.tcpa);
    set('lead-submit', l.submit);
    var fn = $('lead-first-name'); if (fn && l.first_ph) fn.placeholder = l.first_ph;
    var ph = $('lead-phone'); if (ph && l.phone_ph) ph.placeholder = l.phone_ph;
    set('welcome-title', w.title);
    set('welcome-ready', w.ready);
    var wsign = $('welcome-signoff'); if (wsign && w.signoff) wsign.innerHTML = '<em>' + escHtml(w.signoff) + '</em>';
    var wb = $('welcome-body');
    if (wb) {
      wb.innerHTML = '';
      (w.body || []).forEach(function (p) { var el = document.createElement('p'); el.textContent = p; wb.appendChild(el); });
    }
    // Help drawer + about modal chrome.
    var dr = UI.drawer || {}, mn = UI.menu || {}, ab = UI.about || {};
    set('drawer-home', dr.home);
    set('drawer-how', dr.how_to_play);
    set('drawer-lang', dr.change_language);
    set('drawer-about-item', dr.about);
    set('drawer-foot', dr.foot);
    set('about-title', ab.title);
    set('about-body', ab.body);
    var fab = $('menu-fab'); if (fab && mn.open_label) fab.setAttribute('aria-label', mn.open_label);
    set('next-btn', c.next);
    set('done-title', d.title);
    set('done-sub', d.sub);
    set('done-note', d.note);
    set('done-cta', d.cta);
    set('done-reshuffle', d.reshuffle);
    document.documentElement.lang = (UI.lang === 'es') ? 'es' : 'en';
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function boot(data) {
    DATA = data;
    (data.cards || []).forEach(function (c) { byId[c.id] = c; });
    applyUI();
    // Always open at the splash with a fresh deck so every visit (and every
    // shared link) makes the same first impression, never resumes mid-deck.
    deck = shuffle(data.cards.map(function (c) { return c.id; }));
    pos = 0; persist();
    showScreen('screen-splash', false);
  }

  function fail(msg) {
    document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;' +
      'justify-content:center;text-align:center;padding:2rem;color:#fef9f1;font-family:Georgia,serif;background:#0a1426;">' +
      '<div><p style="color:#ff8b4a;font-size:1.4rem;margin-bottom:.6rem;">You Call Yourself A Friend (Sample)</p>' +
      '<p>' + escHtml(msg) + '</p></div></div>';
  }

  wire();

  var _url = cardsUrl();
  fetch(_url, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(boot)
    .catch(function () {
      fetch(_url).then(function (r) { return r.json(); }).then(boot)
        .catch(function () { fail('The sample could not load. Please reconnect once.'); });
    });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }
})();
