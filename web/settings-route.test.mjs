/**
 * settings-route.test.mjs — unit tests for the /api/settings route handlers.
 *
 * Uses a temp CAREER_OPS_ROOT so writes land in a throwaway dir, and the
 * ?skipVerify=1 test flag to exercise the persist path without a live Google
 * round-trip. Covers: GET masks the key (never returns raw), POST deep-merges
 * without clobbering, POST on malformed existing JSON → 409, POST rejects
 * unknown/invalid fields, and POST never echoes the submitted key.
 *
 * The "verify before save" rejection path (invalid value never persisted) is
 * covered by verify-google-access injected tests + settings-verify behavior;
 * here we assert that WITHOUT skipVerify a bad key never reaches disk.
 *
 * Run: node --test settings-route.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-alias-loader.mjs", import.meta.url);

const routeUrl = pathToFileURL(join(import.meta.dirname, "src", "app", "api", "settings", "route.ts")).href;

const SAMPLE_KEY = "AIzaSyExampleKey1234567890abcdEFGH4vXQ";
let tmpRoot;
let prevRoot;
let route;

function runtimeFile() {
  return join(tmpRoot, "config", "runtime.json");
}
function writeRuntime(obj) {
  mkdirSync(join(tmpRoot, "config"), { recursive: true });
  writeFileSync(runtimeFile(), typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
}
function readRuntime() {
  return JSON.parse(readFileSync(runtimeFile(), "utf-8"));
}
function post(bodyObj, { skipVerify = true } = {}) {
  const url = `http://localhost/api/settings${skipVerify ? "?skipVerify=1" : ""}`;
  return route.POST(new Request(url, { method: "POST", body: JSON.stringify(bodyObj), headers: { "content-type": "application/json" } }));
}

let prevSkipGuard;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "settings-route-"));
  prevRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = tmpRoot;
  // ?skipVerify=1 is only honored under the explicit test guard — set it so the
  // persist-path tests can skip the live verify. (The guard-off case is tested
  // separately below.)
  prevSkipGuard = process.env.CAREER_OPS_TEST_SKIP_VERIFY;
  process.env.CAREER_OPS_TEST_SKIP_VERIFY = "1";
  // Clear any ambient env that would shadow the file during resolveAllSettings.
  for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_SPREADSHEET_ID", "GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_STORAGE_BUCKET", "RUNTIME_SETTINGS_PATH"]) {
    delete process.env[k];
  }
  route = await import(routeUrl); // cached across tests; env read per-call
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = prevRoot;
  if (prevSkipGuard === undefined) delete process.env.CAREER_OPS_TEST_SKIP_VERIFY;
  else process.env.CAREER_OPS_TEST_SKIP_VERIFY = prevSkipGuard;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("GET masks the key and never returns the raw value", async () => {
  writeRuntime({ geminiApiKey: SAMPLE_KEY, googleStorageBucket: "my-bucket" });
  const res = await route.GET();
  const body = await res.json();
  assert.equal(body.fields.geminiApiKey.set, true);
  assert.equal(body.fields.geminiApiKey.source, "file");
  assert.equal(body.fields.geminiApiKey.masked, "AIza…4vXQ");
  // Identifiers returned plain.
  assert.equal(body.fields.googleStorageBucket.masked, "my-bucket");
  // The raw key must not appear anywhere in the serialized response.
  assert.ok(!JSON.stringify(body).includes(SAMPLE_KEY));
});

test("POST (skipVerify) persists and deep-merges without clobbering other keys", async () => {
  writeRuntime({ geminiApiKey: SAMPLE_KEY, googleSpreadsheetId: "existing-sheet" });
  const res = await post({ googleStorageBucket: "new-bucket" });
  assert.equal(res.status, 200);
  const stored = readRuntime();
  assert.equal(stored.googleStorageBucket, "new-bucket");
  assert.equal(stored.geminiApiKey, SAMPLE_KEY); // untouched
  assert.equal(stored.googleSpreadsheetId, "existing-sheet"); // untouched
});

test("POST creates the file when none exists", async () => {
  assert.ok(!existsSync(runtimeFile()));
  const res = await post({ googleSpreadsheetId: "sheet-123" });
  assert.equal(res.status, 200);
  assert.equal(readRuntime().googleSpreadsheetId, "sheet-123");
});

test("POST on existing-but-invalid JSON returns 409 and does not overwrite", async () => {
  writeRuntime("{ not valid json ,,,");
  const res = await post({ googleStorageBucket: "b" });
  assert.equal(res.status, 409);
  // Original corrupt content preserved (not overwritten).
  assert.equal(readFileSync(runtimeFile(), "utf-8"), "{ not valid json ,,,");
});

test("POST rejects unknown fields (400)", async () => {
  const res = await post({ nope: "x" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown field/);
});

test("POST rejects an invalid key format (400)", async () => {
  const res = await post({ geminiApiKey: "short!" });
  assert.equal(res.status, 400);
});

test("POST accepts a dot-containing Gemini key (issue 7)", async () => {
  // Real Gemini keys can contain a `.` — the charset must allow it.
  const dotKey = "AIzaSyExample.Key1234567890abcdEFGH";
  const res = await post({ geminiApiKey: dotKey });
  assert.equal(res.status, 200);
  assert.equal(readRuntime().geminiApiKey, dotKey);
});

test("POST rejects empty-string values (400)", async () => {
  const res = await post({ googleSpreadsheetId: "   " });
  assert.equal(res.status, 400);
});

test("POST response never echoes the submitted key", async () => {
  const res = await post({ geminiApiKey: SAMPLE_KEY });
  assert.equal(res.status, 200);
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(SAMPLE_KEY));
  // But it is masked in the returned status.
  assert.equal(body.fields.geminiApiKey.masked, "AIza…4vXQ");
});

test("POST with only geminiModel (non-verifiable) persists under skipVerify", async () => {
  const res = await post({ geminiModel: "gemini-2.5-flash" });
  assert.equal(res.status, 200);
  assert.equal(readRuntime().geminiModel, "gemini-2.5-flash");
});

// ── Issue 1: ?skipVerify=1 must NOT be honored in production ──────────────

test("skipVerify=1 is IGNORED when the test guard is off (verify still runs)", async () => {
  // Turn the guard OFF → skipVerify should be ignored, so verification runs.
  // careerOpsRoot() (the tmp dir) has NO verify-google-access.mjs, so the
  // verifier is UNAVAILABLE → 503, and NOTHING is persisted.
  delete process.env.CAREER_OPS_TEST_SKIP_VERIFY;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const res = await post({ googleSpreadsheetId: "sheet-should-not-persist" }, { skipVerify: true });
    assert.equal(res.status, 503); // verification unavailable, not bypassed
    assert.ok(!existsSync(runtimeFile()), "must not persist when verify is bypassed in prod");
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

// ── Issue 2: verifier unavailable/crash must block the save ───────────────

test("POST does NOT persist when the verifier is unavailable (no skip guard)", async () => {
  // No script in careerOpsRoot() → verifyGoogleAccess returns available:false.
  const res = await post({ googleStorageBucket: "bkt" }, { skipVerify: false });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.verified, false);
  assert.ok(body.error, "a terse unavailability reason is surfaced");
  assert.ok(!existsSync(runtimeFile()), "invalid/unverified value must never reach disk");
});

test("POST persists geminiModel-only WITHOUT verify even when guard is off (nothing verifiable)", async () => {
  // geminiModel alone is not a verifiable target, so no verify is attempted and
  // the save proceeds regardless of the skip guard.
  delete process.env.CAREER_OPS_TEST_SKIP_VERIFY;
  const res = await post({ geminiModel: "gemini-2.5-flash" }, { skipVerify: false });
  assert.equal(res.status, 200);
  assert.equal(readRuntime().geminiModel, "gemini-2.5-flash");
});
