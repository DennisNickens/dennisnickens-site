// /api/sr-update-contact.js
// Updates custom fields on an existing GHL contact during the SR Assessment funnel.
//
// Receives: { contact_id, ...fields }
// where fields may include: sr_qual_focus_areas (array), sr_qual_who_for,
// sr_sku_tier, or any other GHL custom field key.
//
// Environment variables required:
//   GHL_PRIVATE_INTEGRATION_TOKEN - GHL Private Integration token

const GHL_BASE = 'https://services.leadconnectorhq.com';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = (process.env.GHL_PRIVATE_INTEGRATION_TOKEN || '').trim();
  if (!token) {
    console.error('[sr-update-contact] Missing GHL_PRIVATE_INTEGRATION_TOKEN');
    return res.status(500).json({ success: false, error: 'Server misconfigured: GHL_PRIVATE_INTEGRATION_TOKEN not set' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { contact_id, ...fields } = body;
  if (!contact_id) {
    return res.status(400).json({ success: false, error: 'Missing contact_id' });
  }

  const customFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, field_value: value }));

  if (customFields.length === 0) {
    return res.status(400).json({ success: false, error: 'No fields to update' });
  }

  try {
    const response = await fetch(`${GHL_BASE}/contacts/${contact_id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify({ customFields }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[sr-update-contact] GHL update failed:', response.status, JSON.stringify(data));
      return res.status(502).json({
        success: false,
        error: data.message || `GHL update failed (${response.status})`,
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[sr-update-contact] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unexpected error' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
