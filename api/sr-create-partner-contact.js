// /api/sr-create-partner-contact.js
// Creates a Secondary contact in the SR Linked Pair flow.
//
// Called by partner.html after Secondary validates the Pair Code and submits
// their intake form. The endpoint:
//   1. Creates a new GHL contact for the Secondary (or upserts by email)
//   2. Writes inherited fields from Primary: focus, audience, tier, pair code
//   3. Sets sr_pair_role=secondary and sr_pair_partner_contact_id=<primary>
//   4. Updates Primary's contact to set sr_pair_partner_contact_id=<secondary>
//   5. Returns the new Secondary's contact_id so partner.html can redirect to
//      welcome.html?cid=<secondary_id>&pair=secondary
//
// Edge cases handled:
//   - If Secondary's email matches Primary's email, reject with 400 (same-person)
//   - If Primary already has a partner linked, accept this as a replacement
//     (Phase 2 may want to lock this; for v1 we keep it open)
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token
//   GHL_LOCATION_ID               - GHL location ID

const GHL_BASE = 'https://services.leadconnectorhq.com';
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
    console.error('[sr-create-partner-contact] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    firstName, lastName, email, phone,
    delivery_preference, tcpa_consent,
    sr_pair_code, primary_contact_id,
    sr_qual_focus_areas, sr_qual_who_for, sr_sku_tier,
  } = body;

  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  if (!sr_pair_code || !primary_contact_id) {
    return res.status(400).json({ success: false, error: 'Missing pair context (code or primary id)' });
  }

  try {
    // Sanity check: fetch Primary to confirm email mismatch and to validate the code.
    const primaryResp = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(primary_contact_id)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
      },
    });
    const primaryData = await primaryResp.json().catch(() => ({}));
    if (!primaryResp.ok) {
      console.error('[sr-create-partner-contact] Primary fetch failed:', primaryResp.status);
      return res.status(502).json({ success: false, error: 'Could not verify primary contact' });
    }
    const primary = primaryData.contact || primaryData;
    if ((primary.email || '').toLowerCase() === (email || '').toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'This email is already on the Primary account. Use a different email for the Secondary.',
      });
    }

    // Create or upsert the Secondary contact.
    const customFields = [
      { key: 'delivery_preference', field_value: delivery_preference || 'Email' },
      { key: 'tcpa_sms_consent', field_value: tcpa_consent ? 'Yes' : 'No' },
      { key: 'sr_pair_code', field_value: sr_pair_code },
      { key: 'sr_pair_role', field_value: 'secondary' },
      { key: 'sr_pair_partner_contact_id', field_value: primary_contact_id },
      // Inherited from Primary so the Secondary's survey routes the same way.
      { key: 'sr_qual_focus_areas', field_value: sr_qual_focus_areas || '' },
      { key: 'sr_qual_who_for', field_value: sr_qual_who_for || '' },
      { key: 'sr_sku_tier', field_value: sr_sku_tier || '' },
    ];

    const upsertResp = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        firstName, lastName, email, phone,
        locationId,
        customFields,
      }),
    });
    const upsertData = await upsertResp.json().catch(() => ({}));
    if (!upsertResp.ok) {
      console.error('[sr-create-partner-contact] Upsert failed:', upsertResp.status, JSON.stringify(upsertData));
      return res.status(502).json({
        success: false,
        error: upsertData.message || `GHL upsert failed (${upsertResp.status})`,
      });
    }
    const secondaryContact = upsertData.contact || upsertData;
    const secondaryId = secondaryContact.id || secondaryContact.contactId;

    if (!secondaryId) {
      console.error('[sr-create-partner-contact] No secondary id in response');
      return res.status(502).json({ success: false, error: 'GHL did not return a contact id for the partner' });
    }

    // Update Primary's contact to point sr_pair_partner_contact_id at the Secondary.
    // We do this best-effort so the comparison Blueprint trigger can find both records.
    try {
      await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(primary_contact_id)}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          customFields: [
            { key: 'sr_pair_partner_contact_id', field_value: secondaryId },
          ],
        }),
      });
    } catch (e) {
      console.warn('[sr-create-partner-contact] Could not update primary with partner id (non-fatal):', e.message);
    }

    return res.status(200).json({ success: true, contact_id: secondaryId });
  } catch (err) {
    console.error('[sr-create-partner-contact] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
