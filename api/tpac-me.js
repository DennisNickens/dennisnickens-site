/* ============================================================
   GET /api/tpac-me — session check + everything the app shell
   needs to boot: account, subscription status, bowler profile,
   bag, and recent series.
   ============================================================ */

'use strict';

const store = require('../lib/tpac-store.js');

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }

    const [profile, balls, series] = await Promise.all([
      store.kv.get('tpac:profile:' + user.uid),
      store.kv.get('tpac:balls:' + user.uid),
      store.kv.get('tpac:series:' + user.uid),
    ]);

    res.status(200).json({
      ok: true,
      uid: user.uid,
      email: user.email,
      subStatus: user.subStatus || 'none',
      subscribed: store.hasActiveSubscription(user),
      onboarded: !!user.onboarded,
      profile: profile || null,
      balls: balls || [],
      series: (series || []).slice(0, 10),
    });
  } catch (err) {
    console.error('tpac-me error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
