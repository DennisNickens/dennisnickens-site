// /api/sr-get-contact.js
// Fetches a GHL contact and returns a normalized view used by the confirm page.
//
// GET /api/sr-get-contact?cid=<contactId>
//
// GHL returns custom fields on a contact as an array. The shape varies a bit
// across API versions and tenants. The two we observe in the wild are:
//
//   [{ id: "<uuid>",  value: "..." }]                 (id-keyed, V2 default)
//   [{ id: "<uuid>",  fieldValueString: "..." }]      (id-keyed, V2 with rich type field)
//   [{ key: "sr_qual_focus_areas", value: "..." }]    (name-keyed, V1-style)
//
// To normalize for the confirm page we need to convert any id-keyed entries
// into name-keyed ones using the location's custom field definitions.
//
// Resolution order for the id-to-key map:
//   1. Hardcoded map from env var GHL_FIELD_ID_MAP (JSON object)
//      (used when /locations/{id}/customFields cannot be reached by token scope)
//   2. GET /locations/{id}/customFields            (default, oauth.readonly scope)
//   3. GET /locations/{id}/customFields?model=contact   (older shape)
//
// All non-success paths log loudly. We never silently return `fields: {}`.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID (falls back to known value)
//   GHL_FIELD_ID_MAP              - optional JSON: { "<uuid>": "sr_qual_focus_areas", ... }

const GHL_BASE = 'https://services.leadconnectorhq.com';

// The SR GHL location id is not a secret (it travels in API URLs). Fall back to
// the known value if the env var is not configured in the deployment.
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';

// Cache the id->key map across warm invocations to avoid re-fetching definitions.
let fieldKeyMapCache = null;
let fieldKeyMapSource = null;

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
    // GHL's V2 contact GET returns custom fields by default. We do not pass
    // any include params because some versions reject unknown query keys with
    // a 422. The customFields array is always present on success.
    const url = `${GHL_BASE}/contacts/${cid}`;
    console.log('[sr-get-contact] GET', url);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[sr-get-contact] GHL contact fetch failed:', response.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        success: false,
        error: data.message || `GHL fetch failed (${response.status})`,
      });
    }

    const contact = data.contact || data;
    const rawCustom = Array.isArray(contact.customFields)
      ? contact.customFields
      : (Array.isArray(contact.custom_fields) ? contact.custom_fields : []);

    // Log a one-shot fingerprint of the response shape so we can verify in
    // Vercel logs what GHL is actually returning.
    if (rawCustom.length > 0) {
      const first = rawCustom[0] || {};
      console.log('[sr-get-contact] customFields count:', rawCustom.length,
        'sample keys on first entry:', Object.keys(first).join(','));
    } else {
      console.warn('[sr-get-contact] customFields array is empty on the contact GET response. Top-level keys:',
        Object.keys(contact).join(','));
    }

    const fields = {};
    let resolvedById = 0;
    let resolvedByName = 0;
    let unresolved = 0;
    let keyMap = null;

    for (const cf of rawCustom) {
      // Pull whichever value-shaped property is present.
      const value = pickValue(cf);

      // Case 1: entry already carries a name-style key. Use it directly.
      const nameKey = (cf.key || cf.fieldKey || '').replace(/^contact\./, '');
      if (nameKey && !looksLikeUuid(nameKey)) {
        fields[nameKey] = value;
        resolvedByName += 1;
        continue;
      }

      // Case 2: entry is id-keyed. Lazy-load the id->key map.
      if (cf.id) {
        if (!keyMap) {
          keyMap = await getFieldKeyMap(token, locationId);
        }
        const mapped = keyMap[cf.id];
        if (mapped) {
          fields[mapped] = value;
          resolvedById += 1;
        } else {
          unresolved += 1;
          // Surface the bare uuid so Dennis can grab it from logs and add it
          // to GHL_FIELD_ID_MAP if it ever comes up.
          console.warn('[sr-get-contact] Unresolved custom field id:', cf.id);
        }
      } else {
        unresolved += 1;
        console.warn('[sr-get-contact] Custom field entry had neither id nor name key:', JSON.stringify(cf).slice(0, 200));
      }
    }

    console.log('[sr-get-contact] field resolution summary:',
      JSON.stringify({
        cid,
        total: rawCustom.length,
        resolvedByName,
        resolvedById,
        unresolved,
        keyMapSource: fieldKeyMapSource,
        resolvedKeys: Object.keys(fields),
      }));

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
    console.error('[sr-get-contact] Error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

function pickValue(cf) {
  if (cf == null) return '';
  if (cf.value !== undefined) return cf.value;
  if (cf.field_value !== undefined) return cf.field_value;
  if (cf.fieldValueString !== undefined) return cf.fieldValueString;
  if (cf.fieldValueArray !== undefined) return cf.fieldValueArray;
  if (cf.fieldValueNumber !== undefined) return cf.fieldValueNumber;
  if (cf.fieldValueDate !== undefined) return cf.fieldValueDate;
  return '';
}

function looksLikeUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s);
}

async function getFieldKeyMap(token, locationId) {
  if (fieldKeyMapCache) return fieldKeyMapCache;

  // 1. Hardcoded map from env var. Bulletproof fallback when the locations
  //    custom fields endpoint is unreachable with the current token scope.
  const envMap = readEnvFieldMap();
  if (envMap && Object.keys(envMap).length > 0) {
    console.log('[sr-get-contact] Using GHL_FIELD_ID_MAP from env, entries:', Object.keys(envMap).length);
    fieldKeyMapCache = envMap;
    fieldKeyMapSource = 'env';
    return envMap;
  }

  // 2. Try the default custom fields list endpoint.
  let defs = await fetchFieldDefs(token, locationId, '');
  let source = 'locations/customFields';
  if (!defs.length) {
    // 3. Older shape.
    defs = await fetchFieldDefs(token, locationId, '?model=contact');
    source = 'locations/customFields?model=contact';
  }

  const map = {};
  for (const def of defs) {
    // GHL field def shape: { id, fieldKey: "contact.sr_qual_focus_areas",
    //                       name: "SR Qualifier Focus Areas", ... }
    // Some tenants use `key` instead of `fieldKey`.
    const rawKey = def.fieldKey || def.key || '';
    const short = rawKey.replace(/^contact\./, '');
    if (def.id && short) map[def.id] = short;
  }

  if (Object.keys(map).length > 0) {
    fieldKeyMapCache = map;
    fieldKeyMapSource = source;
    console.log('[sr-get-contact] Built field key map from', source, 'entries:', Object.keys(map).length);
  } else {
    console.error('[sr-get-contact] Field key map is EMPTY. Both list endpoints returned no defs and no GHL_FIELD_ID_MAP env var is set. Custom fields cannot be resolved.');
    fieldKeyMapSource = 'none';
  }
  return map;
}

function readEnvFieldMap() {
  const raw = (process.env.GHL_FIELD_ID_MAP || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    console.error('[sr-get-contact] GHL_FIELD_ID_MAP is not a JSON object');
    return null;
  } catch (e) {
    console.error('[sr-get-contact] GHL_FIELD_ID_MAP is not valid JSON:', e.message);
    return null;
  }
}

async function fetchFieldDefs(token, locationId, query) {
  const url = `${GHL_BASE}/locations/${locationId}/customFields${query}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.error('[sr-get-contact] Network error loading custom field defs:', url, e.message);
    return [];
  }

  if (!response.ok) {
    let bodySnippet = '';
    try { bodySnippet = (await response.text()).slice(0, 300); } catch {}
    console.error('[sr-get-contact] Failed to load custom field definitions:', response.status, url, 'body:', bodySnippet);
    return [];
  }

  const data = await response.json().catch(() => ({}));
  return data.customFields || data.custom_fields || [];
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
