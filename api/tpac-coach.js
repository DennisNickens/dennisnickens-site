/* ============================================================
   /api/tpac-coach — chat with Ace T. Johnson.
   ------------------------------------------------------------
   GET  -> { ok, messages } chat history (for rendering on load)
   POST { message } -> { ok, reply }

   Every POST injects the bowler's full profile, bag, and recent
   series behind Ace's persona, sends the running history, calls
   Claude, and persists both sides of the exchange so the
   conversation continues across days and weeks.

   Requires an active or trialing subscription and env
   ANTHROPIC_API_KEY. Model defaults to claude-opus-4-8;
   override with TPAC_ACE_MODEL.
   ============================================================ */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const store = require('../lib/tpac-store.js');
const { ACE_SYSTEM_PROMPT, buildBowlerContext } = require('../lib/tpac-ace.js');

const MODEL = process.env.TPAC_ACE_MODEL || 'claude-opus-4-8';
const HISTORY_LIMIT = 200;   // messages kept in KV per user
const CONTEXT_TURNS = 30;    // messages sent to the model per request

module.exports = async (req, res) => {
  store.setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const user = await store.getAuthedUser(req);
    if (!user) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return; }

    const chatKey = 'tpac:chat:' + user.uid;

    if (req.method === 'GET') {
      const history = (await store.kv.get(chatKey)) || [];
      res.status(200).json({ ok: true, messages: history });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
    if (!store.hasActiveSubscription(user)) { res.status(402).json({ ok: false, error: 'subscription_required' }); return; }

    const text = String(store.parseBody(req).message || '').trim();
    if (!text) { res.status(400).json({ ok: false, error: 'message_required' }); return; }
    if (text.length > 4000) { res.status(400).json({ ok: false, error: 'message_too_long' }); return; }

    const [profile, balls, series, history] = await Promise.all([
      store.kv.get('tpac:profile:' + user.uid),
      store.kv.get('tpac:balls:' + user.uid),
      store.kv.get('tpac:series:' + user.uid),
      store.kv.get(chatKey),
    ]);

    const priorMessages = (history || []).slice(-CONTEXT_TURNS).map(m => ({
      role: m.role === 'ace' ? 'assistant' : 'user',
      content: m.text,
    }));

    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: [
        // Static persona first with a cache breakpoint: identical bytes
        // for every user, so the prefix caches across the whole app.
        { type: 'text', text: ACE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        // Per-bowler context after the breakpoint so profile edits and
        // new series never invalidate the shared persona cache.
        { type: 'text', text: buildBowlerContext(profile, balls, series) },
      ],
      messages: priorMessages.concat([{ role: 'user', content: text }]),
    });

    if (response.stop_reason === 'refusal') {
      res.status(200).json({ ok: true, reply: 'Let us keep it on bowling, friend. Ask me about your game and I am all in.' });
      return;
    }

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    const now = new Date().toISOString();
    const updated = (history || []).concat([
      { role: 'user', text, at: now },
      { role: 'ace', text: reply, at: now },
    ]).slice(-HISTORY_LIMIT);
    await store.kv.set(chatKey, updated);

    res.status(200).json({ ok: true, reply });
  } catch (err) {
    console.error('tpac-coach error:', err);
    const status = err && err.status === 429 ? 429 : 500;
    res.status(status).json({ ok: false, error: status === 429 ? 'rate_limited' : 'server_error' });
  }
};
