/**
 * gemini-eval.test.mjs — CLI arg-parsing guards for gemini-eval.mjs
 *
 * Covers the --url flag validation only (no network / no Gemini call):
 *   - `--url` with no following value must exit non-zero
 *   - `--url --no-save` must NOT swallow the next flag as the URL value
 *   - a normal `--url <value>` with no JD text still exits on the
 *     "no JD provided" guard (i.e. parsing accepted the URL and moved on)
 *
 * These guard paths run entirely in argv parsing, before any API key check
 * or Gemini request, so the test is fast and offline.
 *
 * Run: node gemini-eval.test.mjs
 */

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'gemini-eval.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function run(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    // Keep the run offline/deterministic regardless of local .env state.
    env: { ...process.env, GEMINI_API_KEY: '' },
  });
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('gemini-eval.mjs — --url flag validation');

// (a) --url with no value → error exit
{
  const r = run(['--url']);
  check('--url with no value exits non-zero', r.status !== 0, `status=${r.status}`);
  check(
    '--url with no value prints the value-required error',
    /--url requires a value/.test(r.stderr || ''),
    JSON.stringify(r.stderr),
  );
}

// (b) --url immediately followed by another flag must not consume that flag
{
  const r = run(['--url', '--no-save', 'some jd text']);
  check('--url --no-save does not swallow the flag (exits non-zero)', r.status !== 0, `status=${r.status}`);
  check(
    '--url --no-save prints the value-required error',
    /--url requires a value/.test(r.stderr || ''),
    JSON.stringify(r.stderr),
  );
}

// (c) valid --url but no JD text → falls through to the "no JD" guard,
//     proving the URL was parsed and consumed (not treated as JD text).
{
  const r = run(['--url', 'https://boards.example.com/jobs/1']);
  check('valid --url with no JD exits non-zero', r.status !== 0, `status=${r.status}`);
  check(
    'valid --url with no JD hits the "No Job Description" guard (URL not treated as JD)',
    /No Job Description provided/.test(r.stderr || ''),
    JSON.stringify(r.stderr),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
