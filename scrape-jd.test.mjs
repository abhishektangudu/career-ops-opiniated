/**
 * scrape-jd.test.mjs — tests for scrape-jd.mjs's parse + error handling.
 *
 * Uses an injected fake `execFile`-shaped runner so no real browser is spawned:
 * one that emits valid `{url,title,text}` JSON (success), and one that exits
 * non-zero with a `{error,code}` stderr payload (must throw with that message).
 *
 * Run: node scrape-jd.test.mjs   (or via test-all.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeJobDescription } from './scrape-jd.mjs';

// A fake execFile: (file, args, opts, cb) => cb(error, stdout, stderr).
function fakeRunner({ error = null, stdout = '', stderr = '' }) {
  return (_file, _args, _opts, cb) => {
    // execFile invokes the callback asynchronously.
    process.nextTick(() => cb(error, stdout, stderr));
  };
}

test('scrapeJobDescription: parses valid extractor JSON', async () => {
  const payload = { url: 'https://example.com/job', title: 'Senior Engineer', text: 'a'.repeat(500) };
  const result = await scrapeJobDescription('https://example.com/job', fakeRunner({ stdout: JSON.stringify(payload) }));
  assert.deepEqual(result, payload);
});

test('scrapeJobDescription: falls back to the input url when JSON omits url', async () => {
  const result = await scrapeJobDescription(
    'https://input.example/job',
    fakeRunner({ stdout: JSON.stringify({ title: 'T', text: 'x' }) }),
  );
  assert.equal(result.url, 'https://input.example/job');
  assert.equal(result.title, 'T');
});

test('scrapeJobDescription: non-zero exit throws with {error,code} message', async () => {
  const err = Object.assign(new Error('Command failed'), { code: 1 });
  const stderr = JSON.stringify({ error: 'blocked private host', code: 'ssrf_block' });
  await assert.rejects(
    () => scrapeJobDescription('http://169.254.169.254/', fakeRunner({ error: err, stderr })),
    (e) => {
      assert.match(e.message, /blocked private host/);
      assert.match(e.message, /ssrf_block/);
      return true;
    },
  );
});

test('scrapeJobDescription: non-zero exit with plain stderr surfaces that text', async () => {
  const err = Object.assign(new Error('Command failed'), { code: 1 });
  await assert.rejects(
    () => scrapeJobDescription('https://x', fakeRunner({ error: err, stderr: 'boom not-json' })),
    /boom not-json/,
  );
});

test('scrapeJobDescription: unparseable stdout throws', async () => {
  await assert.rejects(
    () => scrapeJobDescription('https://x', fakeRunner({ stdout: 'not json at all' })),
    /Failed to parse extractor output/,
  );
});
