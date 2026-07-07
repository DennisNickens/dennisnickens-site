/* ============================================================
   /api/tpac-brackets — browse, create, join, and view brackets.
   ------------------------------------------------------------
   GET                 -> { ok, brackets } summaries
   GET ?bid=ID         -> { ok, bracket, matches, ledger } detail
                          (runs the lazy reconciler, so polling
                          this endpoint advances scheduled starts,
                          forfeits, rounds, and payouts)
   POST { action: 'create', ...opts }
   POST { action: 'join', bid }
   POST { action: 'mark-paid', bid, ledgerEntryId, paid } organizer only

   Money note: joining records the entry in the ledger only. The
   app never moves prize money; the organizer collects and pays
   out by hand. See lib/tpac-contest-payments.js.
   ============================================================ */

'use strict';

const store = require('../lib/tpac-store.js');
const engine = require('../lib/tpac-brackets.js');
const { ContestPayments } = require('../lib/tpac-contest-payments.js');

async function handleFor(user) {
  const profile = await store.kv.get('tpac:profile:' + user.uid);
  return (profile && profile.handle) || user.email.split('@')[0];
}

function summary(b) {
  return {
    id: b.id, name: b.name, size: b.size, entryFee: b.entryFee, format: b.format,
    entryType: b.entryType, scheduledStartUtc: b.scheduledStartUtc, status: b.status,
    entered: b.entries.length, organizerHandle: b.organizerHandle, champion: b.champion,
  };
}

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }
    if (!store.hasActiveSubscription(user)) { res.status(402).json({ ok: false, error: 'subscription_required' }); return; }

    if (req.method === 'GET') {
      const bid = String((req.query && req.query.bid) || '').trim();
      if (!bid) {
        const brackets = await engine.listBrackets();
        res.status(200).json({ ok: true, brackets: brackets.map(summary) });
        return;
      }
      const bracket = await engine.reconcileBracket(bid);
      if (!bracket) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const matches = [];
      for (const round of bracket.rounds) {
        for (const mid of round) {
          const m = await engine.getMatch(mid);
          if (m) matches.push(m);
        }
      }
      const ledger = await ContestPayments.getLedger(bid);
      res.status(200).json({ ok: true, bracket, matches, ledger, myUid: user.uid });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
    const body = store.parseBody(req);
    const action = String(body.action || '');

    if (action === 'create') {
      const handle = await handleFor(user);
      const made = engine.createBracketDoc(user, handle, body);
      if (made.error) { res.status(400).json({ ok: false, error: made.error }); return; }
      await engine.saveBracket(made.bracket);
      await store.kv.sadd('tpac:bracket-index', made.bracket.id);
      res.status(200).json({ ok: true, bracket: made.bracket });
      return;
    }

    if (action === 'join') {
      const bracket = await engine.getBracket(String(body.bid || ''));
      if (!bracket) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const handle = await handleFor(user);
      const profile = await store.kv.get('tpac:profile:' + user.uid);
      if (bracket.format === 'handicap' && !(profile && Number(profile.average) > 0)) {
        res.status(400).json({ ok: false, error: 'average_required_for_handicap' });
        return;
      }
      const joined = await engine.joinBracket(bracket, user, handle, profile ? profile.average : 0);
      if (joined.error) { res.status(400).json({ ok: false, error: joined.error }); return; }
      res.status(200).json({ ok: true, bracket: joined.bracket });
      return;
    }

    if (action === 'mark-paid') {
      const bracket = await engine.getBracket(String(body.bid || ''));
      if (!bracket) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (bracket.organizerUid !== user.uid) { res.status(403).json({ ok: false, error: 'organizer_only' }); return; }
      const ledger = await ContestPayments.setEntryPaid(bracket.id, String(body.ledgerEntryId || ''), !!body.paid);
      res.status(200).json({ ok: true, ledger });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('tpac-brackets error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
