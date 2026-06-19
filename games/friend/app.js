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

  var SCREENS = ['screen-router', 'screen-host-setup', 'screen-join-setup', 'screen-lobby', 'screen-pairing', 'screen-playing'];
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
    } else if (room.phase === 'playing' || room.phase === 'roundEnd' || room.phase === 'gameOver') {
      show('screen-playing');
      renderPlaying(room);
    }
  }

  // Placeholder render for the playing phase. Phase 3 ships the real
  // round loop, question display, guess submission, score updates, and
  // race-car visualization. For now we just show all the locked pairs so
  // the host has clear feedback that Start the Game actually worked.
  function renderPlaying(room) {
    var players = room.players || [];
    var pairs = room.pairs || [];
    var ul = $('playing-pairs');
    if (ul) {
      ul.innerHTML = '';
      pairs.forEach(function (pr) {
        var a = players.find(function (x) { return x.id === pr.playerIds[0]; });
        var b = players.find(function (x) { return x.id === pr.playerIds[1]; });
        if (!a || !b) return;
        var li = document.createElement('li');
        li.className = 'pair-' + (pr.color || 'coral');
        li.textContent = a.name + ' & ' + b.name;
        ul.appendChild(li);
      });
    }
    var status = $('playing-status');
    if (status) status.textContent = 'Round 1 of ' + (pairs.length + ' pairs racing to 25');
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
