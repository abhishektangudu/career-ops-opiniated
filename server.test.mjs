/**
 * server.test.mjs — tests for server.mjs security-critical helpers and the
 * /webhook auth routing (Slack HMAC verification, Telegram/direct-JSON auth,
 * and the eval-args regression that guards against the `--url` bug).
 *
 * Run: node server.test.mjs   (or via test-all.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import http from 'http';

// Set auth secrets BEFORE importing server.mjs so its module-level env reads see
// them. server.mjs only calls app.listen() when run directly, so importing it
// here just gives us the Express `app` and the exported helpers.
const SLACK_SECRET = 'slack-signing-secret-under-test';
const TELEGRAM_SECRET = 'telegram-webhook-secret-under-test';
const API_KEY = 'direct-api-key-under-test';
process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
process.env.TELEGRAM_WEBHOOK_SECRET = TELEGRAM_SECRET;
process.env.SERVER_API_KEY = API_KEY;
// Ensure the pipeline never actually runs (no GEMINI key => it would fail, but
// the auth guard rejects before that, and 200-path requests below are shaped so
// the pipeline runs in the background and is harmless / ignored).

const { app, verifySlackSignature, isSlackShapedBody, buildEvalArgs } = await import('./server.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slackSignature(rawBody, timestamp, secret) {
  const base = `v0:${timestamp}:${rawBody}`;
  return 'v0=' + crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
}

// Start the imported Express app on an ephemeral port for HTTP-level tests.
let server;
let baseUrl;
test.before(async () => {
  await new Promise((resolvePromise) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise();
    });
  });
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

function request(path, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolvePromise({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// (a) Slack HMAC verifier — pure function
// ---------------------------------------------------------------------------
test('verifySlackSignature: valid signature passes', () => {
  const now = 1_700_000_000_000; // fixed ms
  const ts = String(Math.floor(now / 1000));
  const raw = 'command=%2Fcareerops&text=https%3A%2F%2Fexample.com';
  const sig = slackSignature(raw, ts, SLACK_SECRET);
  assert.equal(verifySlackSignature(raw, ts, sig, SLACK_SECRET, now), true);
});

test('verifySlackSignature: tampered signature fails', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const raw = 'command=%2Fcareerops&text=x';
  const sig = slackSignature(raw, ts, SLACK_SECRET);
  const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
  assert.equal(verifySlackSignature(raw, ts, tampered, SLACK_SECRET, now), false);
});

test('verifySlackSignature: tampered body fails', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const sig = slackSignature('command=%2Fcareerops&text=x', ts, SLACK_SECRET);
  assert.equal(verifySlackSignature('command=%2Fcareerops&text=EVIL', ts, sig, SLACK_SECRET, now), false);
});

test('verifySlackSignature: stale timestamp (>5 min) fails', () => {
  const now = 1_700_000_000_000;
  const staleTs = String(Math.floor(now / 1000) - 6 * 60); // 6 minutes old
  const raw = 'command=%2Fcareerops&text=x';
  const sig = slackSignature(raw, staleTs, SLACK_SECRET);
  assert.equal(verifySlackSignature(raw, staleTs, sig, SLACK_SECRET, now), false);
});

test('verifySlackSignature: missing signature fails', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  assert.equal(verifySlackSignature('body', ts, undefined, SLACK_SECRET, now), false);
  assert.equal(verifySlackSignature('body', ts, '', SLACK_SECRET, now), false);
});

test('verifySlackSignature: unset secret => reject', () => {
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const raw = 'command=%2Fcareerops&text=x';
  // Even with an otherwise-valid-looking signature, no secret means reject.
  const sig = slackSignature(raw, ts, SLACK_SECRET);
  assert.equal(verifySlackSignature(raw, ts, sig, undefined, now), false);
  assert.equal(verifySlackSignature(raw, ts, sig, '', now), false);
});

// ---------------------------------------------------------------------------
// (b) isSlackShapedBody
// ---------------------------------------------------------------------------
test('isSlackShapedBody: slash command shape', () => {
  assert.equal(isSlackShapedBody({ command: '/careerops', response_url: 'https://x' }), true);
});
test('isSlackShapedBody: events-api type', () => {
  assert.equal(isSlackShapedBody({ type: 'event_callback' }), true);
});
test('isSlackShapedBody: non-slack shapes', () => {
  assert.equal(isSlackShapedBody({ url: 'https://x' }), false);
  assert.equal(isSlackShapedBody({ message: { chat: { id: 1 } } }), false);
  assert.equal(isSlackShapedBody(null), false);
});

// ---------------------------------------------------------------------------
// (c) eval-args regression — must NOT contain `--url`
// ---------------------------------------------------------------------------
test('buildEvalArgs: invokes evaluator WITHOUT --url', () => {
  const args = buildEvalArgs('/abs/gemini-eval.mjs', 'the scraped jd text');
  assert.deepEqual(args, ['/abs/gemini-eval.mjs', 'the scraped jd text']);
  assert.ok(!args.includes('--url'), 'eval args must not contain --url');
});

// ---------------------------------------------------------------------------
// HTTP-level auth routing (the bypass regression + Telegram/direct paths)
// ---------------------------------------------------------------------------
test('routing: Slack-shaped body WITHOUT a valid signature is rejected (bypass regression)', async () => {
  const raw = 'command=%2Fcareerops&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&text=https%3A%2F%2Fevil.example';
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: raw,
  });
  assert.equal(res.status, 401);
});

test('routing: Slack-shaped body WITH a valid signature is accepted', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = 'command=%2Fcareerops&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&text=hi';
  const sig = slackSignature(raw, ts, SLACK_SECRET);
  const res = await request('/webhook', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': ts,
      'X-Slack-Signature': sig,
    },
    body: raw,
  });
  // Auth passed => Slack ack path returns 200 (pipeline runs in background).
  assert.equal(res.status, 200);
});

test('routing: Telegram wrong secret rejected', async () => {
  const body = JSON.stringify({ message: { chat: { id: 123 }, text: 'https://example.com' } });
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'WRONG' },
    body,
  });
  assert.equal(res.status, 401);
});

test('routing: Telegram correct secret accepted', async () => {
  const body = JSON.stringify({ message: { chat: { id: 123 }, text: 'hi' } });
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET },
    body,
  });
  assert.equal(res.status, 200);
});

test('routing: direct-JSON wrong key rejected', async () => {
  const body = JSON.stringify({ url: 'https://example.com' });
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'WRONG' },
    body,
  });
  assert.equal(res.status, 401);
});

test('routing: direct-JSON correct key accepted', async () => {
  const body = JSON.stringify({ text: 'hi' });
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
    body,
  });
  // Accepted => direct path returns 202.
  assert.equal(res.status, 202);
});

test('routing: direct-JSON Bearer token accepted', async () => {
  const body = JSON.stringify({ text: 'hi' });
  const res = await request('/webhook', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body,
  });
  assert.equal(res.status, 202);
});
