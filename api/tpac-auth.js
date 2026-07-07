/* ============================================================
   POST /api/tpac-auth — email/password accounts for T-PAC.
   ------------------------------------------------------------
   Body: { action: 'signup'|'login'|'logout', email, password }
     signup — creates the account, returns a session token.
              Password minimum 8 chars. Duplicate email -> 409.
     login  — verifies credentials, returns a session token.
     logout — destroys the Bearer session.

   Response: { ok, token?, uid? }
   The client stores the token and sends it as
   Authorization: Bearer {token} on every call.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const store = require('../lib/tpac-store.js');

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const body = store.parseBody(req);
  const action = String(body.action || '').toLowerCase();

  try {
    if (action === 'logout') {
      await store.destroySession(store.readBearer(req));
      res.status(200).json({ ok: true });
      return;
    }

    const email = store.normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ ok: false, error: 'valid_email_required' });
      return;
    }

    if (action === 'signup') {
      if (password.length < 8) { res.status(400).json({ ok: false, error: 'password_min_8' }); return; }
      const existing = await store.getUserByEmail(email);
      if (existing) { res.status(409).json({ ok: false, error: 'email_in_use' }); return; }
      const salt = store.newSalt();
      const user = {
        uid: crypto.randomUUID(),
        email,
        salt,
        passHash: store.hashPassword(password, salt),
        createdAt: new Date().toISOString(),
        subStatus: 'none',
        stripeCustomerId: null,
        onboarded: false,
      };
      await store.saveUser(user);
      const token = await store.createSession(user.uid);
      res.status(200).json({ ok: true, token, uid: user.uid });
      return;
    }

    if (action === 'login') {
      const user = await store.getUserByEmail(email);
      if (!user || !store.verifyPassword(password, user.salt, user.passHash)) {
        res.status(401).json({ ok: false, error: 'bad_credentials' });
        return;
      }
      const token = await store.createSession(user.uid);
      res.status(200).json({ ok: true, token, uid: user.uid });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('tpac-auth error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
