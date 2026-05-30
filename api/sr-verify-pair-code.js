// /api/sr-verify-pair-code.js
// Validates a Pair Code from the SR Linked Pair feature.
//
// When Secondary visits dennisnickens.com/assessment/partner?code=SR-XXXX-XX
// the partner page calls this endpoint to confirm the code is valid and to
// fetch Primary's identity (first + last name) for display, plus the inherited
// funnel selections (focus, audience, tier) that Secondary will inherit.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID (falls back to known value)

const GHL_BASE = 'https://services.leadconnectorhq.com';
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';

// Map of GHL custom field UUIDs to readable keys for the fields we care about.
// These get appended/merged into the contact's customFields[] array when fetched.
// The funnel-side fields (focus, audience, tier, delivery) are already mapped
// in GHL_FIELD_ID_MAP env var. The pair-specific fields are listed here as well
// in case Dennis hasn't added them to the env var map yet.
function getKeyMap() {
  try {
    const envMap = JSON.parse(process.env.GHL_FIELD_ID_MAP || '{}');
    return envMap;
  } catch (e) {
    return {};
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || FALLBACK_LOCATION_ID).trim();
  if (!token) {
    console.error('[sr-verify-pair-code] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  const rawCode = (req.query.code || '').toString().trim().toUpperCase();
  if (!rawCode) {
    return res.status(400).json({ success: false, error: 'Missing code' });
  }

  // Basic format check: SR-XXXX-XX (avoiding 0/O/1/I). If it does not match, fail fast.
  if (!/^SR-[A-Z2-9]{4}-[A-Z2-9]{2}$/.test(rawCode)) {
    return res.status(200).json({ success: true, valid: false, reason: 'format' });
  }

  try {
    // Search for any contact with this pair code via GHL's contact search endpoint.
    const searchUrl = `${GHL_BASE}/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&number=${encodeURIComponent(rawCode)}`;

    // GHL does not have a direct "search by custom field key" endpoint that is
    // universally reliable. Use the broader contacts search filter instead.
    const searchBody = {
      locationId,
      query: rawCode,
      page: 1,
      pageLimit: 25,
    };

    const searchResp = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(searchBody),
    });
    const searchData = await searchResp.json().catch(() => ({}));

    if (!searchResp.ok) {
      console.error('[sr-verify-pair-code] GHL search failed:', searchResp.status, JSON.stringify(searchData));
      return res.status(502).json({ success: false, error: 'GHL search failed' });
    }

    const candidates = searchData.contacts || [];
    if (candidates.length === 0) {
      return res.status(200).json({ success: true, valid: false, reason: 'not_found' });
    }

    // Among the candidates, find one whose custom fields contain
    //   sr_pair_code == rawCode AND sr_pair_role == 'primary'
    const keyMap = getKeyMap();
    let primary = null;
    for (const c of candidates) {
      const fields = c.customFields || [];
      const flat = flattenCustomFields(fields, keyMap);
      if (flat.sr_pair_code === rawCode && (flat.sr_pair_role || '').toLowerCase() === 'primary') {
        primary = c;
        primary._flatFields = flat;
        break;
      }
    }

    if (!primary) {
      return res.status(200).json({ success: true, valid: false, reason: 'no_primary' });
    }

    const flat = primary._flatFields;
    return res.status(200).json({
      success: true,
      valid: true,
      primary_contact_id: primary.id,
      primary_first_name: primary.firstName || '',
      primary_last_name: primary.lastName || '',
      sr_qual_focus_areas: flat.sr_qual_focus_areas || '',
      sr_qual_who_for: flat.sr_qual_who_for || '',
      sr_sku_tier: flat.sr_sku_tier || '',
    });
  } catch (err) {
    console.error('[sr-verify-pair-code] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

// GHL returns customFields as an array of { id, value } pairs where id is a UUID.
// Convert to a flat { key: value } object using the env-var-defined ID map plus
// any name-keyed entries that GHL may return directly.
function flattenCustomFields(fields, keyMap) {
  const out = {};
  for (const f of fields) {
    if (!f) continue;
    const id = f.id;
    const value =
      f.value !== undefined ? f.value :
      f.field_value !== undefined ? f.field_value :
      f.fieldValueString !== undefined ? f.fieldValueString :
      f.fieldValue !== undefined ? f.fieldValue :
      '';

    // First, try name-keyed shape (some GHL responses include key/fieldKey).
    const nameKey = (f.key || f.fieldKey || '').toString();
    if (nameKey) {
      out[nameKey] = value;
      continue;
    }
    // Fall back to id map.
    if (id && keyMap[id]) {
      out[keyMap[id]] = value;
    }
  }
  return out;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
