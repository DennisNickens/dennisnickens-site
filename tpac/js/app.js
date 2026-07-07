/* T-PAC app: auth, onboarding wizard, Ace chat, bag, series,
   tournaments, live matches, account. Vanilla JS, mobile-first.
   Talks to /api/tpac-* with a Bearer token in localStorage. */
(function () {
  'use strict';

  var token = localStorage.getItem('tpac_token') || '';
  var state = { me: null, tab: null, chat: [], compete: { mode: 'list' }, timers: [] };
  var view = document.getElementById('view');

  /* ---------- helpers ---------- */
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('/api/' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.json().then(function (d) { d._status = r.status; return d; }); });
  }
  function clearTimers() { state.timers.forEach(clearTimeout); state.timers = []; }
  function after(ms, fn) { var t = setTimeout(fn, ms); state.timers.push(t); return t; }
  function showErr(id, msg) { var el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
  function fmtLocal(utcIso) {
    if (!utcIso) return '';
    var d = new Date(utcIso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function money(n) { return '$' + (Math.round(Number(n) * 100) / 100).toFixed(2); }
  function chrome(showTabs, showChat) {
    document.getElementById('tabbar').style.display = showTabs ? 'grid' : 'none';
    document.getElementById('chatbar').style.display = showChat ? 'block' : 'none';
    document.getElementById('topStatus').textContent = state.me ? (state.me.profile && state.me.profile.handle ? state.me.profile.handle : state.me.email) : '';
  }

  /* ---------- boot ---------- */
  function boot() {
    clearTimers();
    if (!token) { renderAuth(); return; }
    api('tpac-me').then(function (d) {
      if (!d.ok) { token = ''; localStorage.removeItem('tpac_token'); renderAuth(); return; }
      state.me = d;
      if (!d.onboarded) { renderOnboarding(); return; }
      if (!d.subscribed) { renderPaywall(); return; }
      setTab('coach');
    }).catch(function () { renderAuth('We could not reach the server. Check your connection and try again.'); });
  }

  /* ---------- auth ---------- */
  function renderAuth(prefillErr) {
    clearTimers(); chrome(false, false);
    view.innerHTML =
      '<div class="card" style="margin-top:22px;">' +
      '<h1 class="page" style="margin-top:0;">Lace up.</h1>' +
      '<p class="hint">Sign in to your T-PAC account, or create one to meet your coach.</p>' +
      '<label class="f" for="aEmail">Email</label><input class="f" id="aEmail" type="email" autocomplete="email" />' +
      '<label class="f" for="aPass">Password</label><input class="f" id="aPass" type="password" autocomplete="current-password" />' +
      '<button class="btn" id="loginBtn">Sign In</button>' +
      '<button class="btn ghost" id="signupBtn">Create Account</button>' +
      '<div class="err" id="authErr"></div>' +
      '</div>' +
      '<p class="hint center">7 day free trial, then $14 a month. Cancel anytime.</p>';
    if (prefillErr) showErr('authErr', prefillErr);
    function go(action) {
      var email = document.getElementById('aEmail').value.trim();
      var pass = document.getElementById('aPass').value;
      api('tpac-auth', { body: { action: action, email: email, password: pass } }).then(function (d) {
        if (d.ok && d.token) { token = d.token; localStorage.setItem('tpac_token', token); boot(); }
        else showErr('authErr', ({ valid_email_required: 'Enter a valid email.', password_min_8: 'Password needs at least 8 characters.', email_in_use: 'That email already has an account. Sign in instead.', bad_credentials: 'Email or password did not match.' })[d.error] || 'Something went wrong. Try again.');
      }).catch(function () { showErr('authErr', 'Could not reach the server.'); });
    }
    document.getElementById('loginBtn').onclick = function () { go('login'); };
    document.getElementById('signupBtn').onclick = function () { go('signup'); };
  }

  /* ---------- onboarding wizard ---------- */
  var WIZARD = [
    { key: 'handle', q: 'What should Ace call you?', type: 'text', ph: 'Name or handle' },
    { key: 'hand', q: 'Which hand do you bowl with?', type: 'pick', opts: ['Right', 'Left'] },
    { key: 'delivery', q: 'One-handed or two-handed?', type: 'pick', opts: ['One-handed', 'Two-handed'] },
    { key: 'thumb', q: 'Thumb in the ball, or thumbless?', type: 'pick', opts: ['Thumb', 'Thumbless'] },
    { key: 'style', q: 'What is your style?', type: 'pick', opts: [
      ['Stroker', 'Smooth and accurate, modest hook'],
      ['Tweener', 'In between, versatile'],
      ['Cranker', 'Big revs, big hook'],
      ['Two-hander', 'Two hands on the ball, high revs']] },
    { key: 'ballSpeed', q: 'Rough ball speed in mph?', type: 'pick', opts: ['Under 14', '14 to 16', '16 to 18', 'Over 18', 'Not sure'] },
    { key: 'revRate', q: 'Rough rev rate?', type: 'pick', opts: ['Low (under 250)', 'Medium (250 to 350)', 'High (over 350)', 'Not sure'] },
    { key: 'average', q: 'Current league average?', type: 'text', ph: 'e.g. 165', numeric: true },
    { key: 'highGame', q: 'High game?', type: 'text', ph: 'e.g. 245', numeric: true },
    { key: 'highSeries', q: 'High series?', type: 'text', ph: 'e.g. 640', numeric: true },
    { key: 'homeCenter', q: 'Home bowling center?', type: 'text', ph: 'Center name and city' },
    { key: 'goal', q: 'What is the main goal?', type: 'pick', opts: ['Raise my average', 'Make more spares', 'Read lanes better', 'Compete and win', 'All of it'] },
  ];

  function renderOnboarding() {
    clearTimers(); chrome(false, false);
    var answers = {}, step = 0;

    function intro() {
      view.innerHTML =
        '<div class="card center" style="margin-top:22px;">' +
        aceHeaderHtml() +
        '<h1 class="page">Well hey there, bowler.</h1>' +
        '<p class="hint">I am Ace T. Johnson, your coach in here. Give me two minutes on how you bowl and I will coach you like I have known you for years. The more you share, the smarter I get.</p>' +
        '<button class="btn" id="startWiz">Let’s Do It</button></div>';
      document.getElementById('startWiz').onclick = renderStep;
    }

    function renderStep() {
      if (step >= WIZARD.length) { renderFirstBall(); return; }
      var w = WIZARD[step];
      var html = '<div class="card" style="margin-top:14px;"><div class="steps">QUESTION ' + (step + 1) + ' OF ' + WIZARD.length + '</div>' +
        '<h2 class="sec" style="font-size:1.15rem;color:var(--ink);">' + esc(w.q) + '</h2>';
      if (w.type === 'text') {
        html += '<input class="f" id="wizText" ' + (w.numeric ? 'inputmode="numeric"' : '') + ' placeholder="' + esc(w.ph || '') + '" />' +
          '<button class="btn" id="wizNext">Next</button>';
      } else {
        w.opts.forEach(function (o, i) {
          var label = Array.isArray(o) ? o[0] : o, hint = Array.isArray(o) ? o[1] : '';
          html += '<button class="choice" data-i="' + i + '">' + esc(label) + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</button>';
        });
      }
      html += (step > 0 ? '<button class="btn quiet" id="wizBack">Back</button>' : '') + '</div>';
      view.innerHTML = html;
      if (w.type === 'text') {
        document.getElementById('wizNext').onclick = function () {
          answers[w.key] = document.getElementById('wizText').value.trim();
          step++; renderStep();
        };
      } else {
        view.querySelectorAll('.choice').forEach(function (btn) {
          btn.onclick = function () {
            var o = w.opts[Number(btn.getAttribute('data-i'))];
            answers[w.key] = Array.isArray(o) ? o[0] : o;
            step++; renderStep();
          };
        });
      }
      var back = document.getElementById('wizBack');
      if (back) back.onclick = function () { step--; renderStep(); };
    }

    function renderFirstBall() {
      view.innerHTML =
        '<div class="card" style="margin-top:14px;"><div class="steps">ONE LAST THING</div>' +
        '<h2 class="sec" style="font-size:1.15rem;color:var(--ink);">Add your first bowling ball</h2>' +
        '<p class="hint">Ace coaches off your actual gear. You can add the rest of the bag later.</p>' +
        ballFormHtml({}) +
        '<button class="btn" id="finishBtn">Finish Setup</button>' +
        '<button class="btn quiet" id="skipBtn">Skip For Now</button>' +
        '<div class="err" id="obErr"></div></div>';
      function save(withBall) {
        api('tpac-bowler', { body: { action: 'profile.save', profile: answers } }).then(function (d) {
          if (!d.ok) { showErr('obErr', 'Could not save. Try again.'); return; }
          if (!withBall) { boot(); return; }
          var ball = readBallForm();
          if (!ball.name) { boot(); return; }
          api('tpac-bowler', { body: { action: 'balls.add', ball: ball } }).then(function () { boot(); });
        });
      }
      document.getElementById('finishBtn').onclick = function () { save(true); };
      document.getElementById('skipBtn').onclick = function () { save(false); };
    }

    intro();
  }

  /* ---------- paywall ---------- */
  function renderPaywall() {
    clearTimers(); chrome(false, false);
    var status = state.me.subStatus;
    view.innerHTML =
      '<div class="card center" style="margin-top:22px;">' + aceHeaderHtml() +
      '<h1 class="page">Your coach is ready.</h1>' +
      '<p class="hint">Unlimited coaching with Ace, score tracking, and live head-to-head tournaments. 7 days free, then $14 a month. Cancel anytime from your account screen.</p>' +
      (status === 'past_due' || status === 'canceled' ? '<p class="hint" style="color:var(--red);margin-top:8px;">Your subscription is ' + esc(status === 'past_due' ? 'past due' : 'canceled') + '. Restart it to get back on the lanes.</p>' : '') +
      '<button class="btn" id="trialBtn">' + (status === 'none' ? 'Start Free Trial' : 'Restart Subscription') + '</button>' +
      '<button class="btn quiet" id="outBtn">Sign Out</button>' +
      '<div class="err" id="payErr"></div></div>';
    document.getElementById('trialBtn').onclick = function () {
      api('tpac-billing', { body: { action: 'checkout' } }).then(function (d) {
        if (d.ok && d.url) window.location.href = d.url;
        else showErr('payErr', 'Checkout is not available right now. Try again in a minute.');
      });
    };
    document.getElementById('outBtn').onclick = signOut;
    // Returning from Stripe: the webhook may land a beat after the redirect.
    if (new URLSearchParams(location.search).get('sub') === 'success') {
      view.insertAdjacentHTML('afterbegin', '<p class="hint center" style="margin-top:10px;">Finishing your signup with Stripe&hellip;</p>');
      var tries = 0;
      (function recheck() {
        after(2000, function () {
          api('tpac-me').then(function (d) {
            if (d.ok && d.subscribed) { history.replaceState(null, '', 'app.html'); state.me = d; setTab('coach'); }
            else if (++tries < 10) recheck();
          });
        });
      })();
    }
  }

  function signOut() {
    api('tpac-auth', { body: { action: 'logout' } }).then(function () {
      token = ''; localStorage.removeItem('tpac_token'); state.me = null; boot();
    });
  }

  /* ---------- tabs ---------- */
  function setTab(tab) {
    clearTimers();
    state.tab = tab;
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    chrome(true, tab === 'coach');
    if (tab === 'coach') renderCoach();
    if (tab === 'bag') renderBag();
    if (tab === 'scores') renderScores();
    if (tab === 'compete') { state.compete = { mode: 'list' }; renderCompete(); }
    if (tab === 'account') renderAccount();
  }
  document.querySelectorAll('.tabbar button').forEach(function (b) {
    b.onclick = function () { setTab(b.getAttribute('data-tab')); };
  });

  function aceHeaderHtml() {
    return '<div class="ace-head"><div class="ace-avatar" id="aceAvatar" aria-hidden="true">A</div>' +
      '<div><div class="ace-name">Ace T. Johnson</div><div class="ace-sub">Your T-PAC coach</div></div></div>';
    // To drop in the real art: put the image at /tpac/ace.png and replace the
    // "A" placeholder with <img src="ace.png" alt="Ace T. Johnson">.
  }

  /* ---------- coach chat ---------- */
  function renderCoach() {
    view.innerHTML = aceHeaderHtml() + '<div class="chat" id="chatLog"><p class="hint center">Loading your conversation&hellip;</p></div>';
    api('tpac-coach').then(function (d) {
      state.chat = (d.ok && d.messages) || [];
      paintChat();
      if (!state.chat.length) {
        state.chat.push({ role: 'ace', text: 'Hey ' + ((state.me.profile && state.me.profile.handle) || 'there') + ', Ace here. How did the lanes treat you lately? Tell me what the ball is doing and where, and we will get to work.' });
        paintChat();
      }
    });
  }
  function paintChat() {
    var log = document.getElementById('chatLog');
    if (!log) return;
    log.innerHTML = state.chat.map(function (m) {
      return '<div class="msg ' + (m.role === 'ace' ? 'ace' : 'me') + '">' + esc(m.text) + '</div>';
    }).join('') || '<p class="hint center">Say hello to Ace below.</p>';
    window.scrollTo(0, document.body.scrollHeight);
  }
  document.getElementById('chatSend').onclick = sendChat;
  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  function sendChat() {
    var input = document.getElementById('chatInput');
    var text = input.value.trim();
    if (!text || state.tab !== 'coach') return;
    input.value = '';
    state.chat.push({ role: 'user', text: text });
    state.chat.push({ role: 'ace', text: 'Ace is thinking…', typing: true });
    paintChat();
    var typingIdx = state.chat.length - 1;
    api('tpac-coach', { body: { message: text } }).then(function (d) {
      state.chat[typingIdx] = { role: 'ace', text: d.ok ? d.reply : 'I lost you for a second there. Send that one more time.' };
      paintChat();
    }).catch(function () {
      state.chat[typingIdx] = { role: 'ace', text: 'Connection hiccup. Send that again when you are back online.' };
      paintChat();
    });
  }

  /* ---------- my bag ---------- */
  function ballFormHtml(b) {
    return '<label class="f">Ball name and brand</label><input class="f" id="bName" value="' + esc(b.name) + '" placeholder="e.g. Storm Phaze II" />' +
      '<label class="f">Coverstock</label><input class="f" id="bCover" value="' + esc(b.coverstock) + '" placeholder="e.g. solid reactive" />' +
      '<label class="f">Drilling / layout notes</label><input class="f" id="bLayout" value="' + esc(b.layout) + '" placeholder="e.g. pin up, 4x4" />' +
      '<label class="f">Surface</label><input class="f" id="bSurface" value="' + esc(b.surface) + '" placeholder="e.g. 2000 grit, or polished" />' +
      '<label class="f">Role in the bag</label><select class="f" id="bRole">' +
      ['', 'benchmark', 'big hook', 'control', 'spare'].map(function (r) {
        return '<option value="' + r + '"' + (b.role === r ? ' selected' : '') + '>' + (r || 'Pick a role') + '</option>';
      }).join('') + '</select>';
  }
  function readBallForm() {
    return {
      name: document.getElementById('bName').value.trim(),
      coverstock: document.getElementById('bCover').value.trim(),
      layout: document.getElementById('bLayout').value.trim(),
      surface: document.getElementById('bSurface').value.trim(),
      role: document.getElementById('bRole').value,
    };
  }
  function renderBag(editing) {
    api('tpac-me').then(function (d) {
      if (d.ok) state.me = d;
      var balls = state.me.balls || [];
      var html = '<h1 class="page">My Bag</h1>';
      if (!balls.length) html += '<div class="card hint">No balls yet. Add your gear so Ace can coach off your actual arsenal.</div>';
      balls.forEach(function (b) {
        html += '<div class="card"><div class="row"><div class="grow"><strong>' + esc(b.name) + '</strong>' +
          '<div class="hint">' + esc([b.coverstock, b.surface, b.layout].filter(Boolean).join(' · ')) + '</div>' +
          (b.role ? '<span class="pill amber" style="margin-top:6px;">' + esc(b.role) + '</span>' : '') + '</div>' +
          '<button class="btn quiet" style="width:auto;margin:0;" data-edit="' + b.id + '">Edit</button>' +
          '<button class="btn quiet" style="width:auto;margin:0;color:var(--red);" data-del="' + b.id + '">Delete</button>' +
          '</div></div>';
      });
      var b = editing ? (balls.find(function (x) { return x.id === editing; }) || {}) : {};
      html += '<div class="card"><h2 class="sec">' + (editing ? 'Edit Ball' : 'Add a Ball') + '</h2>' + ballFormHtml(b) +
        '<button class="btn" id="ballSave">' + (editing ? 'Save Changes' : 'Add to Bag') + '</button>' +
        (editing ? '<button class="btn quiet" id="ballCancel">Cancel</button>' : '') +
        '<div class="err" id="bagErr"></div></div>';
      view.innerHTML = html;
      document.getElementById('ballSave').onclick = function () {
        var ball = readBallForm();
        if (!ball.name) { showErr('bagErr', 'Give the ball a name.'); return; }
        if (editing) ball.id = editing;
        api('tpac-bowler', { body: { action: editing ? 'balls.update' : 'balls.add', ball: ball } }).then(function (r) {
          if (r.ok) renderBag(); else showErr('bagErr', 'Could not save the ball.');
        });
      };
      var cancel = document.getElementById('ballCancel');
      if (cancel) cancel.onclick = function () { renderBag(); };
      view.querySelectorAll('[data-edit]').forEach(function (btn) { btn.onclick = function () { renderBag(btn.getAttribute('data-edit')); }; });
      view.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.onclick = function () {
          api('tpac-bowler', { body: { action: 'balls.delete', id: btn.getAttribute('data-del') } }).then(function () { renderBag(); });
        };
      });
    });
  }

  /* ---------- scores (series log) ---------- */
  function renderScores() {
    api('tpac-me').then(function (d) {
      if (d.ok) state.me = d;
      var html = '<h1 class="page">Log a Series</h1><div class="card">' +
        '<label class="f">Date</label><input class="f" id="sDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '" />' +
        '<label class="f">Center</label><input class="f" id="sCenter" placeholder="' + esc((state.me.profile && state.me.profile.homeCenter) || 'Bowling center') + '" />' +
        '<label class="f">Oil pattern (optional)</label><input class="f" id="sPattern" placeholder="e.g. house shot, 41 ft" />' +
        '<label class="f">Game scores (comma separated)</label><input class="f" id="sGames" inputmode="numeric" placeholder="e.g. 178, 204, 191" />' +
        '<label class="f">Pins left / notes (optional)</label><textarea class="f" id="sNotes" rows="2" placeholder="e.g. kept leaving the 10 pin in game 2"></textarea>' +
        '<button class="btn" id="sSave">Log It</button><div class="err" id="sErr"></div></div>' +
        '<h2 class="sec" style="margin:16px 2px 8px;">Recent Series</h2>';
      var series = state.me.series || [];
      if (!series.length) html += '<div class="card hint">Nothing logged yet. Ace coaches best off real games.</div>';
      series.forEach(function (s) {
        var total = (s.games || []).reduce(function (a, b) { return a + b; }, 0);
        html += '<div class="card"><div class="row"><div class="grow"><strong>' + esc(s.date) + (s.center ? ' · ' + esc(s.center) : '') + '</strong>' +
          '<div class="hint">' + (s.pattern ? esc(s.pattern) + ' · ' : '') + esc((s.games || []).join(', ')) + '</div>' +
          (s.notes ? '<div class="hint">' + esc(s.notes) + '</div>' : '') + '</div>' +
          '<div style="font-family:var(--mono);font-weight:700;color:var(--amber);">' + total + '</div></div></div>';
      });
      view.innerHTML = html;
      document.getElementById('sSave').onclick = function () {
        var games = document.getElementById('sGames').value.split(',').map(function (g) { return Number(g.trim()); }).filter(function (g) { return !isNaN(g) && g !== 0 || g === 0; });
        api('tpac-bowler', { body: { action: 'series.add', series: {
          date: document.getElementById('sDate').value,
          center: document.getElementById('sCenter').value.trim(),
          pattern: document.getElementById('sPattern').value.trim(),
          games: games,
          notes: document.getElementById('sNotes').value.trim(),
        } } }).then(function (r) {
          if (r.ok) renderScores();
          else showErr('sErr', 'Enter at least one game score between 0 and 300.');
        });
      };
    });
  }

  /* ---------- compete ---------- */
  var MONEY_DISCLAIMER = '<div class="disclaim">Entry fees and prize money are collected and paid out by the bracket organizer in person. T-PAC tracks the ledger only and never moves prize money.</div>';

  function renderCompete() {
    clearTimers();
    var c = state.compete;
    if (c.mode === 'create') { renderCreateBracket(); return; }
    if (c.mode === 'bracket') { renderBracketDetail(c.bid); return; }
    if (c.mode === 'match') { renderMatch(c.mid); return; }
    if (c.mode === 'lobby') { renderLobby(); return; }

    view.innerHTML = '<h1 class="page">Compete</h1>' +
      '<div class="card"><h2 class="sec">Bowling right now?</h2>' +
      '<p class="hint">Jump in the live lobby and we will match you with another bowler for an instant head-to-head, wherever they are.</p>' +
      '<button class="btn green" id="liveBtn">I’m Bowling Live</button></div>' +
      '<div class="row" style="margin:6px 2px 10px;"><h2 class="sec" style="margin:0;" class="grow">Open Brackets</h2>' +
      '<button class="btn quiet grow" style="margin:0;max-width:150px;margin-left:auto;" id="createBtn">Create Bracket</button></div>' +
      '<div id="bracketList"><p class="hint">Loading brackets&hellip;</p></div>';
    document.getElementById('liveBtn').onclick = function () { state.compete = { mode: 'lobby' }; renderCompete(); };
    document.getElementById('createBtn').onclick = function () { state.compete = { mode: 'create' }; renderCompete(); };
    api('tpac-brackets').then(function (d) {
      var list = document.getElementById('bracketList');
      if (!list) return;
      if (!d.ok) { list.innerHTML = '<div class="card hint">' + (d.error === 'subscription_required' ? 'Tournaments need an active subscription.' : 'Could not load brackets.') + '</div>'; return; }
      if (!d.brackets.length) { list.innerHTML = '<div class="card hint">No brackets yet. Create the first one and invite your league.</div>'; return; }
      list.innerHTML = d.brackets.map(function (b) {
        var statusPill = b.status === 'live' ? '<span class="pill live">LIVE</span>' : b.status === 'complete' ? '<span class="pill">DONE</span>' : '<span class="pill amber">OPEN</span>';
        return '<div class="card" role="button" tabindex="0" data-bid="' + esc(b.id) + '" style="cursor:pointer;">' +
          '<div class="row"><div class="grow"><strong>' + esc(b.name) + '</strong>' +
          '<div class="hint">' + b.size + ' bowlers · ' + money(b.entryFee) + ' entry · ' + esc(b.format) +
          (b.scheduledStartUtc ? ' · ' + fmtLocal(b.scheduledStartUtc) : ' · starts when full') + '</div>' +
          '<div class="hint">' + b.entered + '/' + b.size + ' entered · by ' + esc(b.organizerHandle) + '</div></div>' + statusPill + '</div></div>';
      }).join('');
      list.querySelectorAll('[data-bid]').forEach(function (el) {
        el.onclick = function () { state.compete = { mode: 'bracket', bid: el.getAttribute('data-bid') }; renderCompete(); };
      });
    });
  }

  function renderCreateBracket() {
    var localDefault = new Date(Date.now() + 60 * 60000);
    localDefault.setSeconds(0, 0);
    var dtValue = new Date(localDefault.getTime() - localDefault.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    view.innerHTML = '<h1 class="page">Create a Bracket</h1><div class="card">' +
      '<label class="f">Bracket name</label><input class="f" id="cName" placeholder="e.g. Friday Night Shootout" />' +
      '<div class="grid2"><div><label class="f">Size</label><select class="f" id="cSize"><option>4</option><option selected>8</option><option>16</option></select></div>' +
      '<div><label class="f">Entry fee ($)</label><input class="f" id="cFee" inputmode="decimal" value="5" /></div></div>' +
      '<div class="grid2"><div><label class="f">Format</label><select class="f" id="cFormat"><option value="scratch">Scratch</option><option value="handicap">Handicap</option></select></div>' +
      '<div><label class="f">Entry type</label><select class="f" id="cType"><option value="scheduled">Scheduled</option><option value="pickup">Pickup (starts when full)</option></select></div></div>' +
      '<div id="schedWrap"><label class="f">Start date and time (your local time)</label><input class="f" id="cStart" type="datetime-local" value="' + dtValue + '" /></div>' +
      '<div class="grid2" id="hcWrap" style="display:none;"><div><label class="f">Handicap base</label><input class="f" id="cBase" inputmode="numeric" value="220" /></div>' +
      '<div><label class="f">Handicap %</label><input class="f" id="cPct" inputmode="numeric" value="90" /></div></div>' +
      '<div class="grid2"><div><label class="f">Round break (min)</label><input class="f" id="cBreak" inputmode="numeric" value="10" /></div>' +
      '<div><label class="f">Frame limit (sec)</label><input class="f" id="cFrameSec" inputmode="numeric" value="180" /></div></div>' +
      '<label class="f">Slow play policy</label><select class="f" id="cSlow"><option value="flag">Flag it (visible warning)</option><option value="forfeit">Forfeit after 3 flags</option></select>' +
      '<label class="f">Payout split (percent of pool: 1st, 2nd, ... then rake)</label>' +
      '<div class="grid2"><input class="f" id="cSplit" value="62.5, 25" aria-label="Payout percentages by place" /><input class="f" id="cRake" value="12.5" aria-label="Organizer rake percent" /></div>' +
      '<p class="hint" id="splitPreview" style="margin-top:8px;"></p>' +
      '<button class="btn" id="cCreate">Create Bracket</button>' +
      '<button class="btn quiet" id="cBack">Back</button>' +
      '<div class="err" id="cErr"></div>' + MONEY_DISCLAIMER + '</div>';
    document.getElementById('cType').onchange = function () {
      document.getElementById('schedWrap').style.display = this.value === 'scheduled' ? 'block' : 'none';
    };
    document.getElementById('cFormat').onchange = function () {
      document.getElementById('hcWrap').style.display = this.value === 'handicap' ? 'grid' : 'none';
    };
    function preview() {
      var size = Number(document.getElementById('cSize').value), fee = Number(document.getElementById('cFee').value) || 0;
      var pool = size * fee;
      var splits = document.getElementById('cSplit').value.split(',').map(Number);
      var rake = Number(document.getElementById('cRake').value) || 0;
      var sum = splits.reduce(function (a, b) { return a + (b || 0); }, 0) + rake;
      var parts = splits.map(function (p, i) { return (i + 1) + (i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th') + ' ' + money(pool * p / 100); });
      document.getElementById('splitPreview').textContent = 'Full field pool ' + money(pool) + ': ' + parts.join(', ') + ', organizer keeps ' + money(pool * rake / 100) + (Math.abs(sum - 100) > 0.001 ? ' — percentages must total 100 (now ' + sum + ')' : '');
    }
    ['cSize', 'cFee', 'cSplit', 'cRake'].forEach(function (id) { document.getElementById(id).oninput = preview; });
    preview();
    document.getElementById('cBack').onclick = function () { state.compete = { mode: 'list' }; renderCompete(); };
    document.getElementById('cCreate').onclick = function () {
      var body = {
        action: 'create',
        name: document.getElementById('cName').value.trim() || 'T-PAC Bracket',
        size: Number(document.getElementById('cSize').value),
        entryFee: Number(document.getElementById('cFee').value) || 0,
        format: document.getElementById('cFormat').value,
        entryType: document.getElementById('cType').value,
        scheduledStartUtc: document.getElementById('cType').value === 'scheduled' ? new Date(document.getElementById('cStart').value).toISOString() : null,
        base: Number(document.getElementById('cBase').value),
        percent: Number(document.getElementById('cPct').value),
        roundBreakMinutes: Number(document.getElementById('cBreak').value),
        frameTimeLimitSeconds: Number(document.getElementById('cFrameSec').value),
        slowPolicy: document.getElementById('cSlow').value,
        splitPercents: document.getElementById('cSplit').value.split(',').map(Number),
        rakePercent: Number(document.getElementById('cRake').value),
      };
      api('tpac-brackets', { body: body }).then(function (d) {
        if (d.ok) { state.compete = { mode: 'bracket', bid: d.bracket.id }; renderCompete(); }
        else showErr('cErr', ({ split_must_total_100: 'Payout percentages plus rake must total 100.', bad_start_time: 'Pick a start time in the future.', size_must_be_4_8_16: 'Size must be 4, 8, or 16.' })[d.error] || 'Could not create the bracket.');
      });
    };
  }

  function boardHtml(name, total, frames, frameScores, currentFrame, isLive) {
    var cells = '';
    for (var i = 0; i < 10; i++) {
      var rolls = frames[i] || [];
      var marks = '';
      if (rolls.length) {
        if (i < 9) marks = rolls[0] === 10 ? '<span class="x">X</span>' : esc(rolls[0]) + (rolls.length > 1 ? (rolls[0] + rolls[1] === 10 ? '/' : (rolls[1] === 0 ? '-' : esc(rolls[1]))) : '');
        else marks = rolls.map(function (r, j) {
          if (r === 10) return '<span class="x">X</span>';
          if (j > 0 && rolls[j - 1] !== 10 && rolls[j - 1] + r === 10) return '/';
          return r === 0 ? '-' : String(r);
        }).join('');
      }
      cells += '<div class="fr' + (isLive && i === currentFrame ? ' now' : '') + '"><div class="num">' + (i + 1) + '</div><div class="marks">' + marks + '</div><div class="cum">' + (frameScores[i] === null || frameScores[i] === undefined ? '' : frameScores[i]) + '</div></div>';
    }
    return '<div class="board"><div class="who"><span class="nm">' + esc(name) + '</span><span class="tot">' + total + '</span></div><div class="frames">' + cells + '</div></div>';
  }

  function renderBracketDetail(bid) {
    api('tpac-brackets?bid=' + encodeURIComponent(bid)).then(function (d) {
      if (state.tab !== 'compete' || state.compete.mode !== 'bracket') return;
      if (!d.ok) { view.innerHTML = '<div class="card hint">Bracket not found.</div>'; return; }
      var b = d.bracket, my = d.myUid;
      var joined = b.entries.some(function (e) { return e.uid === my; });
      var myMatch = null;
      d.matches.forEach(function (m) {
        if (m.status !== 'complete' && m.status !== 'bye' && m.slots.some(function (s) { return s && s.uid === my; })) myMatch = m;
      });

      var html = '<button class="btn quiet" id="backList" style="margin-top:0;">← All Brackets</button>' +
        '<h1 class="page">' + esc(b.name) + ' ' + (b.status === 'live' ? '<span class="pill live">LIVE</span>' : b.status === 'complete' ? '<span class="pill">DONE</span>' : '<span class="pill amber">OPEN</span>') + '</h1>' +
        '<div class="card"><div class="hint">' + b.size + ' bowlers · ' + money(b.entryFee) + ' entry · ' + esc(b.format) +
        (b.format === 'handicap' ? ' (base ' + b.base + ', ' + b.percent + '%)' : '') +
        (b.scheduledStartUtc ? ' · starts ' + fmtLocal(b.scheduledStartUtc) : ' · starts when full') + '</div>' +
        '<div class="hint" style="margin-top:6px;">Entered: ' + (b.entries.map(function (e) { return esc(e.handle); }).join(', ') || 'nobody yet') + '</div>' +
        (b.champion ? '<p style="margin-top:10px;font-family:var(--display);color:var(--amber);">Champion: ' + esc(b.champion.handle) + ' &#127942;</p>' : '') +
        (!joined && b.status === 'open' ? '<button class="btn" id="joinBtn">Join for ' + money(b.entryFee) + '</button>' : '') +
        (myMatch ? '<button class="btn green" id="myMatchBtn">Go To My Match</button>' : '') +
        '<div class="err" id="bErr"></div></div>';

      if (b.rounds.length) {
        var roundNames = { 0: 'Round 1', 1: b.rounds.length === 2 ? 'Final' : 'Semifinals', 2: b.rounds.length === 3 ? 'Final' : 'Semifinals', 3: 'Final' };
        b.rounds.forEach(function (roundIds, r) {
          var label = (r === b.rounds.length - 1 && Math.pow(2, b.rounds.length - 1 - r) * roundIds.length * 2 <= 2) ? 'Final' : (roundNames[r] || 'Round ' + (r + 1));
          if (roundIds.length === 1) label = 'Final';
          html += '<div class="round"><h3>' + label + '</h3>';
          roundIds.forEach(function (midId) {
            var m = d.matches.find(function (x) { return x.id === midId; });
            if (!m) return;
            html += '<div class="mcard">';
            m.slots.forEach(function (s) {
              if (!s) { html += '<div class="p lose"><span>bye</span></div>'; return; }
              var cls = m.winnerUid ? (m.winnerUid === s.uid ? 'win' : 'lose') : '';
              html += '<div class="p ' + cls + '"><span>' + esc(s.handle) + (s.seed ? ' <span class="hint">(' + s.seed + ')</span>' : '') + (m.forfeitUid === s.uid ? ' <span class="pill red">forfeit</span>' : '') + '</span></div>';
            });
            html += '<div class="hint">' + (m.status === 'complete' ? 'Done' : m.status === 'bye' ? 'Bye' : m.status === 'live' ? 'Bowling now' : m.status === 'awaiting_verification' ? 'Verifying scores' : 'Starts ' + fmtLocal(m.startAtUtc)) + '</div>';
            html += '</div>';
          });
          html += '</div>';
        });
      }

      if (d.ledger && d.ledger.length) {
        var isOrganizer = b.organizerUid === my;
        html += '<div class="card"><h2 class="sec">Ledger</h2><table class="ledger" style="width:100%;border-collapse:collapse;"><tr><th>Who</th><th>What</th><th class="amt">Amount</th><th>Status</th></tr>';
        d.ledger.forEach(function (e) {
          var what = e.type === 'entry' ? 'Entry fee' : e.type === 'rake' ? 'Organizer keeps' : (e.place === 1 ? '1st place' : e.place === 2 ? '2nd place' : 'Payout');
          html += '<tr><td>' + esc(e.handle) + '</td><td>' + what + '</td><td class="amt">' + money(e.amount) + '</td><td>' +
            (isOrganizer && e.type === 'entry'
              ? '<button class="btn quiet" style="margin:0;min-height:34px;padding:4px 10px;" data-paid="' + e.id + '" data-next="' + (e.status === 'paid' ? '0' : '1') + '">' + (e.status === 'paid' ? 'paid ✓' : 'mark paid') + '</button>'
              : esc(e.status)) + '</td></tr>';
        });
        html += '</table>' + MONEY_DISCLAIMER + '</div>';
      }

      if (b.chat && b.chat.length) {
        html += '<div class="card"><h2 class="sec">Bracket Chat</h2>' + b.chat.slice(-4).map(function (c) {
          return '<div class="msg ace" style="max-width:100%;margin-bottom:8px;"><strong>' + esc(c.from) + ':</strong> ' + esc(c.text) + '</div>';
        }).join('') + '</div>';
      }

      view.innerHTML = html;
      document.getElementById('backList').onclick = function () { state.compete = { mode: 'list' }; renderCompete(); };
      var joinBtn = document.getElementById('joinBtn');
      if (joinBtn) joinBtn.onclick = function () {
        api('tpac-brackets', { body: { action: 'join', bid: bid } }).then(function (r) {
          if (r.ok) renderBracketDetail(bid);
          else showErr('bErr', ({ average_required_for_handicap: 'Handicap brackets need your league average. Set it in Account > Profile first.', bracket_full: 'This bracket just filled up.', already_joined: 'You are already in.' })[r.error] || 'Could not join.');
        });
      };
      var mm = document.getElementById('myMatchBtn');
      if (mm) mm.onclick = function () { state.compete = { mode: 'match', mid: myMatch.id, bid: bid }; renderCompete(); };
      view.querySelectorAll('[data-paid]').forEach(function (btn) {
        btn.onclick = function () {
          api('tpac-brackets', { body: { action: 'mark-paid', bid: bid, ledgerEntryId: btn.getAttribute('data-paid'), paid: btn.getAttribute('data-next') === '1' } })
            .then(function () { renderBracketDetail(bid); });
        };
      });

      if (b.status !== 'complete') after(4000, function () { if (state.compete.mode === 'bracket' && state.compete.bid === bid) renderBracketDetail(bid); });
    });
  }

  /* ---------- live pickup lobby ---------- */
  function renderLobby() {
    view.innerHTML = '<h1 class="page">Live Lobby</h1><div class="card center">' +
      '<p class="hint">Waiting for another live bowler. Keep this screen open. The moment someone else taps in, your match starts.</p>' +
      '<div class="big-timer" style="margin:16px 0;" id="lobbyDots">● ○ ○</div>' +
      '<button class="btn quiet" id="lobbyLeave">Leave Lobby</button></div>';
    var dots = 1;
    function tick() {
      api('tpac-lobby', { body: { action: 'poll' } }).then(function (d) {
        if (state.compete.mode !== 'lobby') return;
        if (d.ok && d.matched) { state.compete = { mode: 'match', mid: d.matched.mid, bid: d.matched.bid }; renderCompete(); return; }
        dots = (dots % 3) + 1;
        var el = document.getElementById('lobbyDots');
        if (el) el.textContent = [1, 2, 3].map(function (i) { return i <= dots ? '●' : '○'; }).join(' ');
        after(2500, tick);
      });
    }
    api('tpac-lobby', { body: { action: 'join' } }).then(function (d) {
      if (d.ok && d.matched) { state.compete = { mode: 'match', mid: d.matched.mid, bid: d.matched.bid }; renderCompete(); return; }
      after(2500, tick);
    });
    document.getElementById('lobbyLeave').onclick = function () {
      api('tpac-lobby', { body: { action: 'leave' } }).then(function () { state.compete = { mode: 'list' }; renderCompete(); });
    };
  }

  /* ---------- live match ---------- */
  var pendingRolls = [];

  function renderMatch(mid) {
    api('tpac-match?mid=' + encodeURIComponent(mid)).then(function (d) {
      if (state.tab !== 'compete' || state.compete.mode !== 'match') return;
      if (!d.ok) { view.innerHTML = '<div class="card hint">Match not found.</div>'; return; }
      paintMatch(d);
      if (d.match.status !== 'complete') after(2500, function () { if (state.compete.mode === 'match' && state.compete.mid === mid) renderMatch(mid); });
    });
  }

  function paintMatch(d) {
    var m = d.match, my = d.myUid;
    var me = m.slots.find(function (s) { return s && s.uid === my; });
    var opp = m.slots.find(function (s) { return s && s.uid !== my; });
    var myScore = me ? m.scores[me.uid] : null;
    var myFrames = me ? (m.frames[me.uid] || []) : [];
    var currentFrame = myFrames.length;
    var useHc = m.settings.format === 'handicap';

    var html = '<button class="btn quiet" id="backBr" style="margin-top:0;">← Bracket</button>' +
      '<h1 class="page">' + esc(me ? me.handle : '') + ' vs ' + esc(opp ? opp.handle : 'bye') + '</h1>';

    if (m.status === 'ready_check' || m.status === 'pending') {
      var startLocal = fmtLocal(m.startAtUtc);
      html += '<div class="card center"><h2 class="sec">Ready Check</h2>' +
        '<p class="hint">Match time: <strong>' + startLocal + '</strong> (your local time). Both bowlers confirm they are at the lanes. No-show after the grace window is a forfeit.</p>' +
        '<div style="margin:12px 0;">' +
        m.slots.map(function (s) {
          if (!s) return '';
          return '<div class="row" style="justify-content:center;gap:8px;margin:6px 0;"><span>' + esc(s.handle) + '</span>' +
            (m.ready[s.uid] ? '<span class="pill live">READY</span>' : '<span class="pill">waiting</span>') + '</div>';
        }).join('') + '</div>' +
        (me && !m.ready[me.uid] ? '<button class="btn green" id="readyBtn">I’m Here, Ready To Bowl</button>' : '<p class="hint">Waiting on your opponent&hellip;</p>') +
        '<div class="err" id="mErr"></div></div>';
    }

    if (m.status === 'live' || m.status === 'awaiting_verification' || m.status === 'complete') {
      // Opponent board first: this is the head-to-head view.
      [opp, me].forEach(function (s) {
        if (!s) return;
        var sc = m.scores[s.uid];
        var totalLabel = useHc ? (sc.raw + '+' + sc.handicap + '=' + sc.withHandicap) : String(sc.raw);
        html += boardHtml(s.handle + (s.uid === my ? ' (you)' : ''), totalLabel, m.frames[s.uid] || [], sc.frameScores, s.uid === my ? currentFrame : (m.frames[s.uid] || []).length, m.status === 'live');
        if (sc.slowFlags > 0) html += '<p class="hint" style="color:var(--red);margin:-4px 0 8px;">' + esc(s.handle) + ': ' + sc.slowFlags + ' slow-play flag' + (sc.slowFlags > 1 ? 's' : '') + (m.settings.slowPolicy === 'forfeit' ? ' (3 forfeits the match)' : '') + '</p>';
      });
    }

    if (m.status === 'live' && me && !myScore.complete) {
      html += '<div class="card"><h2 class="sec">Frame ' + (currentFrame + 1) + (pendingRolls.length ? ' · rolls so far: ' + pendingRolls.join(', ') : '') + '</h2>' +
        '<p class="hint">Tap pins knocked down for each roll. ' + Math.round(m.settings.frameTimeLimitSeconds / 60) + ' minute pace per frame.</p>' +
        '<div class="pad" id="pad"></div><div class="err" id="mErr"></div></div>';
    }

    if (m.status === 'awaiting_verification' && me) {
      var myPhoto = m.photos[me.uid], oppPhoto = opp ? m.photos[opp.uid] : null;
      html += '<div class="card"><h2 class="sec">Verify Scores</h2>' +
        '<p class="hint">Both bowlers upload a photo of the overhead score screen, then confirm each other’s game. This protects money brackets.</p>';
      if (!myPhoto) {
        html += '<label class="f">Your score screen photo</label><input class="f" type="file" id="photoIn" accept="image/*" capture="environment" />';
      } else {
        html += '<p class="hint">Your photo is in. ✓</p>';
      }
      if (oppPhoto) {
        html += '<p style="margin-top:10px;"><a href="' + esc(oppPhoto) + '" target="_blank" rel="noopener">View ' + esc(opp.handle) + '’s score photo</a></p>' +
          (!m.confirms[me.uid] ? '<button class="btn green" id="confirmBtn">Confirm ' + esc(opp.handle) + '’s Score</button>' : '<p class="hint">You confirmed their score. ✓</p>');
      } else {
        html += '<p class="hint" style="margin-top:10px;">Waiting on ' + esc(opp ? opp.handle : 'opponent') + '’s photo…</p>';
      }
      var myTb = m.tiebreak && m.tiebreak[me.uid];
      var tied = myScore && opp && m.scores[opp.uid].complete && myScore.complete &&
        (useHc ? myScore.withHandicap === m.scores[opp.uid].withHandicap : myScore.raw === m.scores[opp.uid].raw);
      if (tied && m.photos[me.uid] && oppPhoto && m.confirms[me.uid] && m.confirms[opp.uid]) {
        html += '<div style="margin-top:12px;"><h2 class="sec">Tiebreak</h2><p class="hint">Dead even. Each bowler bowls one extra frame and enters the total (0 to 30). High frame advances.</p>' +
          (typeof myTb === 'number' ? '<p class="hint">Your tiebreak: ' + myTb + '. Waiting on opponent.</p>'
            : '<input class="f" id="tbScore" inputmode="numeric" placeholder="Your extra frame total" /><button class="btn" id="tbBtn">Submit Tiebreak</button>');
      }
      html += '<div class="err" id="mErr"></div></div>';
    }

    if (m.status === 'complete') {
      var winner = m.slots.find(function (s) { return s && s.uid === m.winnerUid; });
      var iWon = me && m.winnerUid === me.uid;
      html += '<div class="card center"><h2 class="sec">' + (iWon ? 'You won! &#127942;' : winner ? esc(winner.handle) + ' takes it.' : 'Match complete.') + '</h2>' +
        (m.forfeitUid ? '<p class="hint">Won by forfeit.</p>' : '') +
        '<p class="hint">' + (iWon ? 'Winner advances. Watch the bracket for your next match time.' : 'Tough one. Log the series and let Ace find the adjustment.') + '</p></div>';
    }

    view.innerHTML = html;
    document.getElementById('backBr').onclick = function () {
      var bid = state.compete.bid || m.bid;
      state.compete = { mode: 'bracket', bid: bid }; renderCompete();
    };
    var readyBtn = document.getElementById('readyBtn');
    if (readyBtn) readyBtn.onclick = function () {
      api('tpac-match', { body: { action: 'ready', mid: m.id } }).then(function (r) {
        if (!r.ok && r.error === 'ready_check_not_open') showErr('mErr', 'Ready check opens 10 minutes before match time.');
        else renderMatch(m.id);
      });
    };

    // Frame entry keypad
    var pad = document.getElementById('pad');
    if (pad && me) {
      var maxPins = 10;
      if (currentFrame < 9) {
        if (pendingRolls.length === 1) maxPins = 10 - pendingRolls[0];
      } else {
        // Tenth frame: fresh rack after a strike or spare.
        if (pendingRolls.length === 1 && pendingRolls[0] < 10) maxPins = 10 - pendingRolls[0];
        if (pendingRolls.length === 2) {
          var r0 = pendingRolls[0], r1 = pendingRolls[1];
          if (r0 === 10 && r1 < 10) maxPins = 10 - r1;
        }
      }
      for (var p = 0; p <= 10; p++) {
        var btn = document.createElement('button');
        btn.textContent = p === 10 ? 'X' : String(p);
        btn.disabled = p > maxPins;
        btn.setAttribute('data-pins', String(p));
        pad.appendChild(btn);
      }
      pad.onclick = function (ev) {
        var b = ev.target.closest('button');
        if (!b || b.disabled) return;
        pendingRolls.push(Number(b.getAttribute('data-pins')));
        var doneRegular = currentFrame < 9 && (pendingRolls[0] === 10 || pendingRolls.length === 2);
        var earnedFill = currentFrame === 9 && pendingRolls.length >= 2 && (pendingRolls[0] === 10 || pendingRolls[0] + pendingRolls[1] === 10);
        var doneTenth = currentFrame === 9 && ((pendingRolls.length === 2 && !earnedFill) || pendingRolls.length === 3);
        if (doneRegular || doneTenth) {
          var rolls = pendingRolls.slice();
          pendingRolls = [];
          api('tpac-match', { body: { action: 'frame', mid: m.id, frameIndex: currentFrame, rolls: rolls } }).then(function (r) {
            if (!r.ok) { showErr('mErr', 'That frame did not add up. Enter it again.'); }
            renderMatch(m.id);
          });
        } else {
          renderMatch(m.id); // repaint keypad limits with pending roll shown
        }
      };
    }

    var photoIn = document.getElementById('photoIn');
    if (photoIn) photoIn.onchange = function () {
      var file = photoIn.files && photoIn.files[0];
      if (!file) return;
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        api('tpac-match', { body: { action: 'photo', mid: m.id, imageBase64: cv.toDataURL('image/jpeg', 0.72) } }).then(function (r) {
          if (!r.ok) showErr('mErr', 'Photo upload failed. Try again.');
          renderMatch(m.id);
        });
      };
      img.src = URL.createObjectURL(file);
    };
    var confirmBtn = document.getElementById('confirmBtn');
    if (confirmBtn) confirmBtn.onclick = function () {
      api('tpac-match', { body: { action: 'confirm', mid: m.id } }).then(function () { renderMatch(m.id); });
    };
    var tbBtn = document.getElementById('tbBtn');
    if (tbBtn) tbBtn.onclick = function () {
      api('tpac-match', { body: { action: 'tiebreak', mid: m.id, score: Number(document.getElementById('tbScore').value) } }).then(function (r) {
        if (!r.ok) showErr('mErr', 'Tiebreak is a number from 0 to 30.');
        renderMatch(m.id);
      });
    };
  }

  /* ---------- account ---------- */
  function renderAccount() {
    var me = state.me;
    view.innerHTML = '<h1 class="page">Account</h1>' +
      '<div class="card"><h2 class="sec">Subscription</h2>' +
      '<p>' + esc(me.email) + '</p>' +
      '<p class="hint">Status: <strong>' + esc(me.subStatus) + '</strong>' + (me.subStatus === 'trialing' ? ' (free trial)' : '') + '</p>' +
      '<button class="btn quiet" id="portalBtn">Manage or Cancel Billing</button>' +
      '<div class="err" id="acctErr"></div></div>' +
      '<div class="card"><h2 class="sec">Bowler Profile</h2>' +
      '<p class="hint">' + esc((me.profile && me.profile.handle) || '') + (me.profile && me.profile.average ? ' · avg ' + esc(me.profile.average) : '') + (me.profile && me.profile.homeCenter ? ' · ' + esc(me.profile.homeCenter) : '') + '</p>' +
      '<button class="btn quiet" id="redoBtn">Update Profile With Ace</button></div>' +
      '<div class="card"><button class="btn quiet" id="signOutBtn" style="margin:0;">Sign Out</button></div>';
    document.getElementById('portalBtn').onclick = function () {
      api('tpac-billing', { body: { action: 'portal' } }).then(function (d) {
        if (d.ok && d.url) window.location.href = d.url;
        else showErr('acctErr', d.error === 'no_subscription' ? 'Start a subscription first.' : 'Billing portal is not available right now.');
      });
    };
    document.getElementById('redoBtn').onclick = function () { renderOnboarding(); };
    document.getElementById('signOutBtn').onclick = signOut;
  }

  boot();
})();
