/* ============================================================
   POST /api/ycyf-verify
   ------------------------------------------------------------
   Mirrors api/lq-verify.js. Confirms a device's local token +
   fingerprint are still authorized (e.g. it has not been bumped by
   a third device). The YCYF PWA calls this once on load. If
   ok=false the client wipes ycyf_license and re-shows the
   activation gate the next time Start a Game is tapped.

   Body: { token, fingerprint }
   Response: { ok, firstName?, email?, reason? }
   ============================================================ */

'use strict';

const { verifyDevice } = require('../lib/ycyf-licenses.js');

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
  if (!token || !fingerprint) { res.status(400).json({ ok: false, error: 'missing_fields' }); return; }

  try {
    const result = await verifyDevice(token, fingerprint);
    if (!result.ok) { res.status(200).json({ ok: false, reason: result.reason }); return; }
    res.status(200).json({
      ok: true,
      firstName: result.license.firstName || '',
      email: result.license.email
    });
  } catch (err) {
    console.error('[ycyf-verify] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
