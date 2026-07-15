#!/usr/bin/env node
/**
 * verify-google-access.mjs — live "verify before save" CLI (fork-only).
 *
 * Two actions, selected by argv:
 *   (default)   verify — reads target values from stdin (preferred) or a
 *               --json-file <path>, runs a tiny live round-trip against each
 *               provided target, prints a per-target { ok, error } JSON report.
 *   --sm-write  Secret Manager write-through — reads { geminiApiKey } from stdin
 *               and writes it as a new Secret Manager version (guarded by
 *               SECRET_MANAGER_SECRET). This is a SEPARATE, POST-persist step so
 *               a secret version is never added before the local save succeeds.
 *
 * This is what the web verify route + the POST-before-persist path SPAWN — the
 * web workspace has no Google deps, so all @google/generative-ai + googleapis
 * access lives here (ROOT deps), under Application Default Credentials (ADC),
 * reusing the getGoogleClients() pattern from sync-google.mjs.
 *
 * SECURITY:
 *   - The Gemini key is NEVER accepted on argv (which leaks via shell history /
 *     process listing): it must arrive on stdin (or, for non-secret payloads,
 *     via --json-file). A --json '{...geminiApiKey...}' is rejected.
 *   - Error messages are REDACTED of the submitted key before being returned or
 *     logged (an SDK/fetch error could otherwise echo the key).
 *
 * Exit code is 0 on a completed run (the report body carries per-target
 * success/failure); a non-zero exit is reserved for a usage/parse error and is
 * treated by callers as verification-unavailable.
 */

import { readFileSync } from 'fs';
import { getGoogleClients } from './sync-google.mjs';

const TARGET_KEYS = [
  'geminiApiKey',
  'geminiModel',
  'googleSpreadsheetId',
  'googleDriveFolderId',
  'googleStorageBucket',
];

// Keys whose value is a secret and must never appear on argv / in error output.
const SECRET_KEYS = ['geminiApiKey'];

/**
 * Read the input targets. Precedence:
 *   1. stdin (preferred — safe for secrets)
 *   2. --json-file <path> (a file, not argv — safe for secrets)
 *   3. --json <str> (argv — REJECTED if it carries a secret key)
 */
async function readTargets(argv) {
  // stdin first (only when piped, i.e. not a TTY).
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) return JSON.parse(raw);
  }

  const fileIdx = argv.indexOf('--json-file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    return JSON.parse(readFileSync(argv[fileIdx + 1], 'utf-8'));
  }

  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx !== -1 && argv[jsonIdx + 1]) {
    const parsed = JSON.parse(argv[jsonIdx + 1]);
    if (parsed && typeof parsed === 'object') {
      for (const k of SECRET_KEYS) {
        if (parsed[k]) {
          throw new Error(
            `refusing --json with a secret field (${k}); pass secrets on stdin or via --json-file`,
          );
        }
      }
    }
    return parsed;
  }

  return {};
}

/**
 * Redact any exact occurrence of a known sensitive value from a string, then
 * truncate. Sensitive values shorter than 8 chars are ignored (too likely to
 * cause spurious matches; a real key is far longer).
 */
export function redactSensitive(text, sensitive = []) {
  let out = String(text);
  for (const s of sensitive) {
    if (typeof s === 'string' && s.length >= 8) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

function shortError(err, sensitive = []) {
  const msg = err && err.message ? err.message : String(err);
  // Redact the key BEFORE truncating so a leaked key can't survive the slice.
  return redactSensitive(msg, sensitive).slice(0, 300);
}

/**
 * Verify a Gemini API key with a minimal live call. Uses generateContent with a
 * 1-token-ish prompt; on quota/other transient issues the error is surfaced.
 * Injectable runner (for tests) via opts.geminiRunner.
 */
async function verifyGemini(apiKey, modelName, opts = {}) {
  if (opts.geminiRunner) return opts.geminiRunner(apiKey, modelName);
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName || 'gemini-2.5-flash' });
  await model.generateContent('ping');
}

/**
 * Run all verifications for the provided targets. Only targets that are present
 * (non-empty) are checked; absent targets are omitted from the report.
 *
 * `opts` allows dependency injection for tests:
 *   - opts.getClients   → replaces getGoogleClients()
 *   - opts.geminiRunner → replaces the live Gemini call
 */
export async function runVerification(targets, opts = {}) {
  const results = {};
  const provided = {};
  for (const k of TARGET_KEYS) {
    const v = targets[k];
    if (typeof v === 'string' && v.trim()) provided[k] = v.trim();
  }

  // Values to scrub from every error string (the key only — IDs aren't secret).
  const sensitive = SECRET_KEYS.map((k) => provided[k]).filter(Boolean);

  // Gemini
  if (provided.geminiApiKey) {
    try {
      await verifyGemini(provided.geminiApiKey, provided.geminiModel, opts);
      results.geminiApiKey = { ok: true };
    } catch (err) {
      results.geminiApiKey = { ok: false, error: shortError(err, sensitive) };
    }
  }

  // Google clients are only needed if any Google target is present.
  const needsGoogle = provided.googleSpreadsheetId || provided.googleDriveFolderId || provided.googleStorageBucket;
  let clients = null;
  if (needsGoogle) {
    try {
      clients = opts.getClients ? await opts.getClients() : await getGoogleClients();
    } catch (err) {
      // ADC / googleapis unavailable → mark every Google target as failed.
      const e = { ok: false, error: shortError(err, sensitive) };
      if (provided.googleSpreadsheetId) results.googleSpreadsheetId = e;
      if (provided.googleDriveFolderId) results.googleDriveFolderId = e;
      if (provided.googleStorageBucket) results.googleStorageBucket = e;
    }
  }

  if (clients) {
    if (provided.googleSpreadsheetId) {
      try {
        await clients.sheets.spreadsheets.get({ spreadsheetId: provided.googleSpreadsheetId, fields: 'spreadsheetId' });
        results.googleSpreadsheetId = { ok: true };
      } catch (err) {
        results.googleSpreadsheetId = { ok: false, error: shortError(err, sensitive) };
      }
    }
    if (provided.googleDriveFolderId) {
      try {
        await clients.drive.files.get({ fileId: provided.googleDriveFolderId, fields: 'id', supportsAllDrives: true });
        results.googleDriveFolderId = { ok: true };
      } catch (err) {
        results.googleDriveFolderId = { ok: false, error: shortError(err, sensitive) };
      }
    }
    if (provided.googleStorageBucket) {
      try {
        await clients.storage.buckets.get({ bucket: provided.googleStorageBucket });
        results.googleStorageBucket = { ok: true };
      } catch (err) {
        results.googleStorageBucket = { ok: false, error: shortError(err, sensitive) };
      }
    }
  }

  return results;
}

/**
 * Optional: write the Gemini key through to GCP Secret Manager so a future
 * deploy / cold start can source it. Guarded by SECRET_MANAGER_SECRET
 * (`projects/<p>/secrets/<name>`); off by default. Failures are surfaced but
 * NON-FATAL (they never block the local file write, which the caller owns).
 *
 * Invoked as a SEPARATE, POST-persist step (see main's --sm-write action) so a
 * secret version is never added before the local save succeeds.
 *
 * Injectable via opts.addVersion for tests.
 */
export async function maybeWriteSecretManager(apiKey, opts = {}) {
  const secret = (opts.secretName ?? process.env.SECRET_MANAGER_SECRET);
  if (!secret || !secret.trim()) return null; // disabled → skip silently
  if (!apiKey || !apiKey.trim()) return null;
  const sensitive = [apiKey.trim()];
  try {
    let addVersion = opts.addVersion;
    if (!addVersion) {
      const { google } = await import('googleapis');
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const sm = google.secretmanager({ version: 'v1', auth });
      addVersion = (params) => sm.projects.secrets.addVersion(params);
    }
    await addVersion({
      parent: secret.trim(),
      requestBody: { payload: { data: Buffer.from(apiKey, 'utf-8').toString('base64') } },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: shortError(err, sensitive) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let targets;
  try {
    targets = await readTargets(argv);
  } catch (err) {
    // Parse/usage error → non-zero exit, terse message (never echoes a key).
    process.stderr.write(`verify-google-access: invalid input: ${shortError(err)}\n`);
    process.exit(2);
  }
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    process.stderr.write('verify-google-access: expected a JSON object of targets\n');
    process.exit(2);
  }

  // --sm-write: POST-persist advisory Secret Manager write-through ONLY.
  if (argv.includes('--sm-write')) {
    const key = typeof targets.geminiApiKey === 'string' ? targets.geminiApiKey.trim() : '';
    const sm = await maybeWriteSecretManager(key);
    process.stdout.write(JSON.stringify({ secretManager: sm }));
    return;
  }

  // Default: verify only. NO Secret Manager write-through here — it must not run
  // before the local save (see route.ts POST-persist step).
  const results = await runVerification(targets);
  process.stdout.write(JSON.stringify({ results }));
}

// Only run main() when executed directly (not when imported by tests).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('verify-google-access.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`verify-google-access: ${shortError(err)}\n`);
    process.exit(1);
  });
}
