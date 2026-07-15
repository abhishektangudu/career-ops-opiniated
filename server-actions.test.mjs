/**
 * server-actions.test.mjs — tests for the Slack co-pilot's server-side action
 * dispatcher (Phase 3, Task 12).
 *
 * Covers:
 *   (a) envelope parsing mirrors the client parser (complete envelopes,
 *       code-fence skip, smart-quote / trailing-comma tolerance),
 *   (b) the read-mostly allowlist (allowed ids run their runner; every other id
 *       returns the "web app only" no-op),
 *   (c) the setStatus confirm-gate flow (first call → confirm prompt; a "yes"
 *       follow-up → executes via the injected runner).
 *
 * NO real Slack/Gemini/set-status calls: all runners are injected/stubbed.
 *
 * Run: node server-actions.test.mjs   (or via test-all.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEnvelopes,
  normalizeJson,
  stripEnvelopes,
  dispatchAction,
  dispatchEnvelopes,
  hasPending,
  isAffirmative,
  confirmPending,
  clearPending,
  canonicalizeStatus,
  ALLOWED_ACTIONS,
  CANON_STATUS,
  PENDING_TTL_MS,
} from './server-actions.mjs';

// ---------------------------------------------------------------------------
// (a) Envelope parsing
// ---------------------------------------------------------------------------
test('parseEnvelopes: extracts a complete envelope with its id and args', () => {
  const { complete, hidePartialFrom } = parseEnvelopes('Sure, on it. <<act:evaluate {"url":"https://x.com/job"}>> done');
  assert.equal(complete.length, 1);
  assert.equal(complete[0].id, 'evaluate');
  assert.equal(complete[0].argsJson, '{"url":"https://x.com/job"}');
  assert.equal(hidePartialFrom, -1);
});

test('parseEnvelopes: skips envelopes inside a fenced code block', () => {
  const text = [
    'Here is the syntax:',
    '```',
    '<<act:evaluate {"url":"https://nope"}>>',
    '```',
    'And a real one: <<act:generatePdf {"n":"42"}>>',
  ].join('\n');
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 1, 'only the non-fenced envelope should count');
  assert.equal(complete[0].id, 'generatePdf');
});

test('parseEnvelopes: an unterminated envelope is flagged as partial, not complete', () => {
  const { complete, hidePartialFrom } = parseEnvelopes('working on it <<act:evaluate {"url":"https://x');
  assert.equal(complete.length, 0);
  assert.ok(hidePartialFrom > -1);
});

test('normalizeJson: converts smart quotes and drops a trailing comma', () => {
  const raw = '{\u201cn\u201d:\u201c42\u201d,}';
  const normalized = normalizeJson(raw);
  assert.deepEqual(JSON.parse(normalized), { n: '42' });
});

test('stripEnvelopes: hides envelopes from the user-visible text', () => {
  const visible = stripEnvelopes('Evaluating that now.\n<<act:evaluate {"url":"https://x"}>>\nHang tight!');
  assert.ok(!visible.includes('<<act:'));
  assert.match(visible, /Evaluating that now\./);
  assert.match(visible, /Hang tight!/);
});

test('dispatchEnvelopes: tolerates smart-quoted args (parses via normalizeJson)', async () => {
  let seen = null;
  const { results } = await dispatchEnvelopes(
    'ok <<act:evaluate {\u201curl\u201d:\u201chttps://x.com/j\u201d}>>',
    { runEvaluate: async (a) => { seen = a; return { text: 'started' }; } },
  );
  assert.deepEqual(seen, { url: 'https://x.com/j' });
  assert.equal(results[0].text, 'started');
});

test('dispatchEnvelopes: skips a malformed-JSON envelope', async () => {
  const { results } = await dispatchEnvelopes(
    'hmm <<act:evaluate {not json at all}>>',
    { runEvaluate: async () => { throw new Error('should not run'); } },
  );
  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// (b) Read-mostly allowlist
// ---------------------------------------------------------------------------
test('allowlist is as designed', () => {
  assert.ok(ALLOWED_ACTIONS.has('evaluate'));
  assert.ok(ALLOWED_ACTIONS.has('generatePdf'));
  assert.ok(ALLOWED_ACTIONS.has('setStatus'));
  assert.ok(!ALLOWED_ACTIONS.has('navigate'));
});

test('dispatchAction: evaluate runs its injected runner with a valid URL', async () => {
  let called = null;
  const res = await dispatchAction('evaluate', { url: 'https://x.com/job' }, {
    runEvaluate: async (a) => { called = a; return { text: 'evaluating' }; },
  });
  assert.deepEqual(called, { url: 'https://x.com/job' });
  assert.equal(res.text, 'evaluating');
});

test('dispatchAction: evaluate rejects a non-URL argument', async () => {
  const res = await dispatchAction('evaluate', { url: 'not-a-url' }, {
    runEvaluate: async () => { throw new Error('should not run'); },
  });
  assert.match(res.text, /real posting URL/i);
});

test('dispatchAction: generatePdf runs its injected runner with #n', async () => {
  let called = null;
  const res = await dispatchAction('generatePdf', { n: '42' }, {
    runGeneratePdf: async (a) => { called = a; return { text: 'pdf ready' }; },
  });
  assert.deepEqual(called, { n: '42' });
  assert.equal(res.text, 'pdf ready');
});

test('dispatchAction: web-only actions return the no-op reply and never run', async () => {
  for (const id of ['navigate', 'filterPipeline', 'apply', 'setProfile', 'setPortals', 'evaluateCompany', 'research', 'setApplyField']) {
    const res = await dispatchAction(id, { anything: true }, {});
    assert.match(res.text, /only available in the web app/i, `${id} should be a no-op`);
  }
});

test('dispatchAction: unknown action id returns the no-op reply', async () => {
  const res = await dispatchAction('totallyMadeUp', {}, {});
  assert.match(res.text, /only available in the web app/i);
});

// ---------------------------------------------------------------------------
// (c) setStatus confirm-gate flow
// ---------------------------------------------------------------------------
test('setStatus: first call prompts to confirm and does NOT execute', async () => {
  const pending = new Map();
  let ran = false;
  const ctx = {
    pending,
    threadKey: 'C1:T1',
    runSetStatus: async () => { ran = true; return { text: 'written' }; },
  };
  const res = await dispatchAction('setStatus', { n: '42', status: 'Applied' }, ctx);
  assert.equal(res.confirm, true);
  assert.match(res.text, /reply `yes` to confirm/i);
  assert.equal(ran, false, 'must not write on the first call');
  assert.ok(hasPending('C1:T1', ctx), 'a pending action should be stored');
});

test('setStatus: a "yes" follow-up executes the injected runner and clears pending', async () => {
  const pending = new Map();
  let ranWith = null;
  const ctx = {
    pending,
    threadKey: 'C1:T1',
    runSetStatus: async (args) => { ranWith = args; return { text: `set #${args.n} to ${args.status}` }; },
  };
  await dispatchAction('setStatus', { n: '42', status: 'Applied' }, ctx);
  assert.ok(isAffirmative('yes'));
  const result = await confirmPending('C1:T1', ctx);
  assert.ok(result.executed);
  assert.deepEqual(ranWith, { n: '42', status: 'Applied' });
  assert.equal(result.text, 'set #42 to Applied');
  assert.ok(!hasPending('C1:T1', ctx), 'pending should be cleared after execution');
});

test('confirmPending: returns null when nothing is pending for the thread', async () => {
  const ctx = { pending: new Map(), threadKey: 'C9:T9' };
  const result = await confirmPending('C9:T9', ctx);
  assert.equal(result, null);
});

test('clearPending: drops a pending action (e.g. the user declined)', async () => {
  const pending = new Map();
  const ctx = { pending, threadKey: 'C2:T2', runSetStatus: async () => ({ text: 'x' }) };
  await dispatchAction('setStatus', { n: '7', status: 'Rejected' }, ctx);
  assert.ok(hasPending('C2:T2', ctx));
  clearPending('C2:T2', ctx);
  assert.ok(!hasPending('C2:T2', ctx));
});

test('setStatus: confirm gate is per-thread (isolated pending maps)', async () => {
  const pending = new Map();
  const ctxA = { pending, threadKey: 'A:1', runSetStatus: async () => ({ text: 'A done' }) };
  const ctxB = { pending, threadKey: 'B:1', runSetStatus: async () => ({ text: 'B done' }) };
  await dispatchAction('setStatus', { n: '1', status: 'Applied' }, ctxA);
  assert.ok(hasPending('A:1', ctxA));
  assert.ok(!hasPending('B:1', ctxB), 'thread B must not see thread A pending');
});

// --- numeric-n + status validation (review finding 3) ---------------------
test('canonicalizeStatus: case-insensitive match, null for unknown', () => {
  assert.equal(canonicalizeStatus('applied'), 'Applied');
  assert.equal(canonicalizeStatus('  OFFER '), 'Offer');
  assert.equal(canonicalizeStatus('skip'), 'SKIP');
  assert.equal(canonicalizeStatus('bogus'), null);
  assert.equal(canonicalizeStatus(undefined), null);
  assert.ok(CANON_STATUS.includes('Applied'));
});

test('setStatus: rejects a non-numeric n (would be a company name to set-status.mjs) and stashes nothing', async () => {
  const ctx = { pending: new Map(), threadKey: 'C4:T4' };
  const res = await dispatchAction('setStatus', { n: 'Acme', status: 'Applied' }, ctx);
  assert.match(res.text, /numeric application number/i);
  assert.notEqual(res.confirm, true);
  assert.ok(!hasPending('C4:T4', ctx), 'nothing should be stashed for a bad n');
});

test('setStatus: rejects an invalid status BEFORE stashing', async () => {
  const ctx = { pending: new Map(), threadKey: 'C5:T5' };
  const res = await dispatchAction('setStatus', { n: '42', status: 'YOLO' }, ctx);
  assert.match(res.text, /isn't a valid status/i);
  assert.ok(!hasPending('C5:T5', ctx));
});

test('setStatus: canonicalizes the status it stashes (applied → Applied)', async () => {
  const pending = new Map();
  let ranWith = null;
  const ctx = { pending, threadKey: 'C6:T6', runSetStatus: async (a) => { ranWith = a; return { text: 'ok' }; } };
  const res = await dispatchAction('setStatus', { n: '42', status: 'applied' }, ctx);
  assert.equal(res.confirm, true);
  assert.match(res.text, /\*Applied\*/);
  await confirmPending('C6:T6', ctx);
  assert.deepEqual(ranWith, { n: '42', status: 'Applied' });
});

// --- user binding (review finding 1) --------------------------------------
test('setStatus: a DIFFERENT user cannot confirm (mismatch, pending left intact)', async () => {
  const pending = new Map();
  let ran = false;
  const requester = { pending, threadKey: 'C7:T7', userId: 'UAAA', teamId: 'TEAM1', runSetStatus: async () => { ran = true; return { text: 'written' }; } };
  await dispatchAction('setStatus', { n: '42', status: 'Applied' }, requester);

  // Another user in the same thread replies "yes".
  const intruder = { pending, threadKey: 'C7:T7', userId: 'UBBB', teamId: 'TEAM1', runSetStatus: async () => { ran = true; return { text: 'written' }; } };
  const result = await confirmPending('C7:T7', intruder);
  assert.deepEqual(result, { mismatch: true });
  assert.equal(ran, false, 'intruder must NOT trigger the write');
  assert.ok(hasPending('C7:T7', requester), 'pending stays for the rightful user');

  // The original requester can still confirm.
  const done = await confirmPending('C7:T7', requester);
  assert.ok(done.executed);
  assert.equal(ran, true);
});

test('setStatus: a different team cannot confirm even with a matching user id', async () => {
  const pending = new Map();
  let ran = false;
  const requester = { pending, threadKey: 'C7b:T7b', userId: 'UAAA', teamId: 'TEAM1', runSetStatus: async () => { ran = true; return { text: 'x' }; } };
  await dispatchAction('setStatus', { n: '9', status: 'Offer' }, requester);
  const otherTeam = { pending, threadKey: 'C7b:T7b', userId: 'UAAA', teamId: 'TEAM2', runSetStatus: async () => { ran = true; return { text: 'x' }; } };
  const result = await confirmPending('C7b:T7b', otherTeam);
  assert.deepEqual(result, { mismatch: true });
  assert.equal(ran, false);
});

// --- clobber refusal (review finding 2b) ----------------------------------
test('setStatus: a second pending request in the same thread does NOT clobber the first', async () => {
  const pending = new Map();
  const ctx = { pending, threadKey: 'C8:T8', userId: 'UAAA', runSetStatus: async (a) => ({ text: `did ${a.n}=${a.status}` }) };
  await dispatchAction('setStatus', { n: '42', status: 'Applied' }, ctx);
  const second = await dispatchAction('setStatus', { n: '99', status: 'Rejected' }, ctx);
  assert.match(second.text, /already have a pending confirmation/i);
  assert.notEqual(second.confirm, true);
  // The ORIGINAL action (#42 Applied) must still be the one that executes.
  const done = await confirmPending('C8:T8', ctx);
  assert.equal(done.text, 'did 42=Applied');
});

// --- TTL expiry (review finding 2a) ---------------------------------------
test('setStatus: an expired pending action is not confirmable and frees the thread', async () => {
  const pending = new Map();
  const ctx = { pending, threadKey: 'C10:T10', userId: 'UAAA', runSetStatus: async () => ({ text: 'written' }) };
  await dispatchAction('setStatus', { n: '42', status: 'Applied' }, ctx);
  // Backdate the stored timestamp beyond the TTL.
  const rec = pending.get('C10:T10');
  rec.at = Date.now() - PENDING_TTL_MS - 1000;
  assert.ok(!hasPending('C10:T10', ctx), 'expired pending should read as absent');
  const result = await confirmPending('C10:T10', ctx);
  assert.equal(result, null, 'expired pending must not execute');
  assert.ok(!pending.has('C10:T10'), 'expired pending should be evicted');

  // After expiry, a fresh request is accepted (thread is free, no clobber msg).
  const fresh = await dispatchAction('setStatus', { n: '7', status: 'Offer' }, ctx);
  assert.equal(fresh.confirm, true);
});

test('isAffirmative: accepts common yeses, rejects everything else', () => {
  for (const y of ['yes', 'Yes', 'YES', 'y', 'confirm', 'yep', 'ok', 'okay!', 'yeah.']) {
    assert.ok(isAffirmative(y), `"${y}" should be affirmative`);
  }
  for (const n of ['no', 'nope', 'later', 'why?', '', undefined, 'mark it applied']) {
    assert.ok(!isAffirmative(n), `"${n}" should NOT be affirmative`);
  }
});

test('setStatus: missing args are rejected before anything is stashed', async () => {
  const pending = new Map();
  const ctx = { pending, threadKey: 'C3:T3' };
  const res = await dispatchAction('setStatus', { n: '', status: '' }, ctx);
  assert.match(res.text, /numeric application number/i);
  assert.ok(!hasPending('C3:T3', ctx));
});
