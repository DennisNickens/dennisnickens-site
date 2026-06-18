/* ============================================================
   POST /api/lq-verify
   ------------------------------------------------------------
   Confirms the device's local token + fingerprint are still
   valid (e.g. the user hasn't been bumped by a third device
   activation elsewhere). The PWA calls this once on load.

   Body: { token, fingerprint }
   Response: { ok, firstName?, reason? }

   If ok=false the PWA wipes its local credentials and shows the
   re-activation screen (enter email, get code).
   ============================================================ */

'use strict';

const { verifyDevice } = require('../lib/lq-licenses.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

  const token = String(body.token || '').trim();
  const fingerprint = String(body.fingerprint || '').trim();
  if (!token || !fingerprint) {
    res.status(400).json({ ok: false, error: 'missing_fields' });
    return;
  }

  try {
    const result = await verifyDevice(token, fingerprint);
    if (!result.ok) {
      res.status(200).json({ ok: false, reason: result.reason });
      return;
    }
    res.status(200).json({
      ok: true,
      firstName: result.license.firstName || '',
      email: result.license.email
    });
  } catch (err) {
    console.error('[lq-verify] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
