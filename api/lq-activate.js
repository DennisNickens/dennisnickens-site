/* ============================================================
   POST /api/lq-activate
   ------------------------------------------------------------
   Two modes:

   Mode 1: action = "activate"
     Body: { token, fingerprint, userAgent }
     Validates token, registers the device's fingerprint, returns
     first name + license info so the PWA can stash it.

   Mode 2: action = "send_code"
     Body: { email }
     Looks up license by email, generates a 6-digit code, stores it
     in KV with a 15-minute TTL, emails it to the buyer.

   Mode 3: action = "verify_code"
     Body: { email, code, fingerprint, userAgent }
     Validates code, registers the device on the license, returns
     the license token + name so the PWA can stash it.

   Used by the activation UI when someone has no token in localStorage
   yet (e.g. they came to /games/lovers-quest/ directly and need to
   enter the email they bought with to receive a verification code).
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const {
  getLicense,
  findLicenseByEmail,
  registerDevice,
  normalizeEmail
} = require('../lib/lq-licenses.js');
const { sendVerifyCode } = require('../lib/lq-emails.js');

const CODE_TTL_SECONDS = 15 * 60; // 15 minutes

function newCode() {
  // 6-digit numeric code, padded.
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
      if (!result.ok) {
        res.status(404).json({ ok: false, error: result.reason });
        return;
      }
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
      if (!email) {
        res.status(400).json({ ok: false, error: 'missing_email' });
        return;
      }
      const found = await findLicenseByEmail(email);
      // We always return ok:true here so an attacker can't probe
      // whether an email has a license. If the license exists, we
      // send the code; if not, we silently do nothing.
      if (found) {
        const code = newCode();
        await kv.set(`verify:${email}:${code}`, '1', { ex: CODE_TTL_SECONDS });
        try {
          await sendVerifyCode({ email, firstName: found.record.firstName, code });
        } catch (mailErr) {
          console.error('[lq-activate] verify code email failed:', mailErr);
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
      const codeOk = await kv.get(`verify:${email}:${code}`);
      if (!codeOk) {
        res.status(401).json({ ok: false, error: 'invalid_or_expired_code' });
        return;
      }
      const found = await findLicenseByEmail(email);
      if (!found) {
        res.status(404).json({ ok: false, error: 'license_not_found' });
        return;
      }
      const result = await registerDevice(found.token, { fingerprint, userAgent });
      if (!result.ok) {
        res.status(500).json({ ok: false, error: result.reason });
        return;
      }
      // Burn the code so it can't be reused.
      await kv.del(`verify:${email}:${code}`);
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
    console.error('[lq-activate] error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
