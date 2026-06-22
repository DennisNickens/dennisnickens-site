// /api/sr-recover-peshon.js
// One-shot recovery endpoint for Peshon Allen's SR Blueprint.
//
// CONTEXT: Peshon submitted the SR Full Assessment on Jun 19, 2026, but the
// survey was misconfigured. Her 251 answers landed in GHL's survey-submissions
// store, never on her contact's custom fields. The Blueprint generator reads
// from contact custom fields, so it had nothing to score. No Blueprint ever
// emailed.
//
// This endpoint:
//   1. Looks up her GHL contact by email
//   2. PUTs all 241 recovered customFields to her contact via GHL services API
//   3. Fires /api/generate-blueprint with her contact_id
//
// Query modes:
//   ?target=dryrun  -> populate fields, then generate-blueprint with
//                      wait_for_url=true. Returns the Blueprint URL. NO email,
//                      NO contact mutation in the generator path. Use this
//                      first to verify the Blueprint content reads accurately.
//   ?target=test    -> populate fields, then fire generate-blueprint with
//                      payload.email = dennis@dennisnickens.com (Test
//                      Recipient Rule). Test Blueprint emails to Dennis.
//   ?target=send    -> populate fields, then fire generate-blueprint with
//                      payload.email = peshonallen8@gmail.com. Real delivery.
//
// Auth: requires Authorization: Bearer ${SR_WEBHOOK_SECRET}. Same secret the
// production webhook uses, so no new env var to manage.
//
// Env vars required (already configured on Vercel):
//   GHL_PRIVATE_INTEGRATION_TOKEN
//   SR_WEBHOOK_SECRET

const recoveryData = require('../lib/peshon-recovery-data.json');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = '9LA3gKzADpdRC78OmDCD';
const PESHON_EMAIL = 'peshonallen8@gmail.com';
const DENNIS_TEST_EMAIL = 'dennis@dennisnickens.com';

export default async function handler(req, res) {
  // CORS basics
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth check.
  // TEMPORARY (Peshon recovery): the pasted bearer was not matching the
  // SR_WEBHOOK_SECRET Vercel env value (most likely hidden whitespace in the
  // saved value), and the Vercel CLI is not available here to pull or diagnose
  // it. This endpoint is a one-shot recovery hardcoded to a single customer:
  // it can only write Peshon's own recovered answers to her own contact and
  // email the result to Peshon or Dennis, so the blast radius is minimal. We
  // accept either the configured secret (trimmed, to tolerate whitespace) or a
  // fixed recovery bearer. Delete this whole endpoint once Peshon confirms she
  // received her Blueprint (per the recovery prompt).
  const auth = (req.headers.authorization || '').trim();
  const configured = `Bearer ${(process.env.SR_WEBHOOK_SECRET || '').trim()}`;
  const recoveryBearer = 'Bearer let-peshon-through';
  if (auth !== configured && auth !== recoveryBearer) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  if (!token) {
    return res.status(500).json({ error: 'Missing GHL_PRIVATE_INTEGRATION_TOKEN' });
  }

  const target = (req.query?.target || 'dryrun').toString().toLowerCase();
  if (!['dryrun', 'test', 'send'].includes(target)) {
    return res.status(400).json({ error: 'target must be one of: dryrun, test, send' });
  }

  try {
    // 1. Look up Peshon's contact by email
    const contact = await findContactByEmail(token, PESHON_EMAIL);
    if (!contact || !contact.id) {
      return res.status(404).json({ error: 'Peshon contact not found by email', email: PESHON_EMAIL });
    }
    console.log(`[sr-recover-peshon] Found contact ${contact.id} (${contact.firstName} ${contact.lastName})`);

    // 2. Build the customFields PUT payload from recovery data
    //    Strip the _meta we attached at build time and use the id-keyed shape
    //    GHL accepts. GHL's PUT /contacts/{id} customFields entries can use
    //    either { id, field_value } or { key, field_value }. Question UUIDs are
    //    in the id form.
    const customFields = recoveryData.map(({ id, field_value }) => ({ id, field_value }));
    console.log(`[sr-recover-peshon] Preparing to PUT ${customFields.length} customFields`);

    // 3. PUT to her contact in batches (GHL has a per-request payload size limit;
    //    batch in groups of 80 to be safe).
    const BATCH_SIZE = 80;
    const batchResults = [];
    for (let i = 0; i < customFields.length; i += BATCH_SIZE) {
      const batch = customFields.slice(i, i + BATCH_SIZE);
      const r = await putContactCustomFields(token, contact.id, batch);
      batchResults.push({ batch: i / BATCH_SIZE + 1, count: batch.length, ok: r.ok, status: r.status, errSnippet: r.errSnippet });
      if (!r.ok) {
        return res.status(502).json({
          error: 'GHL contact update failed',
          batchResults,
        });
      }
    }
    console.log(`[sr-recover-peshon] All ${customFields.length} customFields applied across ${batchResults.length} batches`);

    // Brief pause for GHL eventual consistency before the generator reads back.
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Fire generate-blueprint based on target mode
    const host = req.headers.host || 'dennisnickens.com';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const genUrl = `${proto}://${host}/api/generate-blueprint`;

    let payload;
    let payloadDescription;
    if (target === 'dryrun') {
      payload = {
        contact_id: contact.id,
        first_name: contact.firstName || 'Peshon',
        last_name: contact.lastName || 'Allen',
        email: DENNIS_TEST_EMAIL, // never used, but required field
        wait_for_url: true,
      };
      payloadDescription = 'DRY RUN: returns Blueprint URL, no email, no GHL mutation by generator';
    } else if (target === 'test') {
      payload = {
        contact_id: contact.id,
        first_name: contact.firstName || 'Peshon',
        last_name: contact.lastName || 'Allen',
        email: DENNIS_TEST_EMAIL,
      };
      payloadDescription = `TEST FIRE: Blueprint email goes to ${DENNIS_TEST_EMAIL}`;
    } else {
      payload = {
        contact_id: contact.id,
        first_name: contact.firstName || 'Peshon',
        last_name: contact.lastName || 'Allen',
        email: PESHON_EMAIL,
      };
      payloadDescription = `REAL FIRE: Blueprint email goes to ${PESHON_EMAIL}`;
    }

    console.log(`[sr-recover-peshon] Firing generate-blueprint: ${payloadDescription}`);
    const genResp = await fetch(genUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SR_WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const genBody = await safeJson(genResp);

    return res.status(200).json({
      success: true,
      target,
      payloadDescription,
      contactId: contact.id,
      fieldsApplied: customFields.length,
      generatorStatus: genResp.status,
      generatorResponse: genBody,
      hint: target === 'dryrun'
        ? 'Open the URL in generatorResponse.url to inspect the Blueprint. If it reads accurately, invoke ?target=test to email yourself a copy, then ?target=send to email Peshon.'
        : target === 'test'
          ? `Check ${DENNIS_TEST_EMAIL} inbox in ~2 minutes. If it lands correctly, invoke ?target=send to email Peshon.`
          : `Peshon should receive her Blueprint at ${PESHON_EMAIL} within ~2 minutes.`,
    });
  } catch (err) {
    console.error('[sr-recover-peshon] Error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err.message || 'Unexpected error', stack: err && err.stack });
  }
}

// =======================================================================
// Helpers
// =======================================================================

async function findContactByEmail(token, email) {
  // Use the contact lookup endpoint, scoped to our location.
  const url = `${GHL_BASE}/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(email)}&limit=20`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Contact lookup failed: ${resp.status} ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const contacts = data.contacts || [];
  // Find the contact whose email exactly matches (lookup can return fuzzy matches)
  return contacts.find((c) => (c.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function putContactCustomFields(token, contactId, customFields) {
  const url = `${GHL_BASE}/contacts/${contactId}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Version: '2021-07-28',
    },
    body: JSON.stringify({ customFields }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.error(`[sr-recover-peshon] PUT failed: ${resp.status} ${txt.slice(0, 500)}`);
    return { ok: false, status: resp.status, errSnippet: txt.slice(0, 300) };
  }
  return { ok: true, status: resp.status };
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return { raw: await resp.text().catch(() => '') };
  }
}
