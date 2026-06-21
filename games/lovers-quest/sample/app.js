/* ============================================================
   Lovers Quest SAMPLE app.js
   ------------------------------------------------------------
   Free 12-card teaser. No license gate, no onboarding, no menu,
   no favorites. Just splash -> welcome -> 12 cards -> CTA.
   Context modal still works because it is the whole point of
   the sample (let people feel how the cards open conversations).
   ============================================================ */
(function () {
  'use strict';

  var K = {
    opened: 'lq_sample_has_opened',
    order: 'lq_sample_deck_order',
    pos: 'lq_sample_pos',
    date: 'lq_sample_last_date',
    // i18n: shared with the main app so picking once on either lands you in
    // the right language on both. 'en' (default) | 'es'.
    lang: 'lq_lang',
    // Lead capture: once the visitor submits name + phone, skip the form
    // on return visits. Stores the contact_id GHL returned so Dennis can
    // cross-reference if needed.
    leadCaptured: 'lq_sample_lead_captured',
    leadContactId: 'lq_sample_lead_contact_id'
  };
  function currentLang() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(K.lang)); } catch (e) {}
    return v === 'es' ? 'es' : 'en';
  }
  function cardsUrl() {
    return currentLang() === 'es' ? 'cards.es.json' : 'cards.json';
  }

  // Icons mirror the parent app's set (only the 6 category icons).
  var ICONS = {
    flame: '<svg viewBox="0 0 24 24"><path d="M12 2.5c.6 3.2-1.8 4.3-2.8 6.2-1.4 2.6.3 4.1.3 4.1s-1.6-.4-2.3-2.2c-1 1.3-1.4 2.8-1.4 4.1A6.2 6.2 0 0 0 12 21.5a6.2 6.2 0 0 0 6.2-6.2c0-4.3-3.4-6.1-4.6-9.1-.5-1.3-1.4-2.7-1.6-3.7z"/><path d="M12 21.5c-1.6 0-2.9-1.2-2.9-2.9 0-1.7 1.6-2.6 1.9-4.3.9 1 4 1.7 4 4.3 0 1.7-1.4 2.9-3 2.9z"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="4.2"/><path d="M11 11l8 8M16 16l2-2M18.5 18.5l2-2"/></svg>',
    compass: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2"/><path d="M15.5 8.5l-2 5.2-5.2 2 2-5.2z"/><circle cx="12" cy="12" r=".6"/></svg>',
    'hand-leaf': '<svg viewBox="0 0 24 24"><path d="M3 20c2-3.6 5.5-5.6 9.4-5.6h3.1"/><path d="M15.5 14.4c2.9 0 5.3-2.4 5.3-5.4 0-1.8-.6-3.3-1.4-4.6-1.4 1-3.9 1.4-5.2 3-1 1.2-1.3 2.8-1 4.3"/><path d="M14.2 13.1c1.2-2 3-3.4 5.2-4.1"/></svg>',
    rose: '<svg viewBox="0 0 24 24"><path d="M12 11.5c0-2.2 1.4-4 3.2-4 .9 0 1.6.4 1.6 1.3 0 1.7-2.1 2.7-4.8 2.7z"/><path d="M12 11.5c0-2.2-1.4-4-3.2-4-.9 0-1.6.4-1.6 1.3 0 1.7 2.1 2.7 4.8 2.7z"/><path d="M12 8.2c0-2 1-3.7 2-3.7s2 .9 2 2.6"/><path d="M12 11.5v5.5"/><path d="M12 14.2c1.8 0 3.4-1 4.2-2.6M12 15.4c-1.8 0-3.4-1-4.2-2.6"/><path d="M12 21.5c-.4-2 .3-3.6 1.8-4.6M12 21.5c.4-2-.3-3.6-1.8-4.6"/></svg>',
    crown: '<svg viewBox="0 0 24 24"><path d="M3 8l3.2 3L12 5l5.8 6L21 8l-1.6 10.5H4.6z"/><path d="M4.6 18.5h14.8"/><circle cx="3" cy="8" r="1"/><circle cx="21" cy="8" r="1"/><circle cx="12" cy="5" r="1"/></svg>'
  };

  function $(id) { return document.getElementById(id); }
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var DATA = null;
  var byId = {};
  var catByKey = {};
  var deck = [];
  var pos = 0;

  var SCREENS = ['screen-splash', 'screen-lead', 'screen-language', 'screen-welcome', 'screen-card', 'screen-done'];

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
    pos = 0;
    persist();
  }

  function persist() {
    save(K.order, deck);
    save(K.pos, pos);
    save(K.date, new Date().toISOString());
  }

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

  function renderCard(direction) {
    var card = byId[deck[pos]];
    if (!card) return;
    var cat = catByKey[card.category];
    var qcard = $('qcard');
    function paint() {
      var iconSvg = ICONS[cat.icon] || '';
      $('card-icon').innerHTML = iconSvg;
      var wmL = $('sr-wm-left'); if (wmL) wmL.innerHTML = iconSvg;
      var wmR = $('sr-wm-right'); if (wmR) wmR.innerHTML = iconSvg;
      $('card-cat').textContent = cat.name;
      $('card-text').textContent = card.text;
      $('progress-count').textContent = (pos + 1) + ' of ' + deck.length;
      $('btn-back').style.visibility = pos > 0 ? 'visible' : 'hidden';
      qcard.classList.remove('out');
    }
    qcard.classList.toggle('in-back', direction === 'back');
    if (direction) {
      qcard.classList.add('out');
      setTimeout(paint, 320);
    } else {
      paint();
    }
  }

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
  function showContext() {
    var card = byId[deck[pos]];
    if (!card) return;
    var cat = catByKey[card.category];
    var ctx = card.context || 'Context for this card is coming soon.';
    var paras = ctx.split(/\n\s*\n/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var html = '<div class="ctx-question">' + esc(card.text) + '</div>' +
               '<div class="ctx-body">' + paras + '</div>';
    openModal(cat ? cat.name + ' · Context' : 'Context', html);
  }

  function startSample() {
    buildDeck();
    showScreen('screen-card', true);
    renderCard(null);
  }

  // Lead capture form submit. Posts firstName + phone to /api/lq-sample-lead,
  // which upserts the contact in GHL and adds the "Lovers Quest Sample Lead"
  // tag. On success, persist the captured flag so the form doesn't re-show.
  function submitLeadForm() {
    var fnameEl = $('lead-first-name');
    var phoneEl = $('lead-phone');
    var errEl = $('lead-error');
    var btn = document.querySelector('[data-action="submit-lead"]');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

    var firstName = (fnameEl && fnameEl.value || '').trim();
    var phoneRaw = (phoneEl && phoneEl.value || '');
    var digits = String(phoneRaw).replace(/\D/g, '');
    var tenDigit = digits;
    if (tenDigit.length === 11 && tenDigit.charAt(0) === '1') tenDigit = tenDigit.slice(1);

    if (!firstName) { return showLeadError('Please add your first name.'); }
    if (tenDigit.length !== 10) {
      return showLeadError('Please enter a 10-digit US phone number.');
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    fetch('/api/lq-sample-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: firstName,
        phone: tenDigit,
        tcpa_consent: true,
      }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        if (r.status === 200 && r.body && r.body.success) {
          save(K.leadCaptured, true);
          if (r.body.contact_id) save(K.leadContactId, r.body.contact_id);
          // Continue to language picker (or welcome if lang already set)
          var hasLang = false;
          try { hasLang = localStorage.getItem(K.lang) !== null; } catch (e) {}
          showScreen(hasLang ? 'screen-welcome' : 'screen-language', true);
        } else {
          var msg = (r.body && r.body.error) || 'Could not save your info. Please try again.';
          showLeadError(msg);
          if (btn) { btn.disabled = false; btn.textContent = 'Get the Sample'; }
        }
      })
      .catch(function () {
        showLeadError('Network error. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Get the Sample'; }
      });
  }
  function showLeadError(msg) {
    var errEl = $('lead-error');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }

  function onAction(action) {
    if (action === 'begin') {
      // First visit goes through the lead form. Once captured, second-time
      // users skip the form. Then the language picker is shown if the lang
      // is unset, otherwise straight to the welcome screen.
      var leadDone = false;
      try { leadDone = JSON.parse(localStorage.getItem(K.leadCaptured) || 'false') === true; } catch (e) {}
      if (!leadDone) { showScreen('screen-lead', true); return; }
      var hasLang = false;
      try { hasLang = localStorage.getItem(K.lang) !== null; } catch (e) {}
      if (!hasLang) { showScreen('screen-language', true); }
      else { showScreen('screen-welcome', true); }
      return;
    }
    if (action === 'submit-lead') {
      submitLeadForm();
      return;
    }
    if (action === 'lang-en') {
      save(K.lang, 'en');
      // Reload so all DATA-baked DOM (welcome, completion) repaints fresh.
      location.reload();
      return;
    }
    if (action === 'lang-es') {
      save(K.lang, 'es');
      location.reload();
      return;
    }
    if (!DATA) return;
    switch (action) {
      case 'ready':
        save(K.opened, true);
        if (!deck.length) buildDeck();
        showScreen('screen-card', true);
        renderCard(null);
        break;
      case 'next':         goNext(); break;
      case 'back':         goBack(); break;
      // Home button in the card topbar: confirm if mid-deck, then reset
      // position and return to splash. Language choice (lq_lang) persists
      // so they don't re-pick.
      case 'home-sample':
        if (pos > 0 && pos < deck.length) {
          if (!confirm('Leave this sample and go back to the start?')) break;
        }
        save(K.pos, 0);
        save(K.opened, false);
        pos = 0;
        showScreen('screen-splash', false);
        break;
      case 'context':      showContext(); break;
      case 'reshuffle':    startSample(); break;
      case 'close-modal':  closeModal(); break;
    }
  }

  function wire() {
    document.body.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (el) { onAction(el.getAttribute('data-action')); return; }
      if (e.target.id === 'modal-backdrop') { closeModal(); return; }
    });
    // Lead form: catch Enter-key submits and the submit button so the page
    // does not navigate. The actual handler is submit-lead via data-action.
    document.body.addEventListener('submit', function (e) {
      if (e.target && e.target.id === 'lead-form') {
        e.preventDefault();
        submitLeadForm();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (!$('modal-backdrop').hidden) closeModal(); return; }
      if ($('screen-card') && !$('screen-card').hidden && $('modal-backdrop').hidden) {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); goNext(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      }
    });
  }

  function boot(data) {
    DATA = data;
    data.cards.forEach(function (c) { byId[c.id] = c; });
    data.categories.forEach(function (c) { catByKey[c.key] = c; });
    $('done-crown').innerHTML = ICONS.crown;
    deck = load(K.order, []) || [];
    // The sample is a shareable preview. Every visit starts at the splash
    // AND every tap-through starts at card 1 (not resumed mid-deck). Reset
    // position both in memory and storage on every boot so a returning
    // device with stale state still gets a fresh first impression.
    pos = 0;
    save(K.pos, 0);
    save(K.opened, false);
    showScreen('screen-splash', false);
  }

  function fail(msg) {
    document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;' +
      'justify-content:center;text-align:center;padding:2rem;color:#f5f1e8;font-family:Georgia,serif;">' +
      '<div><p style="color:#d4a957;font-size:1.4rem;margin-bottom:.6rem;">Lovers Quest (Sample)</p>' +
      '<p>' + esc(msg) + '</p></div></div>';
  }

  // Attach click handlers immediately so a fast tap on Begin works even
  // before cards.json finishes loading.
  wire();

  var _initialUrl = cardsUrl();
  fetch(_initialUrl, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(boot)
    .catch(function () {
      fetch(_initialUrl).then(function (r) { return r.json(); }).then(boot)
        .catch(function () { fail('The sample could not load. Please reconnect once.'); });
    });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }
})();
