/**
 * verify-google.test.mjs — tests for the web spawn helper's failure handling.
 *
 * Focus (issue 2): a crashing / non-JSON / non-zero-exit verifier must NEVER be
 * treated as success, and allTargetsOk must require each PROVIDED target to be
 * { ok:true } (a missing per-target result is a failure).
 *
 * verifyGoogleAccess spawns the ROOT verify-google-access.mjs from
 * careerOpsRoot(). We point CAREER_OPS_ROOT at a temp dir holding a STUB script
 * whose behavior we control (crash / bad-json / good), so no live Google/ADC
 * calls happen.
 *
 * Run: node --test verify-google.test.mjs
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-alias-loader.mjs", import.meta.url);

const modUrl = pathToFileURL(join(import.meta.dirname, "src", "lib", "verify-google.ts")).href;

let mod;
let tmpRoot;
let prevRoot;

/** Write a stub verify-google-access.mjs into the temp root. */
function writeStub(body) {
  writeFileSync(join(tmpRoot, "verify-google-access.mjs"), body, "utf-8");
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "verify-google-"));
  prevRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = tmpRoot;
  mod = await import(modUrl);
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = prevRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("allTargetsOk requires every expected target to be ok:true", () => {
  assert.equal(mod.allTargetsOk({ geminiApiKey: { ok: true } }, ["geminiApiKey"]), true);
  assert.equal(mod.allTargetsOk({ geminiApiKey: { ok: false } }, ["geminiApiKey"]), false);
  // Missing per-target result → failure (the crash-returns-{} case).
  assert.equal(mod.allTargetsOk({}, ["geminiApiKey"]), false);
  assert.equal(mod.allTargetsOk({ geminiApiKey: { ok: true } }, ["geminiApiKey", "googleStorageBucket"]), false);
  // No expected keys → never a pass.
  assert.equal(mod.allTargetsOk({ geminiApiKey: { ok: true } }, []), false);
  // secretManager advisory doesn't count as a target.
  assert.equal(mod.allTargetsOk({ secretManager: { ok: false } }, ["geminiApiKey"]), false);
});

test("missing verifier script → available:false", async () => {
  // No stub written.
  const out = await mod.verifyGoogleAccess({ googleStorageBucket: "b" });
  assert.equal(out.available, false);
  assert.match(out.error, /not available/);
});

test("verifier that exits non-zero → available:false (never success)", async () => {
  writeStub(`process.stderr.write("boom\\n"); process.exit(1);`);
  const out = await mod.verifyGoogleAccess({ googleStorageBucket: "b" });
  assert.equal(out.available, false);
  assert.ok(out.error);
  assert.deepEqual(out.results, {});
});

test("verifier that emits non-JSON → available:false", async () => {
  writeStub(`process.stdout.write("not json at all"); process.exit(0);`);
  const out = await mod.verifyGoogleAccess({ googleStorageBucket: "b" });
  assert.equal(out.available, false);
});

test("verifier with no `results` field → available:false", async () => {
  writeStub(`process.stdout.write(JSON.stringify({ nope: 1 })); process.exit(0);`);
  const out = await mod.verifyGoogleAccess({ googleStorageBucket: "b" });
  assert.equal(out.available, false);
});

test("well-formed verifier → available:true with parsed results", async () => {
  writeStub(`
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ results: { googleStorageBucket: { ok: true } } }));
    });
  `);
  const out = await mod.verifyGoogleAccess({ googleStorageBucket: "b" });
  assert.equal(out.available, true);
  assert.equal(out.results.googleStorageBucket.ok, true);
});

test("secretManagerWriteThrough returns the advisory from the --sm-write action", async () => {
  writeStub(`
    const args = process.argv.slice(2);
    if (args.includes("--sm-write")) {
      process.stdout.write(JSON.stringify({ secretManager: { ok: false, error: "PERMISSION_DENIED" } }));
    } else {
      process.stdout.write(JSON.stringify({ results: {} }));
    }
  `);
  const adv = await mod.secretManagerWriteThrough("AIzaKey1234567890");
  assert.equal(adv.ok, false);
  assert.match(adv.error, /PERMISSION_DENIED/);
});

test("secretManagerWriteThrough → null when the key is empty", async () => {
  writeStub(`process.stdout.write(JSON.stringify({ secretManager: null }));`);
  assert.equal(await mod.secretManagerWriteThrough("   "), null);
});
