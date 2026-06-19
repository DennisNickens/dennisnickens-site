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

  var SCREENS = ['screen-router', 'screen-host-setup', 'screen-join-setup', 'screen-lobby', 'screen-pairing'];
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

    // Future deploy: if room.phase === 'pairing' we'd swap to a pairing UI;
    // for Phase 1 we just stay on the lobby screen.
    if (room.phase === 'pairing') {
      // Placeholder so the host's "Pair Up" tap doesn't strand everyone on lobby.
      show('screen-pairing');
    }
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

  // host taps Pair Up. Placeholder POST will land in the next deploy.
  function hostStart() {
    var btn = $('start-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Pairing...'; }
    // For Phase 1 we just navigate locally to the placeholder pairing screen.
    // Phase 2 will POST to /api/friend-action with action=advance_to_pairing and
    // sync everyone via the next poll.
    show('screen-pairing');
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
