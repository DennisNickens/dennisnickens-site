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

// Hardcoded fallback field UUIDs for the SR Linked Pair fields. These are the
// confirmed field IDs in the dennisnickens.com GHL location as of 2026-05-31.
// If GHL_FIELD_ID_MAP env var has these keys mapped, those take precedence.
const FALLBACK_FIELD_IDS = {
  sr_pair_code: 'gT7Ye5eV7vTwtTTSIGqn',
  sr_pair_role: '7t5XcD4UdwC2yPvEX4PQ',
  sr_qual_focus_areas: 'VxuX8HfeDm82blyoai70',
  sr_qual_who_for: 'x4f4ZxeDHodBR0C3XN6X',
  sr_sku_tier: 'XQgkiFK9fS0wkfdRtS7z',
};

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

// Resolve the GHL field UUID for a given SR field name. Checks GHL_FIELD_ID_MAP
// (reverse lookup) first, then falls back to the hardcoded list above.
function getFieldId(keyMap, fieldName) {
  for (const [id, name] of Object.entries(keyMap)) {
    if (name === fieldName) return id;
  }
  return FALLBACK_FIELD_IDS[fieldName] || null;
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
    const keyMap = getKeyMap();
    const pairCodeFieldId = getFieldId(keyMap, 'sr_pair_code');

    if (!pairCodeFieldId) {
      console.error('[sr-verify-pair-code] No field ID for sr_pair_code (env var and fallback both empty)');
      return res.status(500).json({ success: false, error: 'Field map not configured' });
    }

    // Search by custom field value (not generic query) via filter-based search.
    // GHL contacts/search supports filters by customField UUID via the "filters"
    // array. The generic "query" param only matches name/email/phone, which is
    // why a Pair Code stored in a custom field is never found that way.
    const searchBody = {
      locationId,
      page: 1,
      pageLimit: 25,
      filters: [
        {
          field: `customFields.${pairCodeFieldId}`,
          operator: 'eq',
          value: rawCode,
        },
      ],
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
      return res.status(502).json({ success: false, error: 'GHL search failed', details: searchData });
    }

    let candidates = searchData.contacts || [];

    // Fallback: if the filter-based search returned no results, GHL may not
    // support the filters[] format on this account or API version. Fall back
    // to fetching the candidate by paging contacts and matching client-side.
    // We do a single small page-through and bail if not found, to keep cost low.
    if (candidates.length === 0) {
      console.warn('[sr-verify-pair-code] filter search empty, trying pagination fallback');
      const pageResp = await fetch(`${GHL_BASE}/contacts/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({ locationId, page: 1, pageLimit: 100 }),
      });
      const pageData = await pageResp.json().catch(() => ({}));
      if (pageResp.ok) {
        candidates = pageData.contacts || [];
      }
    }

    if (candidates.length === 0) {
      return res.status(200).json({ success: true, valid: false, reason: 'not_found' });
    }

    // Among candidates, find one whose custom fields contain
    //   sr_pair_code == rawCode AND sr_pair_role == 'primary'
    // We may need to fetch full contact records since search responses
    // sometimes omit customFields.
    let primary = null;
    for (const c of candidates) {
      let fields = c.customFields || [];

      // If search omitted customFields, fetch the full contact record.
      if (!fields.length) {
        const fullResp = await fetch(`${GHL_BASE}/contacts/${c.id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
            'Accept': 'application/json',
          },
        });
        if (fullResp.ok) {
          const fullData = await fullResp.json().catch(() => ({}));
          const fullContact = fullData.contact || fullData;
          fields = fullContact.customFields || [];
          if (!c.firstName) c.firstName = fullContact.firstName;
          if (!c.lastName) c.lastName = fullContact.lastName;
        }
      }

      const flat = flattenCustomFieldsWithFallback(fields, keyMap);
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

// Like flattenCustomFields but also checks FALLBACK_FIELD_IDS so SR fields are
// recognized even if the env var GHL_FIELD_ID_MAP does not include them.
function flattenCustomFieldsWithFallback(fields, keyMap) {
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

    const nameKey = (f.key || f.fieldKey || '').toString();
    if (nameKey) {
      out[nameKey] = value;
      continue;
    }
    if (id && keyMap[id]) {
      out[keyMap[id]] = value;
      continue;
    }
    // Fallback: SR-specific known fields.
    for (const [srKey, srId] of Object.entries(FALLBACK_FIELD_IDS)) {
      if (id === srId) {
        out[srKey] = value;
        break;
      }
    }
  }
  return out;
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
