/* ============================================================
   apparel-emails.js
   ------------------------------------------------------------
   Order confirmation email for the apparel store. Sends through
   Resend, the same path the Lovers Quest and Blueprint emails use
   (reuses RESEND_API_KEY).

   One email today:
     sendApparelConfirmation  fires after a successful purchase and
                              a created Printify order.
   ============================================================ */

'use strict';

const FROM = 'Dennis Nickens <dennis@dennisnickens.com>';
const REPLY_TO = 'admin@dennisnickens.com';
const BASE_URL = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

async function sendViaResend({ to, subject, html, bcc }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      bcc: bcc || ['admin@dennisnickens.com'],
      subject,
      html,
      reply_to: REPLY_TO
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend send failed: ${response.status} ${errText}`);
  }
  return await response.json();
}

function clean(s) {
  return String(s || '').replace(/[<>&"']/g, '');
}

function confirmationHtml({ firstName, productTitle, variantLabel, quantity, printifyOrderId }) {
  const safeName = clean(firstName) || 'friend';
  const title = clean(productTitle) || 'your order';
  const variant = clean(variantLabel);
  const qty = Math.min(5, Math.max(1, parseInt(quantity, 10) || 1));
  const detailLine = variant ? `${title} (${variant})` : title;
  const ref = clean(printifyOrderId);

  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 580px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #b08838; letter-spacing: 0.04em; margin: 0 0 1.4rem;">Spiritual Romeo Apparel</p>

  <p>${safeName},</p>

  <p>Thank you for your order. Your payment went through and we have sent it to production. Every piece is made to order, so it is printed fresh for you rather than pulled off a shelf.</p>

  <p style="margin: 1.6rem 0; padding: 16px 18px; background: #faf7ef; border-left: 3px solid #b08838;">
    <strong>What you ordered</strong><br>
    ${detailLine}<br>
    Quantity: ${qty}
    ${ref ? `<br>Order reference: ${ref}` : ''}
  </p>

  <p>Your order ships within 7 to 10 business days. You will get tracking by email the moment it leaves our print partner.</p>

  <p style="margin: 1.8rem 0;">
    <a href="${BASE_URL}/store.html" style="display:inline-block;background:linear-gradient(135deg,#d4a957,#b08838);color:#07071a;text-decoration:none;padding:14px 30px;border-radius:6px;font-family:Georgia,serif;font-style:italic;font-weight:600;letter-spacing:0.04em;">Keep Shopping</a>
  </p>

  <p>Wear it with purpose.</p>

  <p style="margin-top: 1.8rem;">Dennis Nickens<br>AKA Spiritual Romeo<br>dennisnickens.com</p>

  <hr style="border:none;border-top:1px solid #e8e1cf;margin:2rem 0 1rem;">
  <p style="font-size: 12px; color: #888;">Reply to this email if anything looks off with your order. A real person is on the other end.</p>
</body></html>`;
}

/*
  Send the order confirmation. Never throw out to the webhook on a
  mail failure; the caller logs it and still returns 200 so Stripe
  does not retry a charge that already succeeded.

  Params: email, firstName, productTitle, variantLabel, quantity, printifyOrderId
*/
async function sendApparelConfirmation(opts) {
  const subject = 'Your Spiritual Romeo Apparel order is confirmed';
  const html = confirmationHtml(opts);
  return sendViaResend({ to: opts.email, subject, html });
}

module.exports = { sendApparelConfirmation };
