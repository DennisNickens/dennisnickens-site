/* ============================================================
   POST /api/ycyf-activate
   ------------------------------------------------------------
   Mirrors api/lq-activate.js. Three actions:

   action = "activate"   (post-purchase email link, ?access=<token>)
     Body: { token, fingerprint }
     Registers the device, returns firstName + email.

   action = "send_code"
     Body: { email }
     Looks up the YCYF license by email, generates a 6-digit code,
     stores it in KV (15-min TTL), emails it. Always returns ok so an
     attacker cannot probe which emails own a license.

   action = "verify_code"
     Body: { email, code, fingerprint }
     Validates the code, registers the device, returns the license
     token + firstName so the PWA can stash it as ycyf_license.

   Verify codes are namespaced ycyf:verify:* so they never collide
   with the Lovers Quest activation codes.
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const {
  findLicenseByEmail,
  registerDevice,
  normalizeEmail
} = require('../lib/ycyf-licenses.js');
const { sendVerifyCode } = require('../lib/ycyf-emails.js');

const CODE_TTL_SECONDS = 15 * 60; // 15 minutes

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

  const action = body.action || 'activate';

  try {
    if (action === 'activate') {
      const token = String(body.token || '').trim();
      const fingerprint = String(body.fingerprint || '').trim();
      const userAgent = req.headers['user-agent'] || '';
      if (!token || !fingerprint) {
        res.status(400).json({ ok: false, error: 'missing_token_or_fingerprint' });
        return;
      }
      const result = await registerDevice(token, { fingerprint, userAgent });
      if (!result.ok) { res.status(404).json({ ok: false, error: result.reason }); return; }
      res.status(200).json({
        ok: true,
        firstName: result.license.firstName || '',
        email: result.license.email,
        evicted: !!result.evictedDevice
      });
      return;
    }

    if (action === 'send_code') {
      const email = normalizeEmail(body.email);
      if (!email) { res.status(400).json({ ok: false, error: 'missing_email' }); return; }
      const found = await findLicenseByEmail(email);
      if (found) {
        const code = newCode();
        await kv.set(`ycyf:verify:${email}:${code}`, '1', { ex: CODE_TTL_SECONDS });
        try {
          await sendVerifyCode({ email, firstName: found.record.firstName, code });
        } catch (mailErr) {
          console.error('[ycyf-activate] verify code email failed:', mailErr);
        }
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'verify_code') {
      const email = normalizeEmail(body.email);
      const code = String(body.code || '').replace(/[^0-9]/g, '');
      const fingerprint = String(body.fingerprint || '').trim();
      const userAgent = req.headers['user-agent'] || '';
      if (!email || !code || !fingerprint) {
        res.status(400).json({ ok: false, error: 'missing_fields' });
        return;
      }
      const codeOk = await kv.get(`ycyf:verify:${email}:${code}`);
      if (!codeOk) { res.status(401).json({ ok: false, error: 'invalid_or_expired_code' }); return; }
      const found = await findLicenseByEmail(email);
      if (!found) { res.status(404).json({ ok: false, error: 'license_not_found' }); return; }
      const result = await registerDevice(found.token, { fingerprint, userAgent });
      if (!result.ok) { res.status(500).json({ ok: false, error: result.reason }); return; }
      await kv.del(`ycyf:verify:${email}:${code}`);
      res.status(200).json({
        ok: true,
        token: found.token,
        firstName: result.license.firstName || '',
        email: result.license.email,
        evicted: !!result.evictedDevice
      });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('[ycyf-activate] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
