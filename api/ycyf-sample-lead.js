// /api/ycyf-sample-lead.js
// Captures a "You Call Yourself A Friend" sample lead from the public
// sample page. Creates (or upserts) the contact in GHL and applies the
// "YCYF Sample Lead" tag so Dennis can later trigger a workflow to send
// the buy link when the full game launches.
//
// Body: { firstName, phone, tcpa_consent }
//   firstName    - required string
//   phone        - required, US 10 digits (any format, normalized to +1XXXXXXXXXX)
//   tcpa_consent - optional bool (implicit consent by submitting; we still record it)
//
// Env required:
//   GHL_PRIVATE_INTEGRATION_TOKEN
//   GHL_LOCATION_ID (with fallback)
//
// Returns: { success, contact_id, tagged } or { success:false, error }

const GHL_BASE = 'https://services.leadconnectorhq.com';
const FALLBACK_LOCATION_ID = '9LA3gKzADpdRC78OmDCD';
const LEAD_TAG = 'YCYF Sample Lead';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || FALLBACK_LOCATION_ID).trim();
  if (!token) {
    console.error('[ycyf-sample-lead] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const firstName = (body.firstName || '').toString().trim();
  const phoneRaw = (body.phone || '').toString();
  const tcpa = !!body.tcpa_consent;

  if (!firstName) {
    return res.status(400).json({ success: false, error: 'First name is required.' });
  }
  // Phone normalize: strip non-digits, allow leading 1, require exactly 10 digits
  const digits = phoneRaw.replace(/\D/g, '');
  let tenDigit = digits;
  if (tenDigit.length === 11 && tenDigit.startsWith('1')) tenDigit = tenDigit.slice(1);
  if (tenDigit.length !== 10) {
    return res.status(400).json({ success: false, error: 'Phone must be a 10-digit US number.' });
  }
  const phoneE164 = '+1' + tenDigit;

  try {
    // Upsert the contact. Use "Lead" as the lastName placeholder since GHL
    // requires it but we only collect first name from the form. Dennis can
    // edit this in GHL later when he follows up.
    const upsertPayload = {
      firstName,
      lastName: 'Lead',
      phone: phoneE164,
      locationId,
      customFields: [
        { key: 'tcpa_sms_consent', field_value: tcpa ? 'Yes' : 'No' },
        { key: 'delivery_preference', field_value: 'SMS' },
      ],
    };
    const upsertResp = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(upsertPayload),
    });
    const upsertData = await upsertResp.json().catch(() => ({}));
    if (!upsertResp.ok) {
      console.error('[ycyf-sample-lead] GHL upsert failed:', upsertResp.status, JSON.stringify(upsertData));
      return res.status(502).json({
        success: false,
        error: upsertData.message || `GHL upsert failed (${upsertResp.status})`,
      });
    }
    const contact = upsertData.contact || upsertData;
    const contactId = contact.id || contact.contactId;
    if (!contactId) {
      console.error('[ycyf-sample-lead] No contact id in upsert response');
      return res.status(502).json({ success: false, error: 'GHL did not return a contact id' });
    }

    // Apply the "YCYF Sample Lead" tag so Dennis can trigger a workflow on it
    // later (buy-link blast when the full game launches).
    let tagged = true;
    try {
      const tagResp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({ tags: [LEAD_TAG] }),
      });
      if (!tagResp.ok) {
        const t = await tagResp.text().catch(() => '');
        console.warn('[ycyf-sample-lead] tag add failed (non-fatal):', tagResp.status, t.slice(0, 200));
        tagged = false;
      }
    } catch (e) {
      console.warn('[ycyf-sample-lead] tag add threw (non-fatal):', e && e.message);
      tagged = false;
    }

    return res.status(200).json({ success: true, contact_id: contactId, tagged });
  } catch (err) {
    console.error('[ycyf-sample-lead] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
