// /api/sr-get-contact.js
// Fetches a GHL contact and returns a normalized view used by the confirm page.
//
// GET /api/sr-get-contact?cid=<contactId>
//
// GHL returns custom fields as [{ id, value }]. To make them usable on the
// front end we resolve each id to its short field key (e.g. beta_scenario_focus)
// using the location's custom field definitions.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID

const GHL_BASE = 'https://services.leadconnectorhq.com';

// The SR GHL location id is not a secret (it travels in API URLs). Fall back to
// the known value if the env var is not configured in the deployment.
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';

// Cache the id->key map across warm invocations to avoid re-fetching definitions.
let fieldKeyMapCache = null;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || FALLBACK_LOCATION_ID).trim();
  if (!token) {
    console.error('[sr-get-contact] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured: GHL_PRIVATE_INTEGRATION_TOKEN not set' });
  }

  const cid = (req.query && req.query.cid) || '';
  if (!cid) {
    return res.status(400).json({ success: false, error: 'Missing cid' });
  }

  try {
    const response = await fetch(`${GHL_BASE}/contacts/${cid}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[sr-get-contact] GHL fetch failed:', response.status, JSON.stringify(data));
      return res.status(502).json({
        success: false,
        error: data.message || `GHL fetch failed (${response.status})`,
      });
    }

    const contact = data.contact || data;
    const keyMap = await getFieldKeyMap(token, locationId);

    const fields = {};
    const rawCustom = Array.isArray(contact.customFields) ? contact.customFields : [];
    for (const cf of rawCustom) {
      const key = keyMap[cf.id];
      if (key) fields[key] = cf.value;
    }

    return res.status(200).json({
      success: true,
      contact: {
        id: contact.id,
        firstName: contact.firstName || '',
        lastName: contact.lastName || '',
        email: contact.email || '',
        phone: contact.phone || '',
        fields,
      },
    });
  } catch (err) {
    console.error('[sr-get-contact] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

async function getFieldKeyMap(token, locationId) {
  if (fieldKeyMapCache) return fieldKeyMapCache;

  const response = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': '2021-07-28',
    },
  });

  if (!response.ok) {
    console.error('[sr-get-contact] Failed to load custom field definitions:', response.status);
    return {};
  }

  const data = await response.json().catch(() => ({}));
  const defs = data.customFields || [];
  const map = {};
  for (const def of defs) {
    // fieldKey looks like "contact.beta_scenario_focus" — strip the object prefix.
    const short = (def.fieldKey || '').replace(/^contact\./, '');
    if (def.id && short) map[def.id] = short;
  }
  fieldKeyMapCache = map;
  return map;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
