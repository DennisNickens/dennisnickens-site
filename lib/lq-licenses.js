/* ============================================================
   Lovers Quest license store
   ------------------------------------------------------------
   Backed by Vercel KV. Each license has:

     license:<token>  -> {
       email, firstName, product, devices: [
         { fingerprint, registeredAt, lastSeenAt, userAgent }
       ],
       createdAt, stripeSessionId
     }

     email:<lowercased>:license  -> token   (reverse lookup)

   Rules of the road:
     - A license has a hard cap of 2 active devices.
     - Activating a 3rd device evicts the oldest by registeredAt.
     - A "device" is identified by a short fingerprint hash the
       client computes once and stores in localStorage. Not a true
       fingerprint, just a stable random id that survives reloads.
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');

const MAX_DEVICES = 2;

function newLicenseToken() {
  return crypto.randomBytes(18).toString('base64url'); // ~24 chars URL-safe
}

function newDeviceFingerprint() {
  return crypto.randomBytes(12).toString('base64url'); // ~16 chars URL-safe
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function createLicense({ email, firstName, product, stripeSessionId }) {
  const token = newLicenseToken();
  const record = {
    email: normalizeEmail(email),
    firstName: String(firstName || '').trim(),
    product: product || 'lovers-quest',
    devices: [],
    createdAt: new Date().toISOString(),
    stripeSessionId: stripeSessionId || null
  };
  await kv.set(`license:${token}`, record);
  await kv.set(`email:${record.email}:license`, token);
  return { token, record };
}

async function getLicense(token) {
  if (!token) return null;
  return await kv.get(`license:${token}`);
}

async function findLicenseByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const token = await kv.get(`email:${e}:license`);
  if (!token) return null;
  const record = await kv.get(`license:${token}`);
  if (!record) return null;
  return { token, record };
}

async function saveLicense(token, record) {
  await kv.set(`license:${token}`, record);
}

/*
   Register or refresh a device on a license.
   Returns: { ok, license, evictedDevice? }
   Behavior:
     - If fingerprint already registered: update lastSeenAt, return ok.
     - If room available (devices.length < MAX_DEVICES): add and return ok.
     - If at cap: evict the oldest device by registeredAt, add the new
       one, return ok with evictedDevice noted (so the caller can warn
       the user "looks like you activated on a new device").
*/
async function registerDevice(token, { fingerprint, userAgent }) {
  const record = await getLicense(token);
  if (!record) return { ok: false, reason: 'license_not_found' };

  const now = new Date().toISOString();
  const ua = String(userAgent || '').slice(0, 200);

  const existing = (record.devices || []).find(d => d.fingerprint === fingerprint);
  if (existing) {
    existing.lastSeenAt = now;
    existing.userAgent = ua;
    await saveLicense(token, record);
    return { ok: true, license: record, evictedDevice: null };
  }

  let evicted = null;
  if ((record.devices || []).length >= MAX_DEVICES) {
    record.devices.sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt));
    evicted = record.devices.shift();
  }

  record.devices = record.devices || [];
  record.devices.push({
    fingerprint,
    registeredAt: now,
    lastSeenAt: now,
    userAgent: ua
  });

  await saveLicense(token, record);
  return { ok: true, license: record, evictedDevice: evicted };
}

/*
   Check whether a device's fingerprint is currently authorized on
   this license. Used on every PWA load to confirm the local token
   is still valid (e.g. another device may have bumped this one).
*/
async function verifyDevice(token, fingerprint) {
  const record = await getLicense(token);
  if (!record) return { ok: false, reason: 'license_not_found' };
  const present = (record.devices || []).some(d => d.fingerprint === fingerprint);
  if (!present) return { ok: false, reason: 'device_not_registered', license: record };
  return { ok: true, license: record };
}

module.exports = {
  MAX_DEVICES,
  newDeviceFingerprint,
  normalizeEmail,
  createLicense,
  getLicense,
  findLicenseByEmail,
  saveLicense,
  registerDevice,
  verifyDevice
};
