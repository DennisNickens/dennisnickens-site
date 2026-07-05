/* ============================================================
   GET /api/sr-followup-cron
   ------------------------------------------------------------
   Vercel Cron target (see vercel.json: runs daily). Sweeps the
   follow-up queue and sends whatever is due:

     Day 3: "How to read your Blueprint"  (value + education)
     Day 7: "Your first growth step"      (actionable next step)

   Queue shape:
     sr:followup-queue           — KV set of pending sessionIds
     sr:followup:{sessionId}     — { email, firstName, archetype,
                                     growthArea, blueprintUrl,
                                     day3DueAt, day7DueAt,
                                     day3Sent, day7Sent }

   A session leaves the queue when both sends are done (or its
   record has expired). Failures stay queued and retry on the
   next sweep.

   Protected: requires the CRON_SECRET bearer token that Vercel
   attaches to cron invocations when the env var is set.
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const { sendDay3HowToRead, sendDay7GrowthStep } = require('../lib/sr-blueprint-emails.js');
const { FOLLOWUP_QUEUE_KEY } = require('../lib/sr-blueprint-pipeline.js');

const RECORD_TTL_SECONDS = 60 * 60 * 24 * 90;

module.exports = async (req, res) => {
  // Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron calls.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer ' + cronSecret) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  try {
    const sessionIds = (await kv.smembers(FOLLOWUP_QUEUE_KEY)) || [];
    const now = Date.now();
    const report = { swept: sessionIds.length, day3Sent: 0, day7Sent: 0, completed: 0, errors: 0 };

    for (const sessionId of sessionIds) {
      try {
        const rec = await kv.get('sr:followup:' + sessionId);
        if (!rec) {
          // Record expired or was removed; drop from the queue.
          await kv.srem(FOLLOWUP_QUEUE_KEY, sessionId);
          report.completed++;
          continue;
        }

        let changed = false;

        if (!rec.day3Sent && now >= rec.day3DueAt) {
          await sendDay3HowToRead({
            to: rec.email,
            firstName: rec.firstName,
            archetype: rec.archetype,
            blueprintUrl: rec.blueprintUrl,
          });
          rec.day3Sent = true;
          changed = true;
          report.day3Sent++;
        }

        if (!rec.day7Sent && now >= rec.day7DueAt) {
          await sendDay7GrowthStep({
            to: rec.email,
            firstName: rec.firstName,
            growthArea: rec.growthArea,
            blueprintUrl: rec.blueprintUrl,
          });
          rec.day7Sent = true;
          changed = true;
          report.day7Sent++;
        }

        if (changed) {
          await kv.set('sr:followup:' + sessionId, rec, { ex: RECORD_TTL_SECONDS });
        }

        if (rec.day3Sent && rec.day7Sent) {
          await kv.srem(FOLLOWUP_QUEUE_KEY, sessionId);
          report.completed++;
        }
      } catch (err) {
        // Leave it queued; it retries on the next sweep.
        console.error('[sr-followup-cron] send failed for ' + sessionId + ':', err.message);
        report.errors++;
      }
    }

    res.status(200).json({ ok: true, ...report });
  } catch (err) {
    console.error('sr-followup-cron error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
