// /api/sr-generate-pair-code.js
// Generates a unique Pair Code for a Primary contact in the SR Linked Pair flow.
//
// Called by qualifier-audience.html (or any future flow page) when the customer
// picks a Linked Pair eligible audience. The endpoint:
//   1. Generates a code in the format SR-XXXX-XX using safe characters
//      (no 0/O/1/I to prevent visual ambiguity)
//   2. Writes sr_pair_code + sr_pair_role=primary to the contact via GHL upsert
//   3. Returns the code to the client so the rest of the funnel can use it
//
// If the contact already has a pair code, the existing code is returned
// (idempotent). This means a user who navigates back and forward through
// the funnel does not end up with multiple codes on their record.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID

const GHL_BASE = 'https://services.leadconnectorhq.com';
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChar() {
  return CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
}

function makePairCode() {
  let mid = '';
  for (let i = 0; i < 4; i++) mid += randomChar();
  let tail = '';
  for (let i = 0; i < 2; i++) tail += randomChar();
  return `SR-${mid}-${tail}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || FALLBACK_LOCATION_ID).trim();
  if (!token) {
    console.error('[sr-generate-pair-code] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const contactId = (body.contact_id || '').toString().trim();
  if (!contactId) {
    return res.status(400).json({ success: false, error: 'Missing contact_id' });
  }

  try {
    // First, check if the contact already has a pair code so we are idempotent.
    const existingResp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
      },
    });
    const existingData = await existingResp.json().catch(() => ({}));
    if (existingResp.ok) {
      const c = existingData.contact || existingData;
      const fields = c.customFields || [];
      const existingCode = readCustomField(fields, 'sr_pair_code');
      if (existingCode) {
        return res.status(200).json({ success: true, pair_code: existingCode, reused: true });
      }
    }

    // Generate a fresh code. We assume collision risk is negligible at the
    // current beta scale (about 6.8 billion possible codes). A retry loop
    // with a uniqueness check against GHL can be added later if abuse warrants.
    const code = makePairCode();

    // Write the code to the contact via the customFields upsert.
    const updateBody = {
      customFields: [
        { key: 'sr_pair_code', field_value: code },
        { key: 'sr_pair_role', field_value: 'primary' },
      ],
    };

    const updateResp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(updateBody),
    });
    const updateData = await updateResp.json().catch(() => ({}));

    if (!updateResp.ok) {
      console.error('[sr-generate-pair-code] GHL update failed:', updateResp.status, JSON.stringify(updateData));
      return res.status(502).json({
        success: false,
        error: updateData.message || `GHL update failed (${updateResp.status})`,
      });
    }

    return res.status(200).json({ success: true, pair_code: code, reused: false });
  } catch (err) {
    console.error('[sr-generate-pair-code] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

// Read a custom field value by its name key. Handles both name-keyed and id-keyed
// response shapes. For id-keyed, looks up via GHL_FIELD_ID_MAP if available.
function readCustomField(fields, keyName) {
  let idMap = {};
  try { idMap = JSON.parse(process.env.GHL_FIELD_ID_MAP || '{}'); } catch (e) {}
  // Build reverse map so we can match the keyName to the id.
  let matchId = null;
  for (const id in idMap) {
    if (idMap[id] === keyName) { matchId = id; break; }
  }
  for (const f of fields) {
    if (!f) continue;
    const nameKey = (f.key || f.fieldKey || '').toString();
    if (nameKey === keyName) {
      return f.value || f.field_value || f.fieldValueString || f.fieldValue || '';
    }
    if (matchId && f.id === matchId) {
      return f.value || f.field_value || f.fieldValueString || f.fieldValue || '';
    }
  }
  return '';
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
