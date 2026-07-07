/* ============================================================
   ContestPayments — tournament money interface.
   ------------------------------------------------------------
   IMPORTANT: tournament entry fees and prize payouts do NOT run
   through Stripe, Venmo, or Cash App. All three prohibit
   paid-entry contests with cash prizes and will freeze accounts.
   The app therefore only KEEPS THE LEDGER: who owes in, who is
   owed out, and what the organizer keeps. The organizer collects
   and pays out by hand, exactly like a normal side pot.

   The interface below is the seam for a licensed skill-gaming
   processor later. Endpoints call ContestPayments methods, never
   KV directly, so swapping the implementation is one line.

   Ledger entry shape (tpac:ledger:{bid} is an array):
     { id, uid, handle, type: 'entry'|'payout'|'rake',
       amount, status: 'unpaid'|'paid', at }
   ============================================================ */

'use strict';

const { kv } = require('@vercel/kv');
const crypto = require('crypto');

function entryId() { return crypto.randomUUID(); }

/* ------------------------------------------------------------
   LedgerOnly: records balances and status. Moves no real money.
   ------------------------------------------------------------ */
const LedgerOnly = {
  name: 'ledger_only',

  async getLedger(bid) {
    return (await kv.get('tpac:ledger:' + bid)) || [];
  },

  async _save(bid, ledger) {
    await kv.set('tpac:ledger:' + bid, ledger);
  },

  /** Records that a bowler owes the entry fee in. */
  async recordEntry(bid, uid, handle, amount) {
    const ledger = await this.getLedger(bid);
    if (ledger.some(e => e.type === 'entry' && e.uid === uid)) return ledger;
    ledger.push({ id: entryId(), uid, handle, type: 'entry', amount, status: 'unpaid', at: new Date().toISOString() });
    await this._save(bid, ledger);
    return ledger;
  },

  /** Organizer toggles an entry between paid and unpaid. */
  async setEntryPaid(bid, ledgerEntryId, paid) {
    const ledger = await this.getLedger(bid);
    const entry = ledger.find(e => e.id === ledgerEntryId);
    if (entry) {
      entry.status = paid ? 'paid' : 'unpaid';
      await this._save(bid, ledger);
    }
    return ledger;
  },

  /** Records who is owed what when the bracket completes. */
  async recordPayouts(bid, payouts, rake, organizer) {
    const ledger = await this.getLedger(bid);
    if (ledger.some(e => e.type === 'payout' || e.type === 'rake')) return ledger; // idempotent
    const now = new Date().toISOString();
    for (const p of payouts) {
      ledger.push({ id: entryId(), uid: p.uid, handle: p.handle, type: 'payout', place: p.place, amount: p.amount, status: 'unpaid', at: now });
    }
    if (rake > 0 && organizer) {
      ledger.push({ id: entryId(), uid: organizer.uid, handle: organizer.handle, type: 'rake', amount: rake, status: 'unpaid', at: now });
    }
    await this._save(bid, ledger);
    return ledger;
  },
};

/* ------------------------------------------------------------
   CompliantProcessorAdapter — PLACEHOLDER, DO NOT WIRE UP YET.
   ------------------------------------------------------------
   When a licensed skill-gaming payment processor is chosen (and
   a gaming/contest lawyer has confirmed eligible states), give
   this object the same method signatures as LedgerOnly and have
   each method call the processor's API (escrow the entry on
   recordEntry, release winnings on recordPayouts) IN ADDITION
   to keeping the local ledger rows for display. Then flip the
   export below to CompliantProcessorAdapter. No other file
   changes are needed.
   ------------------------------------------------------------
const CompliantProcessorAdapter = {
  name: 'compliant_processor',
  async getLedger(bid) { ... },
  async recordEntry(bid, uid, handle, amount) { ... },
  async setEntryPaid(bid, ledgerEntryId, paid) { ... },
  async recordPayouts(bid, payouts, rake, organizer) { ... },
};
------------------------------------------------------------ */

const ContestPayments = LedgerOnly;

module.exports = { ContestPayments };
