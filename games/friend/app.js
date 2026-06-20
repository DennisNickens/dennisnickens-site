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

  var SCREENS = ['screen-router', 'screen-host-setup', 'screen-join-setup', 'screen-lobby', 'screen-pairing', 'screen-team-setup', 'screen-playing', 'screen-game-over'];

  // Same palette as lib/friend-state.js TEAM_ICONS. Hardcoded here so the
  // picker grid renders immediately without an extra round trip. Server is
  // still the authority on validation.
  var TEAM_ICONS = ['🔥', '⚡', '💎', '⭐', '🚀', '🌊', '🦁', '🦊', '🐯', '🐺', '🌙', '☀️'];
  function show(id) {
    SCREENS.forEach(function (s) { var el = $(s); if (!el) return; el.hidden = (s !== id); });
  }

  // ----- localStorage state (per device) -----
  var K = {
    code: 'ycyf_room_code',
    playerId: 'ycyf_player_id',
    name: 'ycyf_name',
    isHost: 'ycyf_is_host'
  };

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
      msg = count + ' of ' + min + ' minimum players';
    } else if (count >= max) {
      msg = 'Room full (' + max + ' players)';
    } else {
      msg = count + ' players, room for ' + (max - count) + ' more';
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
    cardsLoadPromise = fetch('cards.json', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('cards.json ' + r.status); return r.json(); })
      .then(function (j) {
        CARDS_DATA = j;
        (j.cards || []).forEach(function (c) { CARD_BY_ID[c.id] = c; });
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
    var btn = $('start-game-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
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
        if (btn) { btn.disabled = false; btn.textContent = 'Next: Pick Icons →'; }
      }
    } catch (e) {
      alert('Network error.');
      if (btn) { btn.disabled = false; btn.textContent = 'Next: Pick Icons →'; }
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
    var btn = $('confirm-icons-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Confirming...'; }
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
        if (btn) { btn.disabled = false; btn.textContent = 'Next: Confirm Teams →'; }
      }
    } catch (e) {
      alert('Network error.');
      if (btn) { btn.disabled = false; btn.textContent = 'Next: Confirm Teams →'; }
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
      var ct = $('card-text'); if (ct) ct.textContent = 'Loading the deck...';
      return;
    }
    var me = load(K.playerId, null);
    var card = CARD_BY_ID[room.currentCardId];
    if (!card) return;

    if (renderPlaying._lastCardId !== room.currentCardId ||
        renderPlaying._lastSubPhase !== room.subPhase) {
      pendingPick = null;
      renderPlaying._lastCardId = room.currentCardId;
      renderPlaying._lastSubPhase = room.subPhase;
    }

    var role = roleOf(room, me);
    var isTalkCard = card.type === 'reflection' || card.type === 'discussion';

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

  function renderRace(room) {
    var r = $('race-round'); if (r) r.textContent = 'Round ' + (room.round || 1);
    var ul = $('race-cars'); if (!ul) return;
    ul.innerHTML = '';
    var cap = room.cap || 25;
    (room.pairs || []).forEach(function (pr) {
      var li = document.createElement('li');
      li.className = 'race-car pair-' + (pr.color || 'coral');
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
    var t = $('card-theme'); if (t) t.textContent = String(card.theme || '').toUpperCase();
    var ty = $('card-type-label');
    if (ty) {
      var labels = {
        mc4: '4 options',
        mc6: '6 options',
        group_vote: 'Point at a person',
        reflection: 'Reflection · no scoring',
        discussion: 'Group discussion · no scoring'
      };
      ty.textContent = labels[card.type] || '';
    }
    var h = $('card-subject-hint');
    if (h) {
      var partner = partnerNameInActivePair(room);
      h.textContent = 'About ' + subjectName(room)
        + (partner ? ' · ' + partner + ' guesses' : '');
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
      btn.textContent = locked ? 'Guess locked in' : 'Lock In Guess';
    }
    var eyebrow = $('guesser-eyebrow');
    if (eyebrow) {
      eyebrow.textContent = card.type === 'group_vote'
        ? 'Who would ' + subjectName(room) + ' pick?'
        : 'What did ' + subjectName(room) + ' pick?';
    }
    var status = $('guesser-status');
    if (status) {
      status.textContent = locked
        ? 'Guess locked in. Waiting on ' + subjectName(room) + ' to reveal.'
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
        ? 'Reveal The Truth'
        : 'Waiting on ' + (partner || 'partner');
    }
    var eyebrow = $('subject-eyebrow');
    if (eyebrow) eyebrow.textContent = 'You\'re up. Pick what\'s actually true.';
    var status = $('subject-status');
    if (status) {
      if (!partnerIn) status.textContent = 'Pick your truth in the meantime. You can reveal once ' + (partner || 'your partner') + ' has guessed.';
      else if (!pendingPick) status.textContent = 'Pick the truth, then reveal.';
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
    if (eyebrow) eyebrow.textContent = 'Watching · ' + (icon ? icon + ' ' : '') + (activePair && activePair.teamName ? activePair.teamName : (subject + ' & ' + partner));
    if (line) {
      line.textContent = subject + ' is the subject. '
        + (partner ? partner + ' is guessing what ' + subject + ' picked.' : '');
    }
    if (status) {
      status.textContent = room.partnerHasGuessed
        ? (partner || 'Partner') + ' locked in. Waiting on ' + subject + ' to reveal.'
        : 'Waiting on the pair...';
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
        partnerLine.textContent = (partner || 'Partner') + ' guessed: ' + pgText
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
    var btn = $('next-card-btn');
    if (btn) {
      btn.hidden = !isSubject;
      btn.disabled = false;
      btn.textContent = room.winnerPairId ? 'See Final Results →' : 'Next Card →';
    }
    var status = $('reveal-status');
    if (status) {
      status.textContent = isSubject ? '' : 'Waiting on ' + subjectName(room) + ' to advance...';
    }
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
      rematchBtn.textContent = 'Rematch (Same Teams) →';
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
      if (titleEl) titleEl.textContent = (winner.icon || '🏎') + ' ' + wn + ' Win';
      if (leadEl) leadEl.textContent = 'First pair to ' + (room.cap || 25) + '. The race is run.';
    } else {
      if (titleEl) titleEl.textContent = 'Game Over';
      if (leadEl) leadEl.textContent = '';
    }
    var sorted = (room.pairs || []).slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    sorted.forEach(function (pr) {
      var li = document.createElement('li');
      li.className = 'pair-' + (pr.color || 'coral') + (pr.id === room.winnerPairId ? ' is-winner' : '');
      li.innerHTML = '<span class="s-name">' + esc(pairLabel(room, pr)) + '</span><span class="s-score">' + (pr.score || 0) + '</span>';
      ul.appendChild(li);
    });
  }

  // ---------- Phase 3 action handlers ----------
  function pickAnswer(value) { pendingPick = value; renderRoom(lastRoom); }
  function pickTruth(value) { pendingPick = value; renderRoom(lastRoom); }

  async function submitGuessAct() {
    if (!pendingPick) return;
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var guess = pendingPick;
    var btn = $('submit-guess-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Locking in...'; }
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
    var btn = $('reveal-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Revealing...'; }
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
    var btn = $('rematch-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Starting rematch...'; }
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
        if (btn) { btn.disabled = false; btn.textContent = 'Rematch (Same Teams) →'; }
      }
    } catch (e) {
      alert('Network error starting rematch.');
      if (btn) { btn.disabled = false; btn.textContent = 'Rematch (Same Teams) →'; }
    }
  }

  async function nextCardAct() {
    var code = load(K.code, ''), pid = load(K.playerId, '');
    var btn = $('next-card-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Advancing...'; }
    var dbtn = $('done-talking-btn'); if (dbtn) { dbtn.disabled = true; dbtn.textContent = 'Advancing...'; }
    try {
      var r = await api('/api/friend-next-card', { method: 'POST', body: { code: code, playerId: pid } });
      if (r.status === 200 && r.body && r.body.ok) {
        lastRoom = r.body.room;
        renderRoom(lastRoom);
      } else {
        var msg = (r.body && r.body.error) || 'unknown';
        alert('Could not advance: ' + msg);
        if (btn) { btn.disabled = false; btn.textContent = 'Next Card →'; }
        if (dbtn) { dbtn.disabled = false; dbtn.textContent = 'Done Sharing'; }
      }
    } catch (e) {
      alert('Network error advancing.');
      if (btn) { btn.disabled = false; btn.textContent = 'Next Card →'; }
      if (dbtn) { dbtn.disabled = false; dbtn.textContent = 'Done Sharing'; }
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
    save(K.name, name);
    var btn = document.querySelector('[data-action="host-create"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
    try {
      var r = await api('/api/friend-create-room', { method: 'POST', body: { hostName: name } });
      if (r.status === 200 && r.body && r.body.ok) {
        save(K.code, r.body.code);
        save(K.playerId, r.body.hostId);
        save(K.isHost, true);
        renderQR(r.body.code);
        show('screen-lobby');
        startPolling();
      } else {
        showErr('host-name-err', 'Could not create the room. Try again in a moment.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Create Room'; }
    }
  }

  async function joinGo() {
    hideErr('join-err');
    var code = String(($('join-code').value || '')).trim().toUpperCase();
    var name = String(($('join-name').value || '')).trim();
    if (!code || code.length < 4) { showErr('join-err', 'Enter the 4-letter room code from your host.'); return; }
    if (!name) { showErr('join-err', 'Add your name so the table knows who joined.'); return; }
    save(K.name, name);
    var btn = document.querySelector('[data-action="join-go"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Joining...'; }
    try {
      var r = await api('/api/friend-join-room', { method: 'POST', body: { code: code, name: name } });
      if (r.status === 200 && r.body && r.body.ok) {
        save(K.code, r.body.room.code);
        save(K.playerId, r.body.playerId);
        save(K.isHost, false);
        renderQR(r.body.room.code);
        show('screen-lobby');
        startPolling();
      } else {
        var msg = 'Could not join the room.';
        if (r.body && r.body.error === 'room_not_found') msg = 'No room with that code. Check the letters and try again.';
        if (r.body && r.body.error === 'game_already_started') msg = 'That game already started. Ask your host to start a new one.';
        if (r.body && r.body.error === 'room_full') msg = 'That room is full (10 players max).';
        if (r.body && r.body.error === 'name_required') msg = 'Add your name first.';
        showErr('join-err', msg);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Join Room'; }
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

  function gotoHostSetup() {
    var n = load(K.name, '');
    if (n) $('host-name').value = n;
    show('screen-host-setup');
  }
  function gotoJoinSetup() {
    var params = new URLSearchParams(location.search);
    var preCode = (params.get('join') || '').toUpperCase();
    if (preCode) $('join-code').value = preCode;
    var n = load(K.name, '');
    if (n) $('join-name').value = n;
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
    var btn = $('start-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Pairing...'; }
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
        if (btn) { btn.disabled = false; btn.textContent = 'Pair Up →'; }
      }
    } catch (err) {
      alert('Network error. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Pair Up →'; }
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
    var btn = $('start-game-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
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
        if (btn) { btn.disabled = false; btn.textContent = 'Start the Game'; }
      }
    } catch (err) {
      alert('Network error. Try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Start the Game'; }
    }
  }

  // ----- wire -----
  function wire() {
    document.body.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var a = el.getAttribute('data-action');
      if (a === 'goto-host')    return gotoHostSetup();
      if (a === 'goto-join')    return gotoJoinSetup();
      if (a === 'back-router')  return backRouter();
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
  function boot() {
    wire();
    // Kick off cards.json fetch immediately so it's cached by the time the
    // game actually starts. Silently swallow errors; renderPlaying retries.
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
