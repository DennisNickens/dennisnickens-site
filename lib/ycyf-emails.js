/* ============================================================
   You Call Yourself A Friend email templates + sender helpers.
   ------------------------------------------------------------
   Mirrors lib/lq-emails.js. All emails go through Resend
   (reuses RESEND_API_KEY).

   Two emails:
     1. sendAccessLink   fires after a successful purchase
     2. sendVerifyCode   fires when the buyer activates a new device
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
  const accessUrl = `${BASE_URL}/games/friend/?access=${encodeURIComponent(token)}`;
  const safeName = (firstName || 'friend').replace(/[<>&"']/g, '');
  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 580px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #e8651a; letter-spacing: 0.02em; margin: 0 0 1.4rem;">You Call Yourself A Friend</p>

  <p>${safeName},</p>

  <p>Your copy of You Call Yourself A Friend is ready. Tap the button below to open it on your phone, then add it to your home screen so it lives where the rest of your apps live.</p>

  <p style="margin: 1.8rem 0;">
    <a href="${accessUrl}" style="display:inline-block;background:linear-gradient(135deg,#ff8b4a,#e8651a);color:#08111f;text-decoration:none;padding:14px 30px;border-radius:8px;font-family:Georgia,serif;font-weight:700;letter-spacing:0.02em;">Open the Game</a>
  </p>

  <p style="font-size: 14px; color: #555;">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all;color:#e8651a;">${accessUrl}</span></p>

  <p style="margin-top: 1.8rem;">A few things to know before you start.</p>

  <p>Your purchase licenses your device to host games. Pull people in by sharing the room code or QR. Whoever joins plays for free, no purchase needed. When the game ends, everyone disconnects and you start a fresh room for the next round.</p>

  <p>You can host from up to two of your own devices (your phone and a tablet, say). If you ever activate a third, the oldest one drops off automatically.</p>

  <p>Gather your people and find out who actually pays attention.</p>

  <p style="margin-top: 1.8rem;">Dennis Nickens<br>AKA Spiritual Romeo<br>dennisnickens.com</p>

  <hr style="border:none;border-top:1px solid #e8e1cf;margin:2rem 0 1rem;">
  <p style="font-size: 12px; color: #888;">Reply to this email if anything went wrong with the link or you have a question. Real person on the other end.</p>
</body></html>`;
}

function verifyCodeHtml({ firstName, code }) {
  const safeName = (firstName || 'friend').replace(/[<>&"']/g, '');
  const safeCode = String(code).replace(/[^0-9]/g, '');
  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 520px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #e8651a; letter-spacing: 0.02em; margin: 0 0 1.4rem;">You Call Yourself A Friend</p>

  <p>${safeName},</p>

  <p>Someone is activating You Call Yourself A Friend on a new device. If that was you, here is your verification code:</p>

  <p style="text-align:center;margin:2rem 0;">
    <span style="display:inline-block;font-family:'Courier New',monospace;font-size:32px;letter-spacing:0.4em;font-weight:700;color:#08111f;background:#fef9f1;border:1px solid #ff8b4a;padding:14px 22px;border-radius:8px;">${safeCode}</span>
  </p>

  <p>Enter it on the device you are activating. The code expires in 15 minutes.</p>

  <p>If this was not you, you can safely ignore this email. Your license stays where it is.</p>

  <p style="margin-top: 1.8rem;">Dennis Nickens<br>AKA Spiritual Romeo</p>
</body></html>`;
}

async function sendAccessLink({ email, firstName, token }) {
  return await sendViaResend({
    to: email,
    subject: 'Your copy of You Call Yourself A Friend is ready',
    html: accessLinkHtml({ firstName, token })
  });
}

async function sendVerifyCode({ email, firstName, code }) {
  return await sendViaResend({
    to: email,
    subject: `You Call Yourself A Friend verification code: ${String(code).replace(/[^0-9]/g, '')}`,
    html: verifyCodeHtml({ firstName, code })
  });
}

module.exports = { sendAccessLink, sendVerifyCode };
