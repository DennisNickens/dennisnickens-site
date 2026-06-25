/* ============================================================
   You Call Yourself A Friend - Phase 1 (lobby foundation)
   ------------------------------------------------------------
   This deploy ships the working real-time multiplayer foundation:

     Router -> Host Setup OR Join Setup -> Lobby

   Host creates a room (POST /api/friend-create-room). They get a
   4-letter code and a QR code that links to the join URL with the
   code pre-filled. Other players scan it or type the code, name
   themselves, and join (POST /api/friend-join-room). Every device
   polls /api/friend-room-state every 2 seconds for updates so
   everyone watches the player list grow in real time.

   The "Pair Up" button lives in the lobby but only routes to a
   placeholder pairing screen for now. Subsequent deploys add:
   pairing UI, the rotating-Subject round loop, the answer-and-guess
   mechanic, the score meter, and the race-car visualization.
   ============================================================ */
(function () {
  'use strict';

  // ----- DOM helpers -----
  function $(id) { return document.getElementById(id); }
  function load(key, fallback) { try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function clear(key) { try { localStorage.removeItem(key); } catch (e) {} }

  var SCREENS = ['screen-router', 'screen-language', 'screen-onboarding', 'screen-host-setup', 'screen-join-setup', 'screen-lobby', 'screen-pairing', 'screen-team-setup', 'screen-playing', 'screen-explain', 'screen-game-over'];
  // Screens that show the persistent help hamburger (lobby through game-over).
  var IN_GAME_SCREENS = ['screen-lobby', 'screen-pairing', 'screen-team-setup', 'screen-playing', 'screen-explain', 'screen-game-over'];

  // Same palette as lib/friend-state.js TEAM_ICONS. Hardcoded here so the
  // picker grid renders immediately without an extra round trip. Server is
  // still the authority on validation.
  var TEAM_ICONS = ['🔥', '⚡', '💎', '⭐', '🚀', '🌊', '🦁', '🦊', '🐯', '🐺', '🌙', '☀️'];
  function show(id) {
    SCREENS.forEach(function (s) { var el = $(s); if (!el) return; el.hidden = (s !== id); });
    // The help hamburger rides along on in-game screens only.
    var fab = $('menu-fab');
    if (fab) fab.hidden = (IN_GAME_SCREENS.indexOf(id) === -1);
    applyI18n();
  }

  // ----- localStorage state (per device) -----
  var K = {
    code: 'ycyf_room_code',
    playerId: 'ycyf_player_id',
    name: 'ycyf_name',
    isHost: 'ycyf_is_host',
    gender: 'ycyf_gender',
    lang: 'ycyf_lang',
    onboarded: 'ycyf_onboarded'
  };

  // ----- i18n -----
  // currentLang() drives which deck file loads (cards.json vs cards.es.json)
  // and whether UI shell strings get swapped. DECK_UI holds the loaded deck's
  // optional `ui` block (only present in the Spanish deck). applyI18n() walks
  // [data-i18n] elements and replaces their text from DECK_UI; it is a no-op
  // for English (DECK_UI stays null), so the existing English HTML is untouched.
  function currentLang() {
    return load(K.lang, null) === 'es' ? 'es' : 'en';
  }
  function cardsUrl() {
    return currentLang() === 'es' ? 'cards.es.json' : 'cards.json';
  }
  var DECK_UI = null;
  function applyI18n() {
    if (!DECK_UI) return;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var path = nodes[i].getAttribute('data-i18n').split('.');
      var v = DECK_UI;
      for (var p = 0; p < path.length && v != null; p++) v = v[path[p]];
      if (typeof v === 'string') nodes[i].textContent = v;
    }
  }
  // Render-time i18n lookup for strings the JS builds dynamically (round
  // counter, role eyebrows, statuses, reveal lines, button busy-states,
  // theme labels). Returns the Spanish string from the loaded deck's ui
  // block with {placeholders} filled, or null so callers fall back to the
  // inline English (the EN deck has no ui block).
  function uiT(path, vars) {
    if (!DECK_UI) return null;
    var v = DECK_UI, parts = path.split('.');
    for (var i = 0; i < parts.length && v != null; i++) v = v[parts[i]];
    if (typeof v !== 'string') return null;
    if (vars) v = v.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; });
    return v;
  }
  // Translate a theme key (e.g. "Free Time") via ui.themes, else passthrough.
  function themeLabel(theme) {
    if (DECK_UI && DECK_UI.themes && DECK_UI.themes[theme]) return DECK_UI.themes[theme];
    return theme;
  }

  // ----- API helpers -----
  function api(path, opts) {
    var init = { method: (opts && opts.method) || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts && opts.body) init.body = JSON.stringify(opts.body);
    return fetch(path, init).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; }).catch(function () {
        return { status: r.status, body: null };
      });
    });
  }

  // ----- polling -----
  var pollHandle = null;
  function startPolling() {
    stopPolling();
    pollHandle = setInterval(refreshRoom, 2000);
    // Also kick off an immediate poll so the UI doesn't wait the full interval.
    setTimeout(refreshRoom, 100);
  }
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }

  // ----- room render -----
  var lastRoom = null;
  // True while the onboarding walkthrough or the language picker sits on top of
  // a live room. Blocks the poll's screen routing so it does not yank the
  // player off the overlay. Closing the overlay re-renders the real screen.
  var routeLock = false;

  async function refreshRoom() {
    var code = load(K.code, null);
    var pid = load(K.playerId, null);
    if (!code) { stopPolling(); return; }
    try {
      var r = await api('/api/friend-room-state?code=' + encodeURIComponent(code) + '&viewerId=' + encodeURIComponent(pid || ''));
      if (r.status !== 200 || !r.body || !r.body.ok) {
        // Room expired or got deleted; kick back to router.
        if (r.body && r.body.error === 'room_not_found') {
          clearLocalState();
          show('screen-router');
          stopPolling();
        }
        return;
      }
      lastRoom = r.body.room;
      renderRoom(lastRoom);
    } catch (e) {
      // Network blip; let the next poll retry.
    }
  }

  function renderRoom(room) {
    if (!room) return;
    // While the onboarding walkthrough or the language picker is open over the
    // top, the 2-second poll must not yank the player back to a game screen.
    // We still let lastRoom update (the caller sets it); we just defer the
    // screen routing until the overlay closes (finishOnboarding re-renders).
    if (routeLock) return;
    // Phase routing: lobby for now; future phases will jump screens here.
    var pid = load(K.playerId, null);
    var isHost = room.hostId === pid;
    save(K.isHost, isHost);

    $('lobby-code').textContent = room.code;
    var note = $('lobby-host-note');
    if (note) note.hidden = isHost;
    var startBtn = $('start-btn');
    if (startBtn) {
      startBtn.disabled = !isHost || (room.players || []).length < 4;
      startBtn.style.display = isHost ? '' : 'none';
    }
    var ul = $('player-list');
    if (ul) {
      ul.innerHTML = '';
      (room.players || []).forEach(function (p) {
        var li = document.createElement('li');
        var cls = [];
        if (p.isHost) cls.push('is-host');
        if (p.id === pid) cls.push('is-you');
        if (cls.length) li.className = cls.join(' ');
        // Build row: dot + name + (host-only) remove button for non-host players
        var dot = document.createElement('span'); dot.className = 'player-dot';
        var name = document.createElement('span'); name.className = 'player-name'; name.textContent = p.name;
        li.appendChild(dot);
        li.appendChild(name);
        if (isHost && !p.isHost) {
          var btn = document.createElement('button');
          btn.className = 'player-remove';
          btn.setAttribute('aria-label', 'Remove ' + p.name);
          btn.setAttribute('data-action', 'host-remove');
          btn.setAttribute('data-target', p.id);
          btn.setAttribute('data-name', p.name);
          btn.innerHTML = '&times;';
          li.appendChild(btn);
        }
        ul.appendChild(li);
      });
    }
    var count = (room.players || []).length;
    var min = 4;
    var max = 10;
    var msg;
    if (count < min) {
      msg = uiT('lobby.count_min', { count: count, min: min }) || (count + ' of ' + min + ' minimum players');
    } else if (count >= max) {
      msg = uiT('lobby.count_full', { max: max }) || ('Room full (' + max + ' players)');
    } else {
      msg = uiT('lobby.count_room', { count: count, extra: (max - count) }) || (count + ' players, room for ' + (max - count) + ' more');
    }
    var c = $('lobby-count'); if (c) c.textContent = msg;

    // Route screen by phase
    if (room.phase === 'pairing') {
      show('screen-pairing');
      renderPairing(room);
    } else if (room.phase === 'teamSetup') {
      show('screen-team-setup');
      renderTeamSetup(room);
    } else if (room.phase === 'playing' || room.phase === 'roundEnd') {
      // Stale-room guard: a room created before Phase 3 deployed will be in
      // phase 'playing' but missing the deck, pair colors, or currentCardId.
      // Trying to render that state strands the user on a blank playing
      // screen with no way out. Eject them cleanly to the router instead so
      // they can start fresh.
      var hasGameState = room.currentCardId && (room.pairs || []).length > 0
        && (room.turnOrder || []).length > 0;
      if (!hasGameState) {
        console.warn('[ycyf] stale room state detected; ejecting to router');
        clearLocalState();
        stopPolling();
        show('screen-router');
        return;
      }
      show('screen-playing');
      renderPlaying(room);
    } else if (room.phase === 'overtime') {
      show('screen-playing');
      renderOvertime(room);
    } else if (room.phase === 'gameOver') {
      show('screen-game-over');
      renderGameOver(room);
    }
  }

  // ---------- Phase 3: live game loop ----------
  // CARDS_DATA / CARD_BY_ID lazy-loaded from cards.json. We don't block
  // boot on it; if the game enters the playing phase before the file
  // lands, renderPlaying just re-queues itself when the fetch resolves.
  var CARDS_DATA = null;
  var CARD_BY_ID = {};
  var cardsLoadPromise = null;
  function loadCardsOnce() {
    if (CARDS_DATA) return Promise.resolve(CARDS_DATA);
    if (cardsLoadPromise) return cardsLoadPromise;
    var url = cardsUrl();
    cardsLoadPromise = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); })
      .then(function (j) {
        CARDS_DATA = j;
        (j.cards || []).forEach(function (c) { CARD_BY_ID[c.id] = c; });
        // Spanish deck carries a `ui` block; capture it and apply shell strings.
        if (j.ui) { DECK_UI = j.ui; applyI18n(); }
        return j;
      });
    return cardsLoadPromise;
  }

  // Local-only pick state: what the viewer has tapped but not yet
  // submitted. Cleared whenever the card or subPhase changes.
  var pendingPick = null;

  // Local-only: which team row the host has expanded in the icon picker
  // or has open for team-name editing. Not synced.
  var teamRowOpen = null;

  // ---------- Team Setup (icons + names + confirm) ----------
  function renderTeamSetup(room) {
    var me = load(K.playerId, null);
    var isHost = room.hostId === me;
    var iconsView = $('team-icons-view');
    var confirmView = $('team-confirm-view');
    if (!iconsView || !confirmView) return;
    if (room.subPhase === 'confirming') {
      iconsView.hidden = true;
      confirmView.hidden = false;
      renderTeamConfirm(room, isHost);
    } else {
      iconsView.hidden = false;
      confirmView.hidden = true;
      renderTeamIcons(room, isHost);
    }
  }

  function renderTeamIcons(room, isHost) {
    var ul = $('team-rows-icons'); if (!ul) return;
    ul.innerHTML = '';
    var pairs = room.pairs || [];
    var usedIcons = pairs.map(function (pr) { return pr.icon; }).filter(Boolean);

    pairs.forEach(function (pr) {
      var li = document.createElement('li');
      var open = teamRowOpen === pr.id;
      li.className = 'team-row pair-' + (pr.color || 'coral') + (open ? ' is-open' : '');
      if (isHost) li.setAttribute('data-action', 'host-open-team-row');
      li.setAttribute('data-target', pr.id);

      var head = document.createElement('div');
      head.className = 'team-row-head';
      var iconSlot = document.createElement('span');
      iconSlot.className = 'team-row-icon';
      iconSlot.textContent = pr.icon || '?';
      var names = document.createElement('span');
      names.className = 'team-row-names';
      names.textContent = (room.players || [])
        .filter(function (p) { return pr.playerIds.indexOf(p.id) !== -1; })
        .map(function (p) { return p.name; }).join(' & ');
      head.appendChild(iconSlot);
      head.appendChild(names);
      li.appendChild(head);

      if (open && isHost) {
        var picker = document.createElement('ul');
        picker.className = 'icon-picker';
        TEAM_ICONS.forEach(function (ic) {
          var b = document.createElement('li');
          var taken = usedIcons.indexOf(ic) !== -1 && pr.icon !== ic;
          b.className = 'icon-tile'
            + (pr.icon === ic ? ' is-selected' : '')
            + (taken ? ' is-taken' : '');
          b.textContent = ic;
          if (!taken) {
            b.setAttribute('data-action', 'host-pick-team-icon');
            b.setAttribute('data-pair', pr.id);
            b.setAttribute('data-icon', ic);
          }
          picker.appendChild(b);
        });
        li.appendChild(picker);
      }
      ul.appendChild(li);
    });

    var allIconed = pairs.length > 0 && pairs.every(function (pr) { return !!pr.icon; });
    var btn = $('confirm-icons-btn');
    if (btn) {
      btn.hidden = !isHost;
      btn.disabled = !allIconed;
    }
    var note = $('icons-host-note'); if (note) note.hidden = isHost;
    var lead = $('icons-lead');
    if (lead) {
      var count = pairs.filter(function (pr) { return !!pr.icon; }).length;
      lead.textContent = isHost
        ? count + ' of ' + pairs.length + ' teams have icons. Tap a team to pick.'
        : 'The host is choosing team icons.';
    }
  }

  function renderTeamConfirm(room, isHost) {
    var ul = $('team-rows-confirm'); if (!ul) return;
    ul.innerHTML = '';
    var pairs = room.pairs || [];
    pairs.forEach(function (pr) {
      var li = document.createElement('li');
      var open = teamRowOpen === pr.id;
      li.className = 'team-row pair-' + (pr.color || 'coral') + (open ? ' is-open' : '');

      var head = document.createElement('div');
      head.className = 'team-row-head';
      if (isHost) head.setAttribute('data-action', 'host-open-team-row');
      head.setAttribute('data-target', pr.id);
      var iconSlot = document.createElement('span');
      iconSlot.className = 'team-row-icon';
      iconSlot.textContent = pr.icon || '?';
      var meta = document.createElement('span');
      meta.className = 'team-row-meta';
      var nameLine = document.createElement('span');
      nameLine.className = 'team-row-team-name';
      nameLine.textContent = pr.teamName || 'Team ' + (pr.icon || '?');
      var memberLine = document.createElement('span');
      memberLine.className = 'team-row-members';
      memberLine.textContent = (room.players || [])
        .filter(function (p) { return pr.playerIds.indexOf(p.id) !== -1; })
        .map(function (p) { return p.name; }).join(' & ');
      meta.appendChild(nameLine);
      meta.appendChild(memberLine);
      head.appendChild(iconSlot);
      head.appendChild(meta);
      li.appendChild(head);

      if (open && isHost) {
        var editor = document.createElement('div');
        editor.className = 'team-name-editor';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-input';
        input.placeholder = 'Team name (optional)';
        input.maxLength = 24;
        input.value = pr.teamName || '';
        input.setAttribute('data-pair', pr.id);
        input.setAttribute('data-action-target', 'team-name-input');
        editor.appendChild(input);
        var save = document.createElement('button');
        save.className = 'btn btn-primary team-name-save';
        save.textContent = 'Save';
        save.setAttribute('data-action', 'host-save-team-name');
        save.setAttribute('data-pair', pr.id);
        editor.appendChild(save);
        li.appendChild(editor);
      }
      ul.appendChild(li);
    });

    var startBtn = $('real-start-game-btn');
    var backBtn = $('back-to-icons-btn');
    if (startBtn) startBtn.hidden = !isHost;
    if (backBtn) backBtn.hidden = !isHost;
    var note = $('confirm-host-note'); if (note) note.hidden = isHost;

    // Depth picker reflects room.depth (defaults to 'real' from startTeamSetup)
    var chosen = room.depth || 'real';
    var picker = $('depth-picker');
    if (picker) {
      var tiles = picker.querySelectorAll('.depth-tile');
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        var d = t.getAttribute('data-depth');
        if (d === chosen) t.classList.add('is-selected');
        else t.classList.remove('is-selected');
        // Non-hosts can't tap the selectable tile either
        if (!isHost && t.classList.contains('depth-selectable')) {
          t.removeAttribute('data-action');
        } else if (isHost && t.classList.contains('depth-selectable')) {
          t.setAttribute('data-action', 'host-set-depth');
        }
      }
    }
    var dnote = $('depth-host-note'); if (dnote) dnote.hidden = isHost;
  }

  async function hostStartTeamSetupAct() {
    var btn = $('start-game-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('pairing.loading') || 'Loading...'; }
    try {
      var r = await api('/api/friend-start-team-setup', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        alert('Could not advance: ' + ((r.body && r.body.error) || 'unknown'));
        if (btn) { btn.disabled = false; btn.textContent = uiT('pairing.next_button') || 'Next: Pick Icons →'; }
      }
    } catch (e) {
      alert('Network error.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('pairing.next_button') || 'Next: Pick Icons →'; }
    }
  }

  function hostOpenTeamRow(pairId) {
    teamRowOpen = (teamRowOpen === pairId) ? null : pairId;
    renderRoom(lastRoom);
  }

  async function hostPickTeamIcon(pairId, icon) {
    try {
      var r = await api('/api/friend-set-team-icon', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, ''), pairId: pairId, icon: icon },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        teamRowOpen = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var err = (r.body && r.body.error) || 'unknown';
        if (err === 'icon_taken') alert('That icon is already taken by another team.');
        else alert('Could not set icon: ' + err);
      }
    } catch (e) {
      alert('Network error setting icon.');
    }
  }

  async function hostAdvanceToConfirmAct() {
    var btn = $('confirm-icons-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('team_setup.confirming') || 'Confirming...'; }
    try {
      var r = await api('/api/friend-advance-to-confirm', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        teamRowOpen = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        alert('Could not advance: ' + ((r.body && r.body.error) || 'unknown'));
        if (btn) { btn.disabled = false; btn.textContent = uiT('team_setup.next_confirm_button') || 'Next: Confirm Teams →'; }
      }
    } catch (e) {
      alert('Network error.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('team_setup.next_confirm_button') || 'Next: Confirm Teams →'; }
    }
  }

  async function hostBackToIconsAct() {
    try {
      var r = await api('/api/friend-back-to-picking-icons', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        teamRowOpen = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      }
    } catch (e) {}
  }

  async function hostSetDepthAct(depth) {
    if (!depth) return;
    try {
      var r = await api('/api/friend-set-depth', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, ''), depth: depth },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var err = (r.body && r.body.error) || 'unknown';
        if (err === 'depth_coming_soon') alert('That depth is coming soon. Real is ready to play right now.');
        else alert('Could not set depth: ' + err);
      }
    } catch (e) {
      alert('Network error setting depth.');
    }
  }

  async function hostSaveTeamNameAct(pairId) {
    var input = document.querySelector('input[data-action-target="team-name-input"][data-pair="' + pairId + '"]');
    if (!input) return;
    var value = String(input.value || '').trim();
    try {
      var r = await api('/api/friend-set-team-name', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, ''), pairId: pairId, teamName: value },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        teamRowOpen = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        alert('Could not save name: ' + ((r.body && r.body.error) || 'unknown'));
      }
    } catch (e) {
      alert('Network error.');
    }
  }

  function letters(card) {
    if (card.type === 'mc4') return ['A','B','C','D'];
    if (card.type === 'mc6') return ['A','B','C','D','E','F'];
    if (card.type === 'tf') return ['T','F'];
    return [];
  }
  function tfLabel(L) { return L === 'T' ? 'True' : 'False'; }
  function subjectName(room) {
    var p = (room.players || []).find(function (x) { return x.id === room.currentSubjectId; });
    return p ? p.name : 'Subject';
  }
  // Interpolate the [Subject] token into any card-authored text (the card
  // body AND answer-option text both use it), substituting the live Subject.
  function interp(text, room) {
    return String(text == null ? '' : text).replace(/\[Subject\]/g, subjectName(room));
  }
  function playerNameById(room, pid) {
    if (pid === 'NOT_AT_TABLE') return 'Someone not at this table';
    var p = (room.players || []).find(function (x) { return x.id === pid; });
    return p ? p.name : '?';
  }
  function pickDisplay(card, pick, room) {
    if (!pick) return '—';
    if (card.type === 'mc4' || card.type === 'mc6') return pick;
    if (card.type === 'tf') return tfLabel(pick);
    if (card.type === 'group_vote') return playerNameById(room, pick);
    return String(pick);
  }
  function makeAnswerTile(letter, text, selected) {
    var li = document.createElement('li');
    li.className = 'answer-tile' + (selected ? ' is-selected' : '');
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
  function showElem(id) { var el = $(id); if (el) el.hidden = false; }
  function hideElems(ids) { ids.forEach(function (i) { var el = $(i); if (el) el.hidden = true; }); }

  // Phase 5: each player is in one of three roles per turn.
  function roleOf(room, viewerId) {
    if (viewerId === room.currentSubjectId) return 'subject';
    var activePair = (room.pairs || []).find(function (pr) { return pr.id === room.currentPairId; });
    if (activePair && activePair.playerIds.indexOf(viewerId) !== -1) return 'partner';
    return 'spectator';
  }

  function renderPlaying(room) {
    if (!CARDS_DATA) {
      loadCardsOnce().then(function () { if (lastRoom) renderPlaying(lastRoom); }).catch(function () {});
      var ct = $('card-text'); if (ct) ct.textContent = uiT('playing.loading_deck') || 'Loading the deck...';
      return;
    }
    var me = load(K.playerId, null);
    var card = CARD_BY_ID[room.currentCardId];
    if (!card) return;

    // Gendered Choice+Explain cards carry optionsMale / optionsFemale instead
    // of options. The server resolves the Subject-gender-matched pool into
    // room.currentCardOptions; use that, falling back to a local resolve from
    // the Subject's gender. Clone the card so we never mutate the cached copy.
    if (card.genderedOptions) {
      var resolved = (room.currentCardOptions && room.currentCardOptions.length)
        ? room.currentCardOptions
        : ((subjectGenderIsFemale(room) ? card.optionsFemale : card.optionsMale) || []);
      card = assignCard(card, resolved);
    }

    if (renderPlaying._lastCardId !== room.currentCardId ||
        renderPlaying._lastSubPhase !== room.subPhase) {
      pendingPick = null;
      renderPlaying._lastCardId = room.currentCardId;
      renderPlaying._lastSubPhase = room.subPhase;
    }

    var role = roleOf(room, me);
    var isTalkCard = card.type === 'reflection' || card.type === 'discussion';

    // Universal Explain (#86): the Explain step is now folded into the reveal
    // view (see renderReveal) and fires on every scoring round, so there is no
    // longer a separate full-screen Explain panel gated to requireExplain cards.

    gameOverCelebrated = false;            // armed for the next game-over
    var obMain = $('overtime-banner'); if (obMain) obMain.hidden = true;
    renderRace(room);
    renderCardFrame(room, card);
    hideElems(['guesser-view','subject-view','talk-view','spectator-view','reveal-view']);

    if (room.subPhase === 'reveal') {
      renderReveal(room, card, role);
      showElem('reveal-view');
    } else if (isTalkCard) {
      renderTalk(room, card, role);
      showElem('talk-view');
    } else if (role === 'subject') {
      renderSubject(room, card);
      showElem('subject-view');
    } else if (role === 'partner') {
      renderPartnerGuesser(room, card, me);
      showElem('guesser-view');
    } else {
      renderSpectator(room, card);
      showElem('spectator-view');
    }
  }

  // Is the current Subject female? Used as a client-side fallback for gendered
  // option pools when the server-resolved currentCardOptions isn't present.
  function subjectGenderIsFemale(room) {
    var subj = (room.players || []).find(function (p) { return p.id === room.currentSubjectId; });
    return !!(subj && subj.gender === 'female');
  }
  // Shallow card clone with options swapped in (avoids mutating CARD_BY_ID).
  function assignCard(card, options) {
    var out = {};
    for (var k in card) { if (Object.prototype.hasOwnProperty.call(card, k)) out[k] = card[k]; }
    out.options = options;
    return out;
  }

  // EXPLAIN panel (Choice+Explain cards). Re-shows the card text and the
  // Subject's revealed answer. The Subject gets the "Done. Next card." button;
  // partner and spectators get a listen prompt. No timer, no auto-advance.
  function renderExplain(room, card, role) {
    var t = $('explain-card-text'); if (t) t.textContent = interp(card.text || '', room);
    var truth = room.subjectAnswer;
    var ans = '';
    if (truth != null) {
      var opt = (card.options || []).find(function (o) { return o.letter === truth; });
      ans = opt ? (opt.letter + '. ' + interp(opt.text || '', room)) : String(truth);
    }
    var a = $('explain-answer'); if (a) a.textContent = ans;
    var btn = $('explain-done-btn');
    var listen = $('explain-listen');
    if (role === 'subject') {
      if (btn) { btn.hidden = false; btn.disabled = false; }
      if (listen) listen.hidden = true;
    } else {
      if (btn) btn.hidden = true;
      if (listen) { listen.hidden = false; listen.textContent = uiT('explain.listen', { name: subjectName(room) || 'the subject' }) || ('Listen to ' + (subjectName(room) || 'the subject') + "'s answer."); }
    }
  }

  function renderRace(room) {
    var r = $('race-round'); if (r) r.textContent = (uiT('playing.round_label') || 'Round') + ' ' + (room.round || 1);
    var ul = $('race-cars'); if (!ul) return;
    ul.innerHTML = '';
    var cap = room.cap || 25;
    (room.pairs || []).forEach(function (pr) {
      var li = document.createElement('li');
      li.className = 'race-car pair-' + (pr.color || 'coral');
      li.setAttribute('data-pair', pr.id);
      var pct = Math.max(0, Math.min(100, ((pr.score || 0) / cap) * 100));
      li.style.left = pct + '%';
      // Car is the team's chosen icon; name labels removed so they don't
      // overlap at low scores. Color comes through on the score badge.
      var car = document.createElement('span');
      car.className = 'race-car-icon'; car.textContent = pr.icon || '🏎';
      var bub = document.createElement('span');
      bub.className = 'race-car-score';
      bub.textContent = String(pr.score || 0);
      li.appendChild(car); li.appendChild(bub);
      ul.appendChild(li);
    });
  }

  // Display label for a pair in reveal / game-over panels.
  // Format: "🔥 Team Name (Dennis & Brandi)" when name is set,
  //         "🔥 Dennis & Brandi" when not.
  function pairLabel(room, pr) {
    var icon = pr.icon || '🏎';
    var names = (room.players || [])
      .filter(function (p) { return pr.playerIds.indexOf(p.id) !== -1; })
      .map(function (p) { return p.name; }).join(' & ');
    if (pr.teamName) return icon + ' ' + pr.teamName + ' (' + names + ')';
    return icon + ' ' + names;
  }

  function renderCardFrame(room, card) {
    var t = $('card-theme'); if (t) t.textContent = String(themeLabel(card.theme) || '').toUpperCase();
    var ty = $('card-type-label');
    if (ty) {
      var labels = {
        mc4: uiT('playing.type_mc4') || '4 options',
        mc6: uiT('playing.type_mc6') || '6 options',
        group_vote: 'Point at a person',
        reflection: 'Reflection · no scoring',
        discussion: 'Group discussion · no scoring'
      };
      ty.textContent = labels[card.type] || '';
    }
    // Bonus banner appears on the card frame for any card with bonus:true,
    // so everyone at the table (Subject, Partner, spectators) knows the
    // points are doubled this round.
    var bb = $('card-bonus-banner'); if (bb) bb.hidden = !card.bonus;
    var h = $('card-subject-hint');
    if (h) {
      var partner = partnerNameInActivePair(room);
      var about = uiT('playing.about', { subject: subjectName(room) }) || ('About ' + subjectName(room));
      var clause = partner ? (' · ' + (uiT('playing.guesses_clause', { partner: partner }) || (partner + ' guesses'))) : '';
      h.textContent = about + clause;
    }
    var x = $('card-text');
    if (x) x.textContent = String(card.text || '').replace(/\[Subject\]/g, subjectName(room));
  }

  function partnerNameInActivePair(room) {
    var pr = (room.pairs || []).find(function (x) { return x.id === room.currentPairId; });
    if (!pr) return '';
    var partnerId = pr.playerIds.find(function (pid) { return pid !== room.currentSubjectId; });
    if (!partnerId) return '';
    var p = (room.players || []).find(function (x) { return x.id === partnerId; });
    return p ? p.name : '';
  }

  // Phase 5: only the Subject's Partner sees the guesser tiles.
  function renderPartnerGuesser(room, card, me) {
    var grid = $('answer-grid'); if (!grid) return;
    grid.innerHTML = '';
    var mine = (room.guesses && room.guesses[me]) || null;
    var locked = !!mine;
    var current = mine || pendingPick;

    if (card.type === 'mc4' || card.type === 'mc6' || card.type === 'tf') {
      letters(card).forEach(function (L) {
        var optText = (card.type === 'tf') ? tfLabel(L)
          : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
        var li = makeAnswerTile(L, optText, current === L);
        if (!locked) {
          li.setAttribute('data-action', 'pick-answer');
          li.setAttribute('data-value', L);
        }
        grid.appendChild(li);
      });
    } else if (card.type === 'group_vote') {
      (room.players || []).forEach(function (p) {
        if (p.id === me) return;
        var li = makeAnswerTile('', p.name, current === p.id);
        if (!locked) {
          li.setAttribute('data-action', 'pick-answer');
          li.setAttribute('data-value', p.id);
        }
        grid.appendChild(li);
      });
    }

    var btn = $('submit-guess-btn');
    if (btn) {
      btn.disabled = !pendingPick || locked;
      btn.textContent = locked
        ? (uiT('playing.guess_locked_btn') || 'Guess locked in')
        : (uiT('playing.lock_in_guess') || 'Lock In Guess');
    }
    var eyebrow = $('guesser-eyebrow');
    if (eyebrow) {
      eyebrow.textContent = card.type === 'group_vote'
        ? 'Who would ' + subjectName(room) + ' pick?'
        : (uiT('playing.guesser_eyebrow_mc', { subject: subjectName(room) }) || ('What did ' + subjectName(room) + ' pick?'));
    }
    var status = $('guesser-status');
    if (status) {
      status.textContent = locked
        ? (uiT('playing.guesser_status_locked', { subject: subjectName(room) }) || ('Guess locked in. Waiting on ' + subjectName(room) + ' to reveal.'))
        : '';
    }
  }

  function renderSubject(room, card) {
    var grid = $('truth-grid'); if (!grid) return;
    grid.innerHTML = '';
    var current = pendingPick;

    if (card.type === 'mc4' || card.type === 'mc6' || card.type === 'tf') {
      letters(card).forEach(function (L) {
        var optText = (card.type === 'tf') ? tfLabel(L)
          : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
        var li = makeAnswerTile(L, optText, current === L);
        li.setAttribute('data-action', 'pick-truth');
        li.setAttribute('data-value', L);
        grid.appendChild(li);
      });
    } else if (card.type === 'group_vote') {
      (room.players || []).forEach(function (p) {
        if (p.id === room.currentSubjectId) return;
        var li = makeAnswerTile('', p.name, current === p.id);
        li.setAttribute('data-action', 'pick-truth');
        li.setAttribute('data-value', p.id);
        grid.appendChild(li);
      });
      var li2 = makeAnswerTile('', 'Someone not at this table', current === 'NOT_AT_TABLE');
      li2.setAttribute('data-action', 'pick-truth');
      li2.setAttribute('data-value', 'NOT_AT_TABLE');
      grid.appendChild(li2);
    }

    var partner = partnerNameInActivePair(room);
    var partnerIn = !!room.partnerHasGuessed;

    var btn = $('reveal-btn');
    if (btn) {
      btn.disabled = !pendingPick || !partnerIn;
      btn.textContent = partnerIn
        ? (uiT('playing.reveal_the_truth') || 'Reveal The Truth')
        : (uiT('playing.reveal_waiting', { partner: partner || 'partner' }) || ('Waiting on ' + (partner || 'partner')));
    }
    var eyebrow = $('subject-eyebrow');
    if (eyebrow) eyebrow.textContent = uiT('playing.subject_eyebrow') || 'You\'re up. Pick what\'s actually true.';
    var status = $('subject-status');
    if (status) {
      if (!partnerIn) status.textContent = uiT('playing.subject_status_wait', { partner: partner || 'your partner' }) || ('Pick your truth in the meantime. You can reveal once ' + (partner || 'your partner') + ' has guessed.');
      else if (!pendingPick) status.textContent = uiT('playing.subject_status_pick') || 'Pick the truth, then reveal.';
      else status.textContent = '';
    }
  }

  function renderTalk(room, card, role) {
    var isSubject = role === 'subject';
    var partner = partnerNameInActivePair(room);
    var eyebrow = $('talk-eyebrow');
    if (eyebrow) eyebrow.textContent = card.type === 'discussion' ? 'Group discussion. No scoring.' : 'Reflection. No scoring.';
    var btn = $('done-talking-btn'); if (btn) btn.hidden = !isSubject;
    var status = $('talk-status');
    if (status) {
      if (isSubject) status.textContent = 'Take your time. Tap Done Sharing when you\'re ready.';
      else if (role === 'partner') status.textContent = subjectName(room) + ' is sharing. Listen up.';
      else status.textContent = subjectName(room) + ' and ' + (partner || 'partner') + ' are up. Listen in.';
    }
  }

  // Spectator: not in the active pair. Read-only view.
  function renderSpectator(room, card) {
    var eyebrow = $('spectator-eyebrow');
    var line = $('spectator-line');
    var status = $('spectator-status');
    var subject = subjectName(room);
    var partner = partnerNameInActivePair(room);
    var activePair = (room.pairs || []).find(function (pr) { return pr.id === room.currentPairId; });
    var icon = activePair && activePair.icon ? activePair.icon : '';
    var watchLabel = (icon ? icon + ' ' : '') + (activePair && activePair.teamName ? activePair.teamName : (subject + ' & ' + partner));
    if (eyebrow) eyebrow.textContent = uiT('playing.watching', { label: watchLabel }) || ('Watching · ' + watchLabel);
    if (line) {
      line.textContent = partner
        ? (uiT('playing.spectator_line', { subject: subject, partner: partner }) || (subject + ' is the subject. ' + partner + ' is guessing what ' + subject + ' picked.'))
        : (uiT('playing.spectator_line_nopartner', { subject: subject }) || (subject + ' is the subject. '));
    }

    // Read-only options grid: spectators can see the four options and play
    // along mentally. No data-action so tiles aren't tappable.
    var grid = $('spectator-options');
    if (grid) {
      grid.innerHTML = '';
      if (card.type === 'mc4' || card.type === 'mc6' || card.type === 'tf') {
        letters(card).forEach(function (L) {
          var optText = (card.type === 'tf') ? tfLabel(L)
            : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
          var li = makeAnswerTile(L, optText, false);
          li.classList.add('is-readonly');
          grid.appendChild(li);
        });
      } else if (card.type === 'group_vote') {
        (room.players || []).forEach(function (p) {
          if (p.id === room.currentSubjectId) return;
          var li = makeAnswerTile('', p.name, false);
          li.classList.add('is-readonly');
          grid.appendChild(li);
        });
      }
    }

    if (status) {
      status.textContent = room.partnerHasGuessed
        ? (uiT('playing.spectator_status_locked', { partner: partner || 'Partner', subject: subject }) || ((partner || 'Partner') + ' locked in. Waiting on ' + subject + ' to reveal.'))
        : (uiT('playing.spectator_status_waiting') || 'Waiting on the pair...');
    }
  }

  // Phase 5: reveal shows the truth, the Partner's single guess, the pair's
  // delta. Subject controls Next Card; everyone else just watches.
  function renderReveal(room, card, role) {
    var detail = room.lastReveal || {};
    var truth = detail.truth || room.subjectAnswer;
    var partnerId = detail.partnerId || null;
    var partner = partnerId
      ? ((room.players || []).find(function (p) { return p.id === partnerId; }) || { name: '' }).name
      : partnerNameInActivePair(room);

    var truthText = '';
    if (card.type === 'mc4' || card.type === 'mc6') {
      var opt = (card.options || []).find(function (o) { return o.letter === truth; });
      truthText = truth + '. ' + (opt ? interp(opt.text, room) : '');
    } else if (card.type === 'tf') {
      truthText = tfLabel(truth);
    } else if (card.type === 'group_vote') {
      truthText = playerNameById(room, truth);
    } else {
      truthText = '(no truth)';
    }
    var truthEl = $('reveal-truth'); if (truthEl) truthEl.textContent = truthText;

    var partnerLine = $('reveal-partner-line');
    if (partnerLine) {
      var isTalk = card.type === 'reflection' || card.type === 'discussion';
      if (isTalk) {
        partnerLine.textContent = '';
        partnerLine.className = 'reveal-partner-line';
      } else {
        var pg = detail.partnerGuess;
        var correct = !!detail.correct;
        var pgText = pickDisplay(card, pg, room);
        partnerLine.textContent = (uiT('playing.guessed_line', { partner: partner || 'Partner', pick: pgText }) || ((partner || 'Partner') + ' guessed: ' + pgText))
          + (correct ? '  ✓ ' : '  × ');
        partnerLine.className = 'reveal-partner-line ' + (correct ? 'guess-right' : 'guess-wrong');
      }
    }

    var ulS = $('reveal-scores');
    if (ulS) {
      ulS.innerHTML = '';
      var ba = detail.pairBeforeAfter || {};
      (room.pairs || []).forEach(function (pr) {
        var rec = ba[pr.id] || { before: pr.score || 0, delta: 0, after: pr.score || 0 };
        var li = document.createElement('li');
        li.className = 'pair-' + (pr.color || 'coral');
        var deltaStr = rec.delta > 0 ? ' (+' + rec.delta + ')' : '';
        li.innerHTML =
          '<span class="s-name">' + esc(pairLabel(room, pr)) + '</span>' +
          '<span class="s-score">' + rec.after + deltaStr + '</span>';
        ulS.appendChild(li);
      });
    }

    var isSubject = role === 'subject';

    // #88: the Explain step lives on Real + Deep only. Light is warm and easy and
    // most Light cards have no meaningful "why", so the Explain beat is dropped:
    // Light Subjects just see the scoreboard + recognition + a Next Card button.
    // Real + Deep keep #86's universal inline Explain exactly as before.
    var explainOn = room.depth !== 'light';

    var explainBox = $('reveal-explain');
    if (explainBox) {
      explainBox.hidden = !isSubject || !explainOn;
      if (isSubject && explainOn) {
        var eyb = $('reveal-explain-eyebrow');
        if (eyb) eyb.textContent = uiT('explain.inline_eyebrow', { subject: subjectName(room) }) || 'Your turn. Say why you picked that.';
        var inp = $('reveal-explain-input');
        if (inp && renderReveal._explainFor !== revealKey(room)) {
          inp.value = '';
          inp.placeholder = uiT('explain.inline_placeholder') || 'Because...';
        }
      }
    }
    renderReveal._explainFor = revealKey(room);

    var btn = $('next-card-btn');
    if (btn) {
      btn.hidden = !isSubject;
      btn.disabled = false;
      // Real/Deep advance through finish-explain (explicit Explain step). Light
      // skips Explain and advances straight through next-card.
      btn.setAttribute('data-action', explainOn ? 'finish-explain' : 'next-card');
      btn.textContent = room.winnerPairId
        ? (uiT('playing.final_results') || 'See Final Results →')
        : (room.pendingOvertime && room.pendingOvertime.length)
          ? (uiT('playing.to_overtime') || 'To Overtime →')
          : explainOn
            ? (uiT('explain.done_button') || 'Done. Next card. →')
            : (uiT('playing.next_card') || 'Next Card →');
    }
    var status = $('reveal-status');
    if (status) {
      status.textContent = isSubject ? ''
        : explainOn
          ? (uiT('playing.reveal_status_explain', { subject: subjectName(room) }) || ('Waiting on ' + subjectName(room) + ' to explain...'))
          : (uiT('playing.reveal_status_waiting', { subject: subjectName(room) }) || ('Waiting on ' + subjectName(room) + ' to advance...'));
    }

    maybeFireRecognition(room, detail);
  }

  // A reveal is unique per card + round + subject. Used to fire recognition and
  // reset the Explain input exactly once per reveal (the 2s poll re-renders).
  function revealKey(room) {
    return [room.currentCardId, room.round, room.currentSubjectId].join('|');
  }

  function renderGameOver(room) {
    var titleEl = $('game-over-title');
    var leadEl = $('game-over-lead');
    var ul = $('final-scores'); if (!ul) return;
    var me = load(K.playerId, null);
    var isHost = room.hostId === me;
    var rematchBtn = $('rematch-btn');
    if (rematchBtn) {
      rematchBtn.hidden = !isHost;
      rematchBtn.disabled = false;
      rematchBtn.textContent = uiT('game_over.rematch_button') || 'Rematch (Same Teams) →';
    }
    var note = $('game-over-host-note');
    if (note) note.hidden = isHost;
    ul.innerHTML = '';
    var winner = (room.pairs || []).find(function (pr) { return pr.id === room.winnerPairId; });
    if (winner) {
      var wn = winner.teamName
        || (room.players || [])
            .filter(function (p) { return winner.playerIds.indexOf(p.id) !== -1; })
            .map(function (p) { return p.name; }).join(' & ');
      if (titleEl) titleEl.textContent = uiT('game_over.winner_title') || ((winner.icon || '🏎') + ' ' + wn + ' Win');
      if (leadEl) {
        leadEl.textContent = room.wonInOvertime
          ? (uiT('game_over.won_overtime') || 'Won in overtime. Sudden death decided it.')
          : (uiT('game_over.lead', { n: (room.cap || 25) }) || ('First pair to ' + (room.cap || 25) + '. The race is run.'));
      }
    } else {
      if (titleEl) titleEl.textContent = uiT('game_over.title') || 'Game Over';
      if (leadEl) leadEl.textContent = '';
    }
    var sorted = (room.pairs || []).slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    sorted.forEach(function (pr) {
      var li = document.createElement('li');
      li.className = 'pair-' + (pr.color || 'coral') + (pr.id === room.winnerPairId ? ' is-winner' : '');
      li.innerHTML = '<span class="s-name">' + esc(pairLabel(room, pr)) + '</span><span class="s-score">' + (pr.score || 0) + '</span>';
      ul.appendChild(li);
    });

    // Fix 5: bigger celebration the first time we land on this game-over.
    if (winner) fireCelebration();
  }

  // ============================================================
  //   Overtime (sudden death) rendering, Fix 3 UI
  //   Reuses the screen-playing sub-views. Every tied team answers
  //   the SAME card at once: each Subject locks a truth, each Partner
  //   predicts it, then a combined reveal.
  // ============================================================
  function otPickText(card, val, room) {
    if (val == null) return '';
    return pickDisplay(card, val, room);
  }
  function otSubjectNameForPartner(room, me) {
    var ot = room.ot || {};
    var name = '';
    Object.keys(ot).forEach(function (pid) {
      if (ot[pid].partnerId === me) name = playerNameById(room, ot[pid].subjectId);
    });
    return name || 'your subject';
  }
  function setOvertimeBanner(room) {
    var ob = $('overtime-banner'); if (ob) ob.hidden = false;
    var rl = $('overtime-round');
    if (rl) rl.textContent = (uiT('overtime.round_label') || 'Sudden death') + ' · ' + (uiT('overtime.round_word') || 'Round') + ' ' + (room.otRound || 1);
  }

  function renderOvertime(room) {
    if (!CARDS_DATA) {
      loadCardsOnce().then(function () { if (lastRoom) renderOvertime(lastRoom); }).catch(function () {});
      return;
    }
    gameOverCelebrated = false;
    var me = load(K.playerId, null);
    var card = CARD_BY_ID[room.currentCardId];
    if (!card) return;

    var otKey = room.currentCardId + '|' + (room.otRound || 1) + '|' + room.subPhase;
    if (renderOvertime._lastKey !== otKey) { pendingPick = null; renderOvertime._lastKey = otKey; }

    renderRace(room);
    renderCardFrame(room, card);
    setOvertimeBanner(room);
    hideElems(['guesser-view','subject-view','talk-view','spectator-view','reveal-view']);

    var ot = room.ot || {};
    var myRole = 'spectator', mySlot = null;
    Object.keys(ot).forEach(function (pid) {
      var s = ot[pid];
      if (s.subjectId === me) { myRole = 'subject'; mySlot = s; }
      else if (s.partnerId === me) { myRole = 'partner'; mySlot = s; }
    });

    if (room.subPhase === 'reveal') {
      renderOvertimeReveal(room, card, myRole);
      showElem('reveal-view');
      return;
    }
    if (myRole === 'subject') {
      if (mySlot && (mySlot.truthIn || mySlot.truth != null)) { renderOvertimeWaiting(room); showElem('spectator-view'); }
      else { renderOvertimeSubject(room, card); showElem('subject-view'); }
    } else if (myRole === 'partner') {
      if (mySlot && (mySlot.guessIn || mySlot.guess != null)) { renderOvertimeWaiting(room); showElem('spectator-view'); }
      else { renderOvertimePartner(room, card, me); showElem('guesser-view'); }
    } else {
      renderOvertimeSpectator(room, card); showElem('spectator-view');
    }
  }

  function renderOvertimeSubject(room, card) {
    var grid = $('truth-grid'); if (!grid) return;
    grid.innerHTML = '';
    letters(card).forEach(function (L) {
      var optText = (card.type === 'tf') ? tfLabel(L) : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
      var li = makeAnswerTile(L, optText, pendingPick === L);
      li.setAttribute('data-action', 'pick-truth');
      li.setAttribute('data-value', L);
      grid.appendChild(li);
    });
    var btn = $('reveal-btn');
    if (btn) { btn.disabled = !pendingPick; btn.textContent = uiT('overtime.lock_answer') || 'Lock In Your Answer'; }
    var eyebrow = $('subject-eyebrow'); if (eyebrow) eyebrow.textContent = uiT('overtime.subject_eyebrow') || 'Sudden death. Pick what is true for you.';
    var status = $('subject-status'); if (status) status.textContent = uiT('overtime.subject_status') || 'Your partner is predicting your answer. Lock it in.';
  }

  function renderOvertimePartner(room, card, me) {
    var grid = $('answer-grid'); if (!grid) return;
    grid.innerHTML = '';
    letters(card).forEach(function (L) {
      var optText = (card.type === 'tf') ? tfLabel(L) : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
      var li = makeAnswerTile(L, optText, pendingPick === L);
      li.setAttribute('data-action', 'pick-answer');
      li.setAttribute('data-value', L);
      grid.appendChild(li);
    });
    var btn = $('submit-guess-btn');
    if (btn) { btn.disabled = !pendingPick; btn.textContent = uiT('overtime.lock_guess') || 'Lock In Prediction'; }
    var subjName = otSubjectNameForPartner(room, me);
    var eyebrow = $('guesser-eyebrow'); if (eyebrow) eyebrow.textContent = uiT('overtime.partner_eyebrow', { subject: subjName }) || ('What did ' + subjName + ' pick?');
    var status = $('guesser-status'); if (status) status.textContent = '';
  }

  function renderOvertimeWaiting(room) {
    var eyebrow = $('spectator-eyebrow'); if (eyebrow) eyebrow.textContent = uiT('overtime.eyebrow') || 'Overtime';
    var line = $('spectator-line'); if (line) line.textContent = uiT('overtime.locked_waiting') || 'Locked in. Waiting on the other players to answer...';
    var grid = $('spectator-options'); if (grid) grid.innerHTML = '';
    var status = $('spectator-status'); if (status) status.textContent = '';
  }

  function renderOvertimeSpectator(room, card) {
    var eyebrow = $('spectator-eyebrow'); if (eyebrow) eyebrow.textContent = uiT('overtime.eyebrow') || 'Overtime';
    var line = $('spectator-line'); if (line) line.textContent = uiT('overtime.spectator_line') || 'Sudden death. The tied teams are answering the same card.';
    var grid = $('spectator-options');
    if (grid) {
      grid.innerHTML = '';
      letters(card).forEach(function (L) {
        var optText = (card.type === 'tf') ? tfLabel(L) : interp(((card.options || []).find(function (o) { return o.letter === L; }) || {}).text || '', room);
        var li = makeAnswerTile(L, optText, false); li.classList.add('is-readonly'); grid.appendChild(li);
      });
    }
    var status = $('spectator-status'); if (status) status.textContent = '';
  }

  function renderOvertimeReveal(room, card, myRole) {
    var explainBox = $('reveal-explain'); if (explainBox) explainBox.hidden = true;
    var truthEl = $('reveal-truth'); if (truthEl) truthEl.textContent = uiT('overtime.reveal_title') || 'Overtime results';
    var pl = $('reveal-partner-line'); if (pl) { pl.textContent = ''; pl.className = 'reveal-partner-line'; }
    var ul = $('reveal-scores');
    if (ul) {
      ul.innerHTML = '';
      (room.otTeams || []).forEach(function (pid) {
        var pr = (room.pairs || []).find(function (p) { return p.id === pid; });
        var rev = (room.otReveal || {})[pid] || {};
        var correct = !!rev.correct;
        var li = document.createElement('li');
        li.className = 'pair-' + ((pr && pr.color) || 'coral') + (correct ? ' guess-right' : ' guess-wrong');
        var detailLine = (uiT('overtime.team_truth') || 'picked') + ' ' + esc(otPickText(card, rev.truth, room));
        li.innerHTML =
          '<span class="s-name">' + esc(pr ? pairLabel(room, pr) : '') + '<br><small>' + detailLine + '</small></span>' +
          '<span class="s-score">' + (correct ? '✓' : '×') + '</span>';
        ul.appendChild(li);
      });
    }
    var scorers = (room.otTeams || []).filter(function (pid) { return (room.otReveal || {})[pid] && room.otReveal[pid].correct; });
    var decided = scorers.length === 1;
    var isOtSubject = myRole === 'subject';
    var btn = $('next-card-btn');
    if (btn) {
      btn.hidden = !isOtSubject;
      btn.disabled = false;
      btn.setAttribute('data-action', 'next-card');
      btn.textContent = decided ? (uiT('overtime.see_winner') || 'See Who Won →') : (uiT('overtime.next_card') || 'Next Overtime Card →');
    }
    var status = $('reveal-status');
    if (status) status.textContent = isOtSubject ? '' : (uiT('overtime.reveal_waiting') || 'Waiting on a subject to advance...');
  }

  // ============================================================
  //   Recognition (Fix 4) + win celebration (Fix 5)
  //   Web Audio tones (no audio file) + CSS-animated confetti.
  //   prefers-reduced-motion skips the confetti, keeps the audio.
  // ============================================================
  var gameOverCelebrated = false;
  function reduceMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  var _audioCtx = null;
  function audioCtx() {
    if (_audioCtx) return _audioCtx;
    try { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; _audioCtx = new AC(); } catch (e) { return null; }
    return _audioCtx;
  }
  function resumeAudio() { var c = audioCtx(); if (c && c.state === 'suspended') { c.resume().catch(function () {}); } }
  function tone(ctx, freq, startT, dur, type, peak) {
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type || 'sine'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, startT);
    g.gain.exponentialRampToValueAtTime(peak || 0.16, startT + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(startT); osc.stop(startT + dur + 0.03);
  }
  function playChime() {
    var ctx = audioCtx(); if (!ctx) return; resumeAudio();
    var t = ctx.currentTime;
    tone(ctx, 988, t, 0.18, 'sine', 0.15);        // B5
    tone(ctx, 1318.5, t + 0.10, 0.30, 'sine', 0.15); // E6
  }
  function playFanfare() {
    var ctx = audioCtx(); if (!ctx) return; resumeAudio();
    var t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) { tone(ctx, f, t + i * 0.16, 0.45, 'triangle', 0.15); }); // C5 E5 G5 C6
    [523.25, 659.25, 783.99].forEach(function (f) { tone(ctx, f, t + 0.62, 0.95, 'sine', 0.10); });                   // sustained chord
  }

  var CONFETTI_COLORS = ['coral', 'sun', 'sky', 'pink', 'teal'];
  function recognitionBurst(pairId) {
    if (reduceMotion()) return;
    var track = $('race-track'); if (!track) return;
    var car = pairId ? track.querySelector('.race-car[data-pair="' + pairId + '"]') : null;
    var host = car || track;
    var burst = document.createElement('div'); burst.className = 'recog-burst';
    for (var i = 0; i < 5; i++) {
      var d = document.createElement('span');
      d.className = 'recog-dot rd' + (i + 1) + ' dot-' + CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      burst.appendChild(d);
    }
    host.appendChild(burst);
    setTimeout(function () { if (burst.parentNode) burst.parentNode.removeChild(burst); }, 700);
  }
  function maybeFireRecognition(room, detail) {
    if (!detail || !detail.correct) return;
    var key = revealKey(room);
    if (maybeFireRecognition._last === key) return;
    maybeFireRecognition._last = key;
    var ba = detail.pairBeforeAfter || {}, scoredPair = null;
    Object.keys(ba).forEach(function (pid) { if ((ba[pid].delta || 0) > 0) scoredPair = pid; });
    recognitionBurst(scoredPair);
    playChime();
  }

  function celebrationBurst() {
    if (reduceMotion()) return;
    var hostEl = $('screen-game-over'); if (!hostEl) return;
    var wrap = document.createElement('div'); wrap.className = 'celebrate'; wrap.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 26; i++) {
      var d = document.createElement('span');
      d.className = 'celebrate-dot dot-' + CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      d.style.left = ((i * 37 + 11) % 100) + '%';
      d.style.animationDelay = ((i % 7) * 0.12).toFixed(2) + 's';
      d.style.setProperty('--drift', (((i * 53) % 40) - 20) + 'px');
      wrap.appendChild(d);
    }
    hostEl.appendChild(wrap);
    setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 2800);
  }
  function fireCelebration() {
    if (gameOverCelebrated) return;
    gameOverCelebrated = true;
    celebrationBurst();
    playFanfare();
  }

  // ---------- Phase 3 action handlers ----------
  function pickAnswer(value) { pendingPick = value; renderRoom(lastRoom); }
  function pickTruth(value) { pendingPick = value; renderRoom(lastRoom); }

  async function submitGuessAct() {
    if (!pendingPick) return;
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var guess = pendingPick;
    var btn = $('submit-guess-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('playing.locking_in') || 'Locking in...'; }
    try {
      var r = await api('/api/friend-submit-guess', { method: 'POST', body: { code: code, playerId: pid, guess: guess } });
      if (r.status === 200 && r.body && r.body.ok) {
        pendingPick = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not submit guess: ' + msg);
        renderRoom(lastRoom);
      }
    } catch (e) {
      alert('Network error submitting guess.');
      renderRoom(lastRoom);
    }
  }

  async function revealTruthAct() {
    if (!pendingPick) return;
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var truth = pendingPick;
    var btn = $('reveal-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('playing.revealing') || 'Revealing...'; }
    try {
      var r = await api('/api/friend-submit-truth', { method: 'POST', body: { code: code, playerId: pid, truth: truth } });
      if (r.status === 200 && r.body && r.body.ok) {
        pendingPick = null;
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        if (msg === 'waiting_for_guessers') {
          var on = (r.body && r.body.waitingOn) || [];
          alert('Still waiting on: ' + on.join(', '));
        } else {
          alert('Could not reveal: ' + msg);
        }
        renderRoom(lastRoom);
      }
    } catch (e) {
      alert('Network error revealing truth.');
      renderRoom(lastRoom);
    }
  }

  async function hostRematchAct() {
    var btn = $('rematch-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('game_over.starting_rematch') || 'Starting rematch...'; }
    try {
      var r = await api('/api/friend-rematch', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') },
      });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        alert('Could not start rematch: ' + ((r.body && r.body.error) || 'unknown'));
        if (btn) { btn.disabled = false; btn.textContent = uiT('game_over.rematch_button') || 'Rematch (Same Teams) →'; }
      }
    } catch (e) {
      alert('Network error starting rematch.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('game_over.rematch_button') || 'Rematch (Same Teams) →'; }
    }
  }

  async function nextCardAct() {
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var btn = $('next-card-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('playing.advancing') || 'Advancing...'; }
    var dbtn = $('done-talking-btn'); if (dbtn) { dbtn.disabled = true; dbtn.textContent = uiT('playing.advancing') || 'Advancing...'; }
    try {
      var r = await api('/api/friend-next-card', { method: 'POST', body: { code: code, playerId: pid } });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not advance: ' + msg);
        if (btn) { btn.disabled = false; btn.textContent = uiT('playing.next_card') || 'Next Card →'; }
        if (dbtn) { dbtn.disabled = false; dbtn.textContent = uiT('playing.done_sharing') || 'Done Sharing'; }
      }
    } catch (e) {
      alert('Network error advancing.');
      if (btn) { btn.disabled = false; btn.textContent = 'Next Card →'; }
      if (dbtn) { dbtn.disabled = false; dbtn.textContent = 'Done Sharing'; }
    }
  }

  // Subject taps "Done. Next card." on a Choice+Explain card's EXPLAIN panel.
  async function finishExplainAct() {
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var cardId = lastRoom && lastRoom.currentCardId;
    var btn = $('explain-done-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('explain.advancing') || 'Advancing...'; }
    try {
      var r = await api('/api/friend-finish-explain', { method: 'POST', body: { code: code, playerId: pid, cardId: cardId } });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not advance: ' + msg);
        if (btn) { btn.disabled = false; btn.textContent = uiT('explain.done_button') || 'Done. Next card. →'; }
      }
    } catch (e) {
      alert('Network error advancing.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('explain.done_button') || 'Done. Next card. →'; }
    }
  }

  // Local-only state: when the host taps a first player, we remember it
  // so the next tap can complete the pair. Stays in memory; not synced.
  var selectedForPair = null;

  // Render the pairing screen for the current viewer.
  // Host can tap tiles to pair/unpair. Guests see the same grid read-only.
  function renderPairing(room) {
    var me = load(K.playerId, null);
    var isHost = room.hostId === me;
    var players = room.players || [];
    var pairs = room.pairs || [];

    // Build a quick lookup: playerId -> { pairIndex, color }
    var pairIndex = {};
    pairs.forEach(function (pr, idx) {
      pr.playerIds.forEach(function (pid) {
        pairIndex[pid] = { idx: idx, color: pr.color || 'coral' };
      });
    });

    var grid = $('players-grid');
    if (grid) {
      grid.innerHTML = '';
      players.forEach(function (p) {
        var li = document.createElement('li');
        var info = pairIndex[p.id];
        var classes = [];
        if (info) {
          classes.push('paired');
          classes.push('pair-' + info.color);
        }
        if (selectedForPair === p.id) classes.push('is-selected');
        if (!isHost) classes.push('read-only');
        if (classes.length) li.className = classes.join(' ');
        // Host tiles dispatch the pair-toggle action; guest tiles do nothing.
        if (isHost) {
          li.setAttribute('data-action', 'host-toggle-pair');
          li.setAttribute('data-target', p.id);
        }
        var name = document.createElement('span');
        name.className = 'grid-name';
        name.textContent = p.name;
        li.appendChild(name);
        if (p.id === room.hostId) {
          var role = document.createElement('span');
          role.className = 'grid-role';
          role.textContent = p.id === me ? 'Host · You' : 'Host';
          li.appendChild(role);
        } else if (p.id === me) {
          var youTag = document.createElement('span');
          youTag.className = 'grid-role';
          youTag.textContent = 'You';
          li.appendChild(youTag);
        }
        grid.appendChild(li);
      });
    }

    // Status line: paired count + (host) instruction hint
    var status = $('pairing-status');
    if (status) {
      var totalPlayers = players.length;
      var pairedCount = pairs.length * 2;
      status.textContent = pairedCount + ' of ' + totalPlayers + ' players paired';
    }

    // Host gets the Start the Game button once everyone is paired.
    // Guests see a note that the host is doing the pairing.
    var startBtn = $('start-game-btn');
    var startNote = $('pairing-host-note');
    if (startBtn) {
      startBtn.hidden = !isHost;
      startBtn.disabled = (pairs.length * 2) !== players.length;
    }
    if (startNote) startNote.hidden = isHost;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function clearLocalState() {
    clear(K.code); clear(K.playerId); clear(K.isHost);
    // Keep K.name so re-joining is one tap.
    lastRoom = null;
  }

  // ----- QR rendering for the host's lobby -----
  function buildJoinUrl(code) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return base + '?join=' + encodeURIComponent(code);
  }
  function renderQR(code) {
    var box = $('lobby-qr');
    if (!box) return;
    box.innerHTML = '';
    if (typeof QRCode !== 'function') {
      box.textContent = code;
      return;
    }
    new QRCode(box, {
      text: buildJoinUrl(code),
      width: 168, height: 168,
      colorDark: '#08111f', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  // ----- actions -----
  function showErr(elId, msg) { var el = $(elId); if (el) { el.textContent = msg; el.hidden = false; } }
  function hideErr(elId) { var el = $(elId); if (el) el.hidden = true; }

  async function hostCreate() {
    hideErr('host-name-err');
    var name = String(($('host-name').value || '')).trim();
    if (!name) { showErr('host-name-err', 'Pick a name first.'); return; }
    var gender = load(K.gender, null);
    if (gender !== 'male' && gender !== 'female') { showErr('host-name-err', 'Pick Male or Female to continue.'); return; }
    save(K.name, name);
    var btn = $('host-create-btn') || document.querySelector('[data-action="host-create"]');
    if (btn) { btn.disabled = true; btn.textContent = uiT('host_setup.creating') || 'Creating...'; }
    try {
      var r = await api('/api/friend-create-room', { method: 'POST', body: { hostName: name, gender: gender } });
      if (r.status === 200 && r.body && r.body.ok) {
        save(K.code, r.body.code);
        save(K.playerId, r.body.hostId);
        save(K.isHost, true);
        renderQR(r.body.code);
        startPolling();
        // First-timers get the walkthrough before the lobby; returners go straight in.
        if (load(K.onboarded, false)) show('screen-lobby');
        else startOnboarding(false);
      } else {
        showErr('host-name-err', 'Could not create the room. Try again in a moment.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = uiT('host_setup.submit') || 'Create Room'; }
    }
  }

  async function joinGo() {
    hideErr('join-err');
    var code = String(($('join-code').value || '')).trim().toUpperCase();
    var name = String(($('join-name').value || '')).trim();
    if (!code || code.length < 4) { showErr('join-err', 'Enter the 4-letter room code from your host.'); return; }
    if (!name) { showErr('join-err', 'Add your name so the table knows who joined.'); return; }
    var gender = load(K.gender, null);
    if (gender !== 'male' && gender !== 'female') { showErr('join-err', 'Pick Male or Female to continue.'); return; }
    save(K.name, name);
    var btn = $('join-go-btn') || document.querySelector('[data-action="join-go"]');
    if (btn) { btn.disabled = true; btn.textContent = uiT('join_setup.joining') || 'Joining...'; }
    try {
      var r = await api('/api/friend-join-room', { method: 'POST', body: { code: code, name: name, gender: gender } });
      if (r.status === 200 && r.body && r.body.ok) {
        save(K.code, r.body.room.code);
        save(K.playerId, r.body.playerId);
        save(K.isHost, false);
        renderQR(r.body.room.code);
        startPolling();
        // First-timers get the walkthrough before the lobby; returners go straight in.
        if (load(K.onboarded, false)) show('screen-lobby');
        else startOnboarding(false);
      } else {
        var msg = 'Could not join the room.';
        if (r.body && r.body.error === 'room_not_found') msg = 'No room with that code. Check the letters and try again.';
        if (r.body && r.body.error === 'game_already_started') msg = 'That game already started. Ask your host to start a new one.';
        if (r.body && r.body.error === 'room_full') msg = 'That room is full (10 players max).';
        if (r.body && r.body.error === 'name_required') msg = 'Add your name first.';
        showErr('join-err', msg);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = uiT('join_setup.submit') || 'Join Room'; }
    }
  }

  function leaveRoom() {
    // Confirm only when there's an actual game in flight, so accidental taps
    // mid-card don't wipe state. Lobby/game-over Leaves stay one-tap.
    var phase = lastRoom && lastRoom.phase;
    var midGame = phase === 'pairing' || phase === 'teamSetup'
      || phase === 'playing' || phase === 'roundEnd';
    if (midGame && !confirm('Leave this game and go back to the start?')) return;
    clearLocalState();
    stopPolling();
    show('screen-router');
  }

  // Gender select: persist the choice, light up the chosen tile, and enable
  // the create/join submit (required selection per spec).
  function setGenderAct(el) {
    var g = el && el.getAttribute('data-gender');
    if (g !== 'male' && g !== 'female') return;
    save(K.gender, g);
    refreshGenderUI();
  }
  function refreshGenderUI() {
    var g = load(K.gender, null);
    var valid = (g === 'male' || g === 'female');
    ['host-gender', 'join-gender'].forEach(function (id) {
      var box = $(id);
      if (!box) return;
      [].slice.call(box.querySelectorAll('.gender-tile')).forEach(function (t) {
        var sel = t.getAttribute('data-gender') === g;
        t.classList.toggle('btn-primary', sel);
        t.classList.toggle('btn-ghost', !sel);
      });
    });
    var hc = $('host-create-btn'); if (hc) hc.disabled = !valid;
    var jg = $('join-go-btn'); if (jg) jg.disabled = !valid;
  }

  function gotoHostSetup() {
    var n = load(K.name, '');
    if (n) $('host-name').value = n;
    refreshGenderUI();
    show('screen-host-setup');
  }
  function gotoJoinSetup() {
    var params = new URLSearchParams(location.search);
    var preCode = (params.get('join') || '').toUpperCase();
    if (preCode) $('join-code').value = preCode;
    var n = load(K.name, '');
    if (n) $('join-name').value = n;
    refreshGenderUI();
    show('screen-join-setup');
  }
  function backRouter() { show('screen-router'); }

  // Host taps the × on a non-host player row to drop them from the lobby.
  async function hostRemove(targetId, targetName) {
    if (!targetId) return;
    if (!confirm('Remove ' + (targetName || 'this player') + ' from the lobby?')) return;
    var code = load(K.code, null);
    var hostId = load(K.playerId, null);
    if (!code || !hostId) return;
    try {
      var r = await api('/api/friend-remove-player', {
        method: 'POST',
        body: { code: code, hostId: hostId, targetPlayerId: targetId }
      });
      if (r.status === 200 && r.body && r.body.ok) {
        // Re-render immediately from the response so we don't wait for the poll.
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not remove player: ' + msg);
      }
    } catch (err) {
      alert('Network error removing player. Try again.');
    }
  }

  // Host taps Pair Up. Calls the backend to transition lobby -> pairing.
  // All other devices pick up the new phase via their 2-second poll.
  async function hostStart() {
    var btn = $('start-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('lobby.pairing') || 'Pairing...'; }
    try {
      var r = await api('/api/friend-start-pairing', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') }
      });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        if (msg === 'odd_player_count') msg = 'The game needs an even number of players. Remove or add one.';
        if (msg === 'too_few_players') msg = 'Need at least 4 players to start.';
        alert('Could not start pairing: ' + msg);
        if (btn) { btn.disabled = false; btn.textContent = uiT('lobby.start_button') || 'Pair Up →'; }
      }
    } catch (err) {
      alert('Network error. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('lobby.start_button') || 'Pair Up →'; }
    }
  }

  // Host taps a player tile. Three behaviors:
  //   1. If that player is currently in a pair → unpair them (and partner).
  //   2. Else if no one is selected yet → make this player the "selected" one.
  //   3. Else if a different player is selected → pair them together.
  //   4. Else if the SAME player is selected → deselect.
  async function hostTogglePair(targetId) {
    if (!targetId) return;
    var code = load(K.code, '');
    var hostId = load(K.playerId, '');
    if (!code || !hostId || !lastRoom) return;

    var pairs = lastRoom.pairs || [];
    var inPair = pairs.find(function (pr) { return pr.playerIds.indexOf(targetId) !== -1; });

    if (inPair) {
      // Unpair the target (and their partner) and clear any selection.
      selectedForPair = null;
      try {
        var r = await api('/api/friend-unpair-player', {
          method: 'POST',
          body: { code: code, hostId: hostId, playerId: targetId }
        });
        if (r.status === 200 && r.body && r.body.ok) {
          lastRoom = r.body.room;
          renderRoom(lastRoom);
        }
      } catch (err) {}
      return;
    }

    if (selectedForPair === targetId) {
      // Tapped the already-selected player → deselect.
      selectedForPair = null;
      renderPairing(lastRoom);
      return;
    }

    if (!selectedForPair) {
      // First tap → mark as selected.
      selectedForPair = targetId;
      renderPairing(lastRoom);
      return;
    }

    // Second tap on a different unpaired player → pair them with the first.
    var firstId = selectedForPair;
    selectedForPair = null;
    try {
      var r2 = await api('/api/friend-pair-players', {
        method: 'POST',
        body: { code: code, hostId: hostId, playerIdA: firstId, playerIdB: targetId }
      });
      if (r2.status === 200 && r2.body && r2.body.ok) {
        lastRoom = r2.body.room;
        renderRoom(lastRoom);
      } else {
        // Show the room state as-is so the selected indicator clears.
        renderPairing(lastRoom);
      }
    } catch (err) {
      renderPairing(lastRoom);
    }
  }

  // Host taps Start the Game after everyone is paired.
  async function hostStartGame() {
    var btn = $('start-game-btn'); if (btn) { btn.disabled = true; btn.textContent = uiT('team_setup.starting') || 'Starting...'; }
    try {
      var r = await api('/api/friend-start-game', {
        method: 'POST',
        body: { code: load(K.code, ''), hostId: load(K.playerId, '') }
      });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not start game: ' + msg);
        if (btn) { btn.disabled = false; btn.textContent = uiT('team_setup.start_button') || 'Start the Game'; }
      }
    } catch (err) {
      alert('Network error. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = uiT('team_setup.start_button') || 'Start the Game'; }
    }
  }

  // ----- wire -----
  // ============================================================
  //   Onboarding walkthrough (5 screens, first time only)
  // ============================================================
  // EN copy lives here; the Spanish equivalents live in the deck's ui.onboarding
  // block (cards.es.json) and are picked up by onbStep() when the ES deck loads.
  var ONBOARDING = [
    {
      cover: true,
      title: 'Welcome to You Call Yourself A Friend',
      paragraphs: [
        'You picked up this game because you wanted to find out who actually knows you, and who only thinks they do.',
        'This is a quick walkthrough. Five screens. About 60 seconds. Then you are playing.'
      ]
    },
    {
      title: 'How a Round Works',
      paragraphs: [
        'Each round, one player is the Subject. The card asks a question about them.',
        'The Subject picks the answer that is true for them on their phone. Their honest answer.',
        'At the same time, their partner picks what they THINK the Subject picked, on their own phone. The partner is predicting, not picking for themselves.',
        'The answer is revealed. If the partner predicted right, the team scores. Then the Subject explains why they picked it. Next round, a new Subject takes the card.'
      ]
    },
    {
      title: 'Pair Up. Race the Finish.',
      paragraphs: [
        'Before play, the host pairs everyone into teams of two. Turns alternate strictly between the teams, one Subject from each team per rotation.',
        'First team to 25 points wins. If the other team is one rotation away from tying when you hit 25, they get the chance to tie. If they tie, the game goes to sudden death.'
      ]
    },
    {
      title: 'Pick Your Depth',
      paragraphs: [
        'Light reads how well people know your favorites, your defaults, your daily life. Warm and easy.',
        'Real reads deeper, your character, your strengths, your friendship style. Bonus cards score double here.',
        'Deep reads the hardest. Questions about the people you keep close, the choices you would make, what you really believe. This depth includes a short Explain step where the subject says why their answer is what it is.'
      ]
    },
    {
      title: 'You Are Ready',
      paragraphs: [
        'Tap Open the Game to start. The host creates the room, the others join with the code or QR.',
        'If you forget how anything works, the menu in the top corner has How to Play at any time.'
      ]
    }
  ];
  var onbIndex = 0;
  var onbFromMenu = false;

  // Returns the step's display data, preferring the Spanish ui.onboarding.steps
  // when the ES deck is loaded, else the EN ONBOARDING entry. Cover flag always
  // comes from the EN array (structure is identical across languages).
  function onbStep(i) {
    var en = ONBOARDING[i];
    var es = DECK_UI && DECK_UI.onboarding && DECK_UI.onboarding.steps && DECK_UI.onboarding.steps[i];
    if (es) return { cover: en.cover, title: es.title || en.title, paragraphs: es.paragraphs || en.paragraphs };
    return en;
  }
  function onbLabel(key, fallback) { return uiT('onboarding.' + key) || fallback; }

  function renderOnboardingStep() {
    var step = onbStep(onbIndex);
    var last = (onbIndex === ONBOARDING.length - 1);
    $('onb-step-num').textContent = (onbIndex + 1) + ' ' + onbLabel('of', 'of') + ' ' + ONBOARDING.length;
    $('onb-title').textContent = step.title;
    var cover = $('onb-cover'), orn = $('onb-orn');
    if (cover) cover.hidden = !step.cover;
    if (orn) orn.hidden = !!step.cover;
    $('onb-body').innerHTML = step.paragraphs.map(function (p) { return '<p>' + p + '</p>'; }).join('');
    var back = document.querySelector('.onb-back');
    if (back) { back.hidden = (onbIndex === 0); back.textContent = onbLabel('back', 'Back'); }
    $('onb-next-btn').textContent = last ? onbLabel('open_game', 'Open the Game') : onbLabel('continue', 'Continue');
  }
  // fromMenu = true means it was re-opened from the help drawer; on finish we
  // return to wherever the player was instead of advancing into the lobby, and
  // we do not touch the onboarded flag.
  function startOnboarding(fromMenu) {
    onbFromMenu = !!fromMenu;
    onbIndex = 0;
    routeLock = true;
    renderOnboardingStep();
    show('screen-onboarding');
  }
  function onbAdvance() {
    if (onbIndex < ONBOARDING.length - 1) { onbIndex += 1; renderOnboardingStep(); return; }
    finishOnboarding();
  }
  function onbBack() { if (onbIndex > 0) { onbIndex -= 1; renderOnboardingStep(); } }
  function finishOnboarding() {
    if (!onbFromMenu) save(K.onboarded, true);
    routeLock = false;
    if (lastRoom) {
      // renderRoom switches screens for active phases (pairing/playing/etc.) but
      // only updates the DOM for the lobby phase, so land on the lobby explicitly.
      var ph = lastRoom.phase;
      if (!ph || ph === 'lobby') show('screen-lobby');
      renderRoom(lastRoom);
    } else {
      show(onbFromMenu ? 'screen-router' : 'screen-lobby');
    }
  }

  // ----- help drawer + about modal -----
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
  // Open the language picker from the drawer. Lock routing so the poll does not
  // pull the player back into the game before they pick (picking reloads).
  function openLanguageFromMenu() {
    routeLock = true;
    show('screen-language');
  }

  function wire() {
    document.body.addEventListener('click', function (e) {
      // Unlock/resume the Web Audio context on the first real tap so the
      // recognition chime and win fanfare can play later (Fix 4 + Fix 5).
      resumeAudio();
      // Tap-out on a backdrop closes it. Checked by exact id (not closest) so a
      // tap on the drawer/modal content itself never bubbles up to a close.
      if (e.target.id === 'drawer-backdrop') { closeMenu(); return; }
      if (e.target.id === 'about-backdrop') { closeAbout(); return; }
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var a = el.getAttribute('data-action');
      // Help menu + onboarding actions
      if (a === 'open-menu')       return openMenu();
      if (a === 'close-menu')      return closeMenu();
      if (a === 'how-to-play')     { closeMenu(); return startOnboarding(true); }
      if (a === 'drawer-home')     { closeMenu(); return leaveRoom(); }
      if (a === 'drawer-language') { closeMenu(); return openLanguageFromMenu(); }
      if (a === 'drawer-about')    { closeMenu(); return openAbout(); }
      if (a === 'close-about')     return closeAbout();
      if (a === 'onb-next')        return onbAdvance();
      if (a === 'onb-back')        return onbBack();
      if (a === 'lang-en')      return setLangAct('en');
      if (a === 'lang-es')      return setLangAct('es');
      if (a === 'goto-host')    return gotoHostSetup();
      if (a === 'goto-join')    return gotoJoinSetup();
      if (a === 'back-router')  return backRouter();
      if (a === 'set-gender')   return setGenderAct(el);
      if (a === 'host-create')  return hostCreate();
      if (a === 'join-go')      return joinGo();
      if (a === 'leave-room')   return leaveRoom();
      if (a === 'host-start')   return hostStart();
      if (a === 'host-remove')  return hostRemove(el.getAttribute('data-target'), el.getAttribute('data-name'));
      if (a === 'host-toggle-pair') return hostTogglePair(el.getAttribute('data-target'));
      if (a === 'host-start-game') return hostStartGame();
      // Phase 4: team setup actions
      if (a === 'host-start-team-setup')   return hostStartTeamSetupAct();
      if (a === 'host-open-team-row')      return hostOpenTeamRow(el.getAttribute('data-target'));
      if (a === 'host-pick-team-icon')     return hostPickTeamIcon(el.getAttribute('data-pair'), el.getAttribute('data-icon'));
      if (a === 'host-advance-to-confirm') return hostAdvanceToConfirmAct();
      if (a === 'host-back-to-picking-icons') return hostBackToIconsAct();
      if (a === 'host-save-team-name')     return hostSaveTeamNameAct(el.getAttribute('data-pair'));
      if (a === 'host-set-depth')          return hostSetDepthAct(el.getAttribute('data-depth'));
      // Phase 3 actions
      if (a === 'pick-answer')  return pickAnswer(el.getAttribute('data-value'));
      if (a === 'pick-truth')   return pickTruth(el.getAttribute('data-value'));
      if (a === 'submit-guess') return submitGuessAct();
      if (a === 'reveal-truth') return revealTruthAct();
      if (a === 'done-talking') return nextCardAct();
      if (a === 'next-card')    return nextCardAct();
      if (a === 'finish-explain') return finishExplainAct();
      if (a === 'host-rematch') return hostRematchAct();
    });
    // Pressing Enter inside an input submits the obvious action.
    document.body.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target && e.target.id === 'host-name') { e.preventDefault(); return hostCreate(); }
      if (e.target && (e.target.id === 'join-code' || e.target.id === 'join-name')) { e.preventDefault(); return joinGo(); }
    });
  }

  // ----- boot -----
  // Language picker: persist the choice and reload so the right deck file
  // (cards.json / cards.es.json) and UI shell load cleanly from the top.
  function setLangAct(lang) {
    save(K.lang, lang === 'es' ? 'es' : 'en');
    location.reload();
  }

  function boot() {
    wire();
    // First-run language gate (mirrors LQ): if no language has been chosen,
    // show the picker before anything else. The choice persists and reloads.
    if (load(K.lang, null) === null) {
      show('screen-language');
      return;
    }
    // Kick off the (language-correct) deck fetch immediately so it's cached by
    // the time the game actually starts. Silently swallow errors; retries later.
    loadCardsOnce().catch(function () {});
    var params = new URLSearchParams(location.search);
    var joinPrefilled = (params.get('join') || '').toUpperCase();
    var existingCode = load(K.code, null);
    var existingPid = load(K.playerId, null);

    if (existingCode && existingPid) {
      // Already in a room; rejoin the lobby and resume polling.
      var c = load(K.code, '');
      renderQR(c);
      show('screen-lobby');
      startPolling();
      return;
    }
    if (joinPrefilled) {
      gotoJoinSetup();
      return;
    }
    show('screen-router');
  }

  boot();
})();
