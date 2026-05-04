// Serverless function that receives webhook from GHL Workflow WF-03
// after a customer submits their SR Full Assessment.
//
// What it does:
//   1. Validates the Authorization Bearer token against SR_WEBHOOK_SECRET env var
//   2. Logs the incoming payload (all contact fields including custom fields)
//   3. Calls the GHL API to set sr_blueprint_status = "Generated" on the contact
//      (which triggers WF-04 to deliver the Blueprint email)
//   4. Returns a success response
//
// During beta: Dennis manually generates the actual Blueprint for each customer.
//              This stub just acknowledges receipt and signals back to GHL.
//
// Required environment variables (set in Vercel Project Settings > Environment Variables):
//   SR_WEBHOOK_SECRET                 Bearer token shared with GHL Custom Value
//   GHL_API_KEY                       Private Integration token from GHL Settings > Private Integrations
//   GHL_BLUEPRINT_STATUS_FIELD_ID     Custom field ID for sr_blueprint_status (look up in GHL Settings > Custom Fields)

module.exports = async function handler(request, response) {
  // Only accept POST requests
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Step 1: Validate auth
  const authHeader = request.headers['authorization'];
  const expectedToken = 'Bearer ' + process.env.SR_WEBHOOK_SECRET;

  if (!authHeader || authHeader !== expectedToken) {
    console.warn('Unauthorized webhook attempt. Auth header:', authHeader ? 'present but mismatched' : 'missing');
    return response.status(401).json({ error: 'Unauthorized' });
  }

  // Step 2: Parse the payload
  // GHL sends a flat JSON body with all standard contact fields plus all custom fields
  const payload = request.body;

  if (!payload || !payload.contact_id) {
    console.error('Invalid payload received:', payload);
    return response.status(400).json({ error: 'Invalid payload. Missing contact_id.' });
  }

  // Step 3: Log everything received (so we can see the data flow during beta)
  console.log('SR Blueprint webhook received');
  console.log('Contact ID:', payload.contact_id);
  console.log('Name:', payload.first_name, payload.last_name);
  console.log('Email:', payload.email);
  console.log('SKU Tier:', payload.sr_sku_tier);
  console.log('Lens:', payload.sr_qual_lens);
  console.log('Lens Detail:', payload.sr_qual_lens_detail);
  console.log('Pillar 1 (DISC):', {
    d: payload.sr_pillar1_d_score,
    i: payload.sr_pillar1_i_score,
    s: payload.sr_pillar1_s_score,
    c: payload.sr_pillar1_c_score
  });
  console.log('Pillar 2 (Type):', payload.sr_pillar2_type);
  console.log('Pillar 3 (Action Style):', {
    factfinder: payload.sr_pillar3_factfinder,
    followthru: payload.sr_pillar3_followthru,
    quickstart: payload.sr_pillar3_quickstart,
    implementor: payload.sr_pillar3_implementor
  });
  console.log('Pillar 4 (Connection):', {
    primary: payload.sr_pillar4_primary,
    secondary: payload.sr_pillar4_secondary
  });
  console.log('Pillar 5 (Learning):', {
    visual: payload.sr_pillar5_visual,
    auditory: payload.sr_pillar5_auditory,
    reading: payload.sr_pillar5_reading,
    doing: payload.sr_pillar5_doing
  });
  console.log('Pillar 6 (Faith):', {
    orientation: payload.sr_pillar6_faith_orientation,
    themes: payload.sr_pillar6_themes
  });

  // Step 4: Call GHL API to set sr_blueprint_status = "Generated"
  // This triggers WF-04 (Blueprint Ready > Deliver) which sends the blueprint-delivered email.
  //
  // BETA NOTE: For beta, Dennis manually generates and delivers the actual Blueprint.
  // This callback just signals "ready" to GHL so the email automation fires.

  try {
    await updateGhlContactField(
      payload.contact_id,
      process.env.GHL_BLUEPRINT_STATUS_FIELD_ID,
      'Generated'
    );
    console.log('Successfully updated sr_blueprint_status to Generated');
  } catch (error) {
    console.error('Failed to update GHL contact:', error.message);
    // Still return 200 to GHL so it doesn't retry, but log the error so Dennis can investigate
    return response.status(200).json({
      success: false,
      error: 'Webhook received but GHL callback failed. Check Vercel logs.',
      details: error.message
    });
  }

  // Step 5: Acknowledge success
  return response.status(200).json({
    success: true,
    message: 'Webhook received and processed. sr_blueprint_status set to Generated.',
    contact_id: payload.contact_id
  });
};

// Helper: Update a custom field on a GHL contact via the v2 API
async function updateGhlContactField(contactId, fieldId, value) {
  if (!fieldId) {
    throw new Error('GHL_BLUEPRINT_STATUS_FIELD_ID env var is not set');
  }
  if (!process.env.GHL_API_KEY) {
    throw new Error('GHL_API_KEY env var is not set');
  }

  const url = 'https://services.leadconnectorhq.com/contacts/' + contactId;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify({
      customFields: [
        { id: fieldId, field_value: value }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('GHL API returned ' + response.status + ': ' + errorText);
  }

  return response.json();
}
