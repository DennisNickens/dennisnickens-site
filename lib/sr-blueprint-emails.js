/* ============================================================
   Blueprint delivery email templates + sender helpers.
   ------------------------------------------------------------
   Mirrors lib/ycyf-emails.js. All emails go through Resend
   (reuses RESEND_API_KEY).

   Three emails:
     1. sendBlueprintReady  fires right after generation
     2. sendDay3HowToRead   value + education, 3 days later
     3. sendDay7GrowthStep  actionable next step, 7 days later

   TEST RULE: if SR_BLUEPRINT_TEST_EMAIL is set, every send is
   redirected there instead of the real recipient. Use this for
   all pipeline testing so no real customer (or the Franklins)
   gets a test email.
   ============================================================ */

'use strict';

const FROM = 'Dennis Nickens <dennis@dennisnickens.com>';
const REPLY_TO = 'admin@dennisnickens.com';
const BASE_URL = process.env.PUBLIC_SITE_URL || 'https://dennisnickens.com';

async function sendViaResend({ to, subject, html }) {
  const testOverride = process.env.SR_BLUEPRINT_TEST_EMAIL;
  const recipient = testOverride || to;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [recipient],
      bcc: ['admin@dennisnickens.com'],
      subject: testOverride ? '[TEST -> ' + to + '] ' + subject : subject,
      html,
      reply_to: REPLY_TO,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend send failed: ${response.status} ${errText}`);
  }
  return await response.json();
}

function safe(s) {
  return String(s || '').replace(/[<>&"']/g, '');
}

function shell(inner) {
  return `<!doctype html>
<html><body style="font-family: Georgia, serif; line-height: 1.7; color: #1a1633; max-width: 580px; margin: 0 auto; padding: 28px 22px;">
  <p style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; color: #7C3AED; letter-spacing: 0.04em; margin: 0 0 1.4rem;">THE BLUEPRINT</p>
  ${inner}
  <p style="margin-top: 2.2rem;">Dennis Nickens<br><span style="font-size:14px;color:#555;">Communication &amp; Behavior Consultant | dennisnickens.com</span></p>
</body></html>`;
}

function button(url, label) {
  return `<p style="margin: 1.8rem 0;">
    <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#6D28D9);color:#ffffff;text-decoration:none;padding:14px 30px;border-radius:8px;font-family:Georgia,serif;font-weight:700;letter-spacing:0.02em;">${label}</a>
  </p>
  <p style="font-size: 14px; color: #555;">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all;color:#7C3AED;">${url}</span></p>`;
}

// ------------------------------------------------------------
// 1. Immediate: your Blueprint is ready
// ------------------------------------------------------------

// Linked Pair primaries only: the invite block with their person's
// code and join link. Solo customers never get this section.
function pairInviteSection({ code, joinUrl, secondaryFirstName }) {
  const who = safe(secondaryFirstName) || 'your partner';
  return `
  <hr style="border:none;border-top:1px solid #e2ddf5;margin:2rem 0;">
  <p><strong>Now bring in ${who}.</strong></p>
  <p>You bought the Linked Pair Blueprint. Send them this to take their own assessment. When they finish, we send you both the Combined Report.</p>
  <p style="margin:1.4rem 0 .4rem;">Their invite code:</p>
  <p style="margin:0 0 1.2rem;"><span style="display:inline-block;background:#f4f1fb;border:1px solid #d9d2f0;border-radius:8px;padding:12px 22px;font-family:Courier,monospace;font-size:20px;font-weight:700;letter-spacing:.18em;color:#4c1d95;">${safe(code)}</span></p>
  <p>Their link:<br><a href="${joinUrl}" style="color:#7C3AED;word-break:break-all;">${joinUrl}</a></p>
  <p>The code stays active for 30 days. If they need more time, reply and we can extend it.</p>`;
}

function sendBlueprintReady({ to, firstName, archetype, srCode, blueprintUrl, pairInvite }) {
  const name = safe(firstName) || 'friend';
  const html = shell(`
  <p>${name},</p>
  <p>Your Blueprint is ready.</p>
  <p>You are <strong>${safe(archetype)}</strong>, and your SR Code is <strong>${safe(srCode)}</strong>. That combination is yours. The full read on what it means, where it serves you, and where it works against you is waiting behind this button.</p>
  ${button(blueprintUrl, 'Open Your Blueprint')}
  <p>One suggestion before you dive in: do not skim it. Set aside twenty quiet minutes and read it the way you would read a letter written specifically about you, because that is what it is.</p>
  <p>I will follow up in a few days with how to get the most out of it.</p>
  ${pairInvite && pairInvite.code ? pairInviteSection(pairInvite) : ''}`);
  return sendViaResend({ to, subject: 'Your Blueprint is ready', html });
}

// ------------------------------------------------------------
// 2. Day 3: how to read your Blueprint
// ------------------------------------------------------------

function sendDay3HowToRead({ to, firstName, archetype, blueprintUrl }) {
  const name = safe(firstName) || 'friend';
  const html = shell(`
  <p>${name},</p>
  <p>You have had your Blueprint for a few days now. Here is how to actually use it, because a Blueprint you read once and file away builds nothing.</p>
  <p><strong>First, separate the mirror from the map.</strong> The percentage breakdowns are the mirror: they show you what already is. The recommendations and growth areas are the map: they show you what to do about it. Most people stare at the mirror and never open the map.</p>
  <p><strong>Second, check the mirror against your real life.</strong> Take your ${safe(archetype)} profile and hold it up against your last disagreement, your last big decision, your last week at work. Where did your wiring serve you? Where did it run the show without asking you first?</p>
  <p><strong>Third, share one section with one person.</strong> Pick someone who knows you well and show them your Connection Currency section. Ask them one question: does this match how I actually treat you? Their answer will teach you more than a second read-through will.</p>
  ${button(blueprintUrl, 'Reread Your Blueprint')}
  <p>In a few more days I will send you the first concrete step to build from it.</p>`);
  return sendViaResend({ to, subject: 'How to read your Blueprint', html });
}

// ------------------------------------------------------------
// 3. Day 7: your first growth step
// ------------------------------------------------------------

function sendDay7GrowthStep({ to, firstName, growthArea, blueprintUrl }) {
  const name = safe(firstName) || 'friend';
  const area = safe(growthArea) || 'your first growth area';
  const html = shell(`
  <p>${name},</p>
  <p>A week in. Time to build something.</p>
  <p>Your Blueprint names your growth areas, and the first one on your list is <strong>${area}</strong>. Here is your assignment, and it is smaller than you think it should be:</p>
  <p><strong>Pick one relationship and one week.</strong> For the next seven days, in that one relationship, practice that one growth area on purpose. Not everywhere. Not with everyone. One person, one week, one behavior.</p>
  <p>Why so small? Because wiring does not change through intention, it changes through repetition, and repetition only happens when the target is small enough to hit every day.</p>
  <p>At the end of the week, ask yourself one question: did that relationship feel any different? If the answer is yes, you just proved to yourself the Blueprint is not a document. It is a starting point.</p>
  ${button(blueprintUrl, 'Open Your Blueprint')}
  <p>If you want to go deeper than a document can take you, reply to this email. That is what I do.</p>`);
  return sendViaResend({ to, subject: 'Your first growth step', html });
}

module.exports = { sendBlueprintReady, sendDay3HowToRead, sendDay7GrowthStep, sendViaResend };
