/* ============================================================
   T-PAC shared store: users, sessions, auth helpers.
   ------------------------------------------------------------
   All T-PAC keys live under the tpac: prefix in the shared
   Vercel KV (same instance the games use, different namespace).

   Keys:
     tpac:user:{emailLower}   user record (auth + subscription)
     tpac:uid:{uid}           reverse lookup uid -> emailLower
     tpac:session:{token}     login session, 30 day TTL
     tpac:profile:{uid}       bowler profile (onboarding answers)
     tpac:balls:{uid}         array of bowling balls
     tpac:series:{uid}        array of logged series, newest first
     tpac:chat:{uid}          Ace chat history, capped
     tpac:stripe:{customerId} uid (webhook lookup)

   Passwords are scrypt-hashed with a per-user salt. Session
   tokens are random 256-bit hex strings sent as a Bearer header.
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function getUserByEmail(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  return await kv.get('tpac:user:' + key);
}

async function getUserByUid(uid) {
  if (!uid) return null;
  const email = await kv.get('tpac:uid:' + uid);
  if (!email) return null;
  return await kv.get('tpac:user:' + email);
}

async function saveUser(user) {
  await kv.set('tpac:user:' + user.email, user);
  await kv.set('tpac:uid:' + user.uid, user.email);
}

async function createSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await kv.set('tpac:session:' + token, { uid, createdAt: new Date().toISOString() }, { ex: SESSION_TTL_SECONDS });
  return token;
}

async function destroySession(token) {
  if (token) await kv.del('tpac:session:' + token);
}

function readBearer(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * Resolves the authenticated user from the request's Bearer token.
 * Returns null when unauthenticated. Callers gate with requireUser.
 */
async function getAuthedUser(req) {
  const token = readBearer(req);
  if (!token) return null;
  const session = await kv.get('tpac:session:' + token);
  if (!session || !session.uid) return null;
  const user = await getUserByUid(session.uid);
  return user || null;
}

/**
 * True when the user can use the paid app: an active or trialing
 * Stripe subscription. Everything except signup/login/checkout
 * gates on this.
 */
function hasActiveSubscription(user) {
  return !!user && (user.subStatus === 'active' || user.subStatus === 'trialing');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(req) {
  try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { return {}; }
}

module.exports = {
  kv,
  SESSION_TTL_SECONDS,
  normalizeEmail,
  hashPassword,
  newSalt,
  verifyPassword,
  getUserByEmail,
  getUserByUid,
  saveUser,
  createSession,
  destroySession,
  readBearer,
  getAuthedUser,
  hasActiveSubscription,
  setCors,
  parseBody,
};
