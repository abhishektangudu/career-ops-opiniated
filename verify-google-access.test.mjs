/**
 * verify-google-access.test.mjs — unit tests for the verify CLI's pure logic
 * using INJECTED runners (no live ADC / Gemini calls).
 *
 * Covers: per-target ok/error shaping, only-provided-targets are checked, a
 * Gemini failure is surfaced without leaking the key, Google-client init failure
 * fails every Google target, and the Secret Manager write-through is guarded
 * off by default + base64-encodes the payload when enabled.
 *
 * Run: node --test verify-google-access.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runVerification, maybeWriteSecretManager, redactSensitive } from "./verify-google-access.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "verify-google-access.mjs");

const okClients = () => ({
  sheets: { spreadsheets: { get: async () => ({ data: {} }) } },
  drive: { files: { get: async () => ({ data: {} }) } },
  storage: { buckets: { get: async () => ({ data: {} }) } },
});

test("verifies only the provided targets", async () => {
  const res = await runVerification(
    { geminiApiKey: "AIzakey", googleStorageBucket: "bkt" },
    { geminiRunner: async () => {}, getClients: okClients },
  );
  assert.deepEqual(Object.keys(res).sort(), ["geminiApiKey", "googleStorageBucket"]);
  assert.equal(res.geminiApiKey.ok, true);
  assert.equal(res.googleStorageBucket.ok, true);
});

test("empty / absent targets are skipped", async () => {
  const res = await runVerification({ geminiApiKey: "   ", googleSpreadsheetId: "" }, { geminiRunner: async () => {}, getClients: okClients });
  assert.deepEqual(res, {});
});

test("Gemini failure is reported as { ok:false, error } and never leaks the key", async () => {
  const KEY = "AIzaSuperSecretKey123456";
  const res = await runVerification(
    { geminiApiKey: KEY },
    { geminiRunner: async () => { throw new Error("API key not valid. Please pass a valid API key."); } },
  );
  assert.equal(res.geminiApiKey.ok, false);
  assert.match(res.geminiApiKey.error, /not valid/);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("per-target Google error shaping (sheet fails, bucket ok)", async () => {
  const clients = () => ({
    sheets: { spreadsheets: { get: async () => { throw new Error("Requested entity was not found."); } } },
    drive: { files: { get: async () => ({}) } },
    storage: { buckets: { get: async () => ({}) } },
  });
  const res = await runVerification({ googleSpreadsheetId: "bad", googleStorageBucket: "good" }, { getClients: clients });
  assert.equal(res.googleSpreadsheetId.ok, false);
  assert.match(res.googleSpreadsheetId.error, /not found/);
  assert.equal(res.googleStorageBucket.ok, true);
});

test("google-client init failure fails every Google target", async () => {
  const res = await runVerification(
    { googleSpreadsheetId: "s", googleDriveFolderId: "d", googleStorageBucket: "b" },
    { getClients: async () => { throw new Error("Could not load the default credentials"); } },
  );
  for (const k of ["googleSpreadsheetId", "googleDriveFolderId", "googleStorageBucket"]) {
    assert.equal(res[k].ok, false);
    assert.match(res[k].error, /default credentials/);
  }
});

test("Secret Manager write-through is disabled by default (returns null)", async () => {
  const prev = process.env.SECRET_MANAGER_SECRET;
  delete process.env.SECRET_MANAGER_SECRET;
  try {
    const res = await maybeWriteSecretManager("AIzakey", {});
    assert.equal(res, null);
  } finally {
    if (prev !== undefined) process.env.SECRET_MANAGER_SECRET = prev;
  }
});

test("Secret Manager write-through base64-encodes the payload when enabled", async () => {
  let captured = null;
  const res = await maybeWriteSecretManager("AIzakey", {
    secretName: "projects/p/secrets/gemini",
    addVersion: async (params) => { captured = params; return { data: {} }; },
  });
  assert.equal(res.ok, true);
  assert.equal(captured.parent, "projects/p/secrets/gemini");
  assert.equal(Buffer.from(captured.requestBody.payload.data, "base64").toString("utf-8"), "AIzakey");
});

test("Secret Manager write-through surfaces failure but is non-fatal", async () => {
  const res = await maybeWriteSecretManager("AIzakey", {
    secretName: "projects/p/secrets/gemini",
    addVersion: async () => { throw new Error("PERMISSION_DENIED"); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /PERMISSION_DENIED/);
});

test("Secret Manager write-through skipped when key empty", async () => {
  const res = await maybeWriteSecretManager("", { secretName: "projects/p/secrets/g", addVersion: async () => ({}) });
  assert.equal(res, null);
});

// ── Issue 4: error redaction ──────────────────────────────────────────────

test("redactSensitive replaces exact key occurrences with [REDACTED]", () => {
  const KEY = "AIzaSuperSecretKey1234567890";
  const out = redactSensitive(`boom: bad token ${KEY} rejected`, [KEY]);
  assert.ok(!out.includes(KEY));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSensitive ignores short values (avoids spurious matches)", () => {
  assert.equal(redactSensitive("error at abc", ["abc"]), "error at abc");
});

test("Gemini error that embeds the submitted key is REDACTED in the result", async () => {
  const KEY = "AIzaLeakyKeyEmbeddedInError999";
  const res = await runVerification(
    { geminiApiKey: KEY },
    { geminiRunner: async () => { throw new Error(`Request failed: invalid key '${KEY}' (401)`); } },
  );
  assert.equal(res.geminiApiKey.ok, false);
  assert.ok(!res.geminiApiKey.error.includes(KEY), "error must not contain the raw key");
  assert.match(res.geminiApiKey.error, /\[REDACTED\]/);
});

test("Secret Manager error that embeds the key is REDACTED", async () => {
  const KEY = "AIzaSMErrorLeakKey1234567890";
  const res = await maybeWriteSecretManager(KEY, {
    secretName: "projects/p/secrets/g",
    addVersion: async () => { throw new Error(`failed to add version for ${KEY}`); },
  });
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes(KEY));
  assert.match(res.error, /\[REDACTED\]/);
});

// ── Issue 3: CLI must not accept a secret on argv ─────────────────────────

test("CLI rejects --json carrying geminiApiKey (secret on argv)", () => {
  let threw = false;
  try {
    // No stdin pipe → readTargets falls through to argv parsing.
    execFileSync(process.execPath, [CLI, "--json", JSON.stringify({ geminiApiKey: "AIzaShouldBeRejected1234" })], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    threw = true;
    const stderr = (e.stderr || "").toString();
    assert.match(stderr, /refusing --json with a secret field/);
    assert.ok(!stderr.includes("AIzaShouldBeRejected1234"));
  }
  assert.ok(threw, "CLI should exit non-zero when a secret is passed on argv");
});

test("CLI accepts non-secret --json (identifiers only) on argv", () => {
  const out = execFileSync(
    process.execPath,
    [CLI, "--json", JSON.stringify({ googleStorageBucket: "some-bucket" })],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out);
  // No ADC creds in test env → the bucket check fails, but the run completes and
  // returns a per-target result (not a crash).
  assert.ok("results" in parsed);
  assert.ok("googleStorageBucket" in parsed.results);
});
