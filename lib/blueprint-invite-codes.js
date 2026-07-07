/* ============================================================
   Linked Pair invite code generation.
   ------------------------------------------------------------
   8 characters from an unambiguous alphanumeric alphabet: no
   O/0 and no I/l/1, so a code survives being read aloud or
   copied by hand. 31^8 combinations, collision-free at our
   scale, but we still check KV before handing one out.

   Distinct from api/sr-generate-pair-code.js (the legacy GHL
   SR-XXXX-XX Pair Code); this alphabet and the sr:pair:{code}
   KV namespace belong to the Linked Pair Blueprint flow.
   ============================================================ */

'use strict';

const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

// Uppercases and strips anything outside the alphabet so pasted
// codes with spaces, dashes, or stray lowercase still match.
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Generates a collision-checked invite code. `kv` is the @vercel/kv
 * client; the caller owns writing the pair record.
 */
async function generateInviteCode(kv) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = randomCode();
    const existing = await kv.get('sr:pair:' + code);
    if (!existing) return code;
  }
  throw new Error('invite_code_collision');
}

module.exports = { generateInviteCode, normalizeCode, randomCode, CODE_CHARS, CODE_LENGTH };
