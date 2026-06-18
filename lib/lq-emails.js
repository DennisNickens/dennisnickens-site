/* ============================================================
   Lovers Quest email templates and sender helpers.
   ------------------------------------------------------------
   All emails go through Resend (already wired for the Blueprint
   generator; reuses RESEND_API_KEY).

   Two emails today:
     1. sendAccessLink   — fires after successful purchase
     2. sendVerifyCode   — fires when the buyer is activating
                           a new device and needs to confirm it's them.
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

function accessLinkHtml({ firstName, token }) {
  const accessUrl = `${BASE_URL}/games/lovers-quest/?access=${encodeURIComponent(token)}`;
  const safeName = (firstName || 'friend').replace(/[<>&"']/g, '');
  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 580px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #b08838; letter-spacing: 0.04em; margin: 0 0 1.4rem;">Lovers Quest</p>

  <p>${safeName},</p>

  <p>Your copy of Lovers Quest is ready. Tap the button below to open the deck on your phone, then add it to your home screen so it lives where the rest of your apps live.</p>

  <p style="margin: 1.8rem 0;">
    <a href="${accessUrl}" style="display:inline-block;background:linear-gradient(135deg,#d4a957,#b08838);color:#07071a;text-decoration:none;padding:14px 30px;border-radius:6px;font-family:Georgia,serif;font-style:italic;font-weight:600;letter-spacing:0.04em;">Open Lovers Quest</a>
  </p>

  <p style="font-size: 14px; color: #555;">If the button doesn't work, paste this link into your browser:<br><span style="word-break:break-all;color:#b08838;">${accessUrl}</span></p>

  <p style="margin-top: 1.8rem;">A few things to know before you start.</p>

  <p>Your access is licensed to the email this message was sent to. You can use the deck on up to two devices (yours and your spouse's). If you ever activate a third, the oldest device drops off automatically.</p>

  <p>This is not a game in the entertainment sense. It is a tool. The cards open conversations your marriage has been waiting for. The work happens between you and your spouse. Treat it like that and it will pay you back.</p>

  <p>Welcome to the quest.</p>

  <p style="margin-top: 1.8rem;">Dennis Nickens<br>AKA Spiritual Romeo<br>dennisnickens.com</p>

  <hr style="border:none;border-top:1px solid #e8e1cf;margin:2rem 0 1rem;">
  <p style="font-size: 12px; color: #888;">Reply to this email if anything went wrong with the link or you have a question about the deck. Real person on the other end.</p>
</body></html>`;
}

function verifyCodeHtml({ firstName, code }) {
  const safeName = (firstName || 'friend').replace(/[<>&"']/g, '');
  const safeCode = String(code).replace(/[^0-9]/g, '');
  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 520px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #b08838; letter-spacing: 0.04em; margin: 0 0 1.4rem;">Lovers Quest</p>

  <p>${safeName},</p>

  <p>Someone is trying to activate Lovers Quest on a new device. If that was you, here is your verification code:</p>

  <p style="text-align:center;margin:2rem 0;">
    <span style="display:inline-block;font-family:'Courier New',monospace;font-size:32px;letter-spacing:0.4em;font-weight:700;color:#07071a;background:#f5f1e8;border:1px solid #d4a957;padding:14px 22px;border-radius:8px;">${safeCode}</span>
  </p>

  <p>Enter it on the device you are activating. The code expires in 15 minutes.</p>

  <p>If this was not you, you can safely ignore this email. Your license stays where it is.</p>

  <p style="margin-top: 1.8rem;">Dennis Nickens<br>AKA Spiritual Romeo</p>
</body></html>`;
}

async function sendAccessLink({ email, firstName, token }) {
  return await sendViaResend({
    to: email,
    subject: 'Your copy of Lovers Quest is ready',
    html: accessLinkHtml({ firstName, token })
  });
}

async function sendVerifyCode({ email, firstName, code }) {
  return await sendViaResend({
    to: email,
    subject: `Lovers Quest verification code: ${String(code).replace(/[^0-9]/g, '')}`,
    html: verifyCodeHtml({ firstName, code })
  });
}

module.exports = { sendAccessLink, sendVerifyCode };
