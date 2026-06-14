// /api/sr-create-contact.js
// Creates or updates a GHL contact at the start of the SR Assessment funnel.
//
// Uses GHL's upsert endpoint so a returning visitor (same email) updates the
// existing contact instead of creating a duplicate.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID

const GHL_BASE = 'https://services.leadconnectorhq.com';

// The SR GHL location id is not a secret (it travels in API URLs). Fall back to
// the known value if the env var is not configured in the deployment.
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || FALLBACK_LOCATION_ID).trim();
  if (!token) {
    console.error('[sr-create-contact] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured: GHL_PRIVATE_INTEGRATION_TOKEN not set' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { firstName, lastName, email, phone, delivery_preference, tcpa_consent } = body;

  // firstName and lastName are always required. Email OR phone is required (at least one);
  // both is fine. The funnel intake form always sends both, so its behavior is unchanged.
  // SMS-only invites (no email) and email-only contacts are now both accepted.
  if (!firstName || !lastName) {
    return res.status(400).json({ success: false, error: 'Missing required fields: firstName and lastName are required' });
  }
  if (!email && !phone) {
    return res.status(400).json({ success: false, error: 'Missing required fields: at least one of email or phone is required' });
  }

  const customFields = [
    { key: 'delivery_preference', field_value: delivery_preference || 'Email' },
    { key: 'tcpa_sms_consent', field_value: tcpa_consent ? 'Yes' : 'No' },
  ];

  // Only include contact channels that are actually present. Sending an empty email or
  // phone to GHL's upsert can muddy its dedup matching, so omit absent fields entirely.
  const payload = {
    firstName,
    lastName,
    locationId,
    customFields,
  };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;

  try {
    const response = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[sr-create-contact] GHL upsert failed:', response.status, JSON.stringify(data));
      return res.status(502).json({
        success: false,
        error: data.message || `GHL upsert failed (${response.status})`,
      });
    }

    const contact = data.contact || data;
    const contactId = contact.id || contact.contactId;

    if (!contactId) {
      console.error('[sr-create-contact] No contact id in GHL response:', JSON.stringify(data));
      return res.status(502).json({ success: false, error: 'GHL did not return a contact id' });
    }

    return res.status(200).json({ success: true, contact_id: contactId });
  } catch (err) {
    console.error('[sr-create-contact] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
