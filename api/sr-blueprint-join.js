/* ============================================================
   /api/sr-blueprint-join — Linked Pair invite codes.
   ------------------------------------------------------------
   GET ?code={CODE}
     Public lookup a secondary uses before joining.
     -> { ok, status, primaryFirstName }
     -> { ok:false, error:'not_found' } for a bad or expired code
     Never returns emails or cids; the code alone should not
     expose either party's contact details.

   GET ?cid={CID}
     Pair info for a contact, used by complete.html to decide
     whether to show the invite section. Only a PRIMARY gets the
     code back; solo customers and secondaries get not_found, so
     no invite UI can render for them.
     -> { ok, role:'primary', code, status, joinUrl }

   POST { code, firstName, lastName, email }
     Registers the secondary on the pair:
       1. Validates the pair exists and is joinable.
       2. Creates (upserts) a GHL contact for the secondary.
       3. Grants the secondary a Deep entitlement at no charge;
          the Linked Pair purchase covers both people.
       4. Writes secondary onto the pair record, status ->
          'awaiting_completion'.
     Re-posting with the same email resumes the existing
     registration (returns the same cid). A different email gets
     'code_in_use'.
     -> { ok, cid, primaryFirstName }
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const { normalizeCode } = require('../lib/blueprint-invite-codes.js');

const ENTITLEMENT_TTL_SECONDS = 60 * 60 * 24 * 365;
const PAIR_TTL_SECONDS = 60 * 60 * 24 * 90;

async function createSecondaryContact({ firstName, lastName, email }) {
  const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
  const r = await fetch(baseUrl + '/api/sr-create-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, email }),
  });
  const data = await r.json().catch(() => ({}));
  const cid = data && (data.contactId || data.contact_id || (data.contact && data.contact.id));
  if (!r.ok || !data.success || !cid) {
    throw new Error('contact_create_failed:' + r.status);
  }
  return String(cid);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const query = req.query || {};

      if (query.code) {
        const code = normalizeCode(query.code);
        const pair = code ? await kv.get('sr:pair:' + code) : null;
        if (!pair) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        res.status(200).json({
          ok: true,
          status: pair.status,
          primaryFirstName: (pair.primary && pair.primary.first_name) || '',
        });
        return;
      }

      if (query.cid) {
        const cid = String(query.cid).trim();
        const ref = cid ? await kv.get('sr:pair-by-cid:' + cid) : null;
        if (!ref || ref.role !== 'primary' || !ref.code) {
          res.status(404).json({ ok: false, error: 'not_found' });
          return;
        }
        const pair = await kv.get('sr:pair:' + ref.code);
        if (!pair) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        const baseUrl = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';
        res.status(200).json({
          ok: true,
          role: 'primary',
          code: ref.code,
          status: pair.status,
          joinUrl: baseUrl + '/assessment/?join=' + ref.code,
        });
        return;
      }

      res.status(400).json({ ok: false, error: 'code_or_cid_required' });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method_not_allowed' });
      return;
    }

    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
    catch (_) { body = {}; }

    const code = normalizeCode(body.code);
    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!code) { res.status(400).json({ ok: false, error: 'code_required' }); return; }
    if (!firstName || !lastName || !email) {
      res.status(400).json({ ok: false, error: 'name_and_email_required' });
      return;
    }

    const pairKey = 'sr:pair:' + code;
    const pair = await kv.get(pairKey);
    if (!pair) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    if (pair.status === 'ready_for_comparison' || pair.comparison_generated_at) {
      res.status(409).json({ ok: false, error: 'already_complete' });
      return;
    }

    // Resume: same email as the registered secondary gets their cid back.
    if (pair.secondary && pair.secondary.cid) {
      if (String(pair.secondary.email || '').toLowerCase() === email) {
        res.status(200).json({
          ok: true,
          cid: pair.secondary.cid,
          primaryFirstName: (pair.primary && pair.primary.first_name) || '',
        });
        return;
      }
      res.status(409).json({ ok: false, error: 'code_in_use' });
      return;
    }

    const cid = await createSecondaryContact({ firstName, lastName, email });

    // The Linked Pair purchase covers both people: the secondary gets a
    // Deep entitlement with no charge, tied back to the pair.
    await kv.set('sr:entitlement:' + cid, {
      cid,
      tier: 'deep',
      sku: 'linked_pair_light',
      source: 'linked_pair_secondary',
      pairCode: code,
      email,
      paidAt: new Date().toISOString(),
    }, { ex: ENTITLEMENT_TTL_SECONDS });

    pair.secondary = {
      session_id: null,
      cid,
      first_name: firstName,
      email,
      completed_at: null,
    };
    pair.status = 'awaiting_completion';
    await kv.set(pairKey, pair, { ex: PAIR_TTL_SECONDS });
    await kv.set('sr:pair-by-cid:' + cid, { code, role: 'secondary' }, { ex: PAIR_TTL_SECONDS });

    res.status(200).json({
      ok: true,
      cid,
      primaryFirstName: (pair.primary && pair.primary.first_name) || '',
    });
  } catch (err) {
    console.error('sr-blueprint-join error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
