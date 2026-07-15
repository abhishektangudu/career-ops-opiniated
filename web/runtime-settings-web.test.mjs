/**
 * runtime-settings-web.test.mjs — parity + behavior tests for the web-side
 * runtime-settings resolver (web/src/lib/runtime-settings.ts).
 *
 * The web resolver reimplements the root loader's contract because a static
 * import of the root .mjs is impossible under Turbopack (root pinned to web/).
 * This suite asserts the web resolver's output MATCHES the root
 * runtime-settings.mjs for identical inputs, so the two cannot drift, and checks
 * precedence / tolerance / masking directly.
 *
 * The web module uses the "@/..." path alias, which `node --test` cannot resolve
 * on its own, so we register a tiny resolution hook (test-alias-loader.mjs) that
 * maps "@/" → ./src/ before importing it. Node strips the TS types.
 *
 * Run: node --test runtime-settings-web.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-alias-loader.mjs", import.meta.url);

// Root loader lives one directory up (career-ops root).
const rootUrl = pathToFileURL(join(import.meta.dirname, "..", "runtime-settings.mjs")).href;
const webUrl = pathToFileURL(join(import.meta.dirname, "src", "lib", "runtime-settings.ts")).href;

let rootMod;
let webMod;

before(async () => {
  rootMod = await import(rootUrl);
  webMod = await import(webUrl);
});

function makeRoot(json) {
  const root = mkdtempSync(join(tmpdir(), "rt-web-"));
  if (json !== undefined) {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "runtime.json"), json, "utf-8");
  }
  return root;
}

const SAMPLE_KEY = "AIzaSyExampleKey1234567890abcd4vXQ";

const SCENARIOS = [
  { name: "all unset", json: undefined, env: {} },
  { name: "file only", json: JSON.stringify({ geminiApiKey: "file-key", googleStorageBucket: "bkt" }), env: {} },
  {
    name: "env overrides file",
    json: JSON.stringify({ geminiApiKey: "file-key", geminiModel: "file-model" }),
    env: { GEMINI_API_KEY: SAMPLE_KEY, GEMINI_MODEL: "env-model" },
  },
  { name: "model file only", json: JSON.stringify({ geminiModel: "gemini-file" }), env: {} },
  { name: "empty strings treated as unset", json: JSON.stringify({ geminiApiKey: "   ", googleSpreadsheetId: "" }), env: { GEMINI_API_KEY: "" } },
  { name: "broken json tolerated", json: "{ not json ,,,", env: {} },
  { name: "sheet + drive from file, bucket from env", json: JSON.stringify({ googleSpreadsheetId: "sid", googleDriveFolderId: "did" }), env: { GOOGLE_STORAGE_BUCKET: "envbkt" } },
];

test("web resolveAllSettings matches root loader for identical inputs", () => {
  for (const sc of SCENARIOS) {
    const root = makeRoot(sc.json);
    try {
      const rootResult = rootMod.resolveAllSettings({ root, env: sc.env });
      const webResult = webMod.resolveAllSettings({ root, env: sc.env });
      assert.deepEqual(webResult.values, rootResult.values, `values mismatch for scenario: ${sc.name}`);
      assert.deepEqual(webResult.sources, rootResult.sources, `sources mismatch for scenario: ${sc.name}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("web resolveSetting matches root loader per field", () => {
  const names = ["geminiApiKey", "geminiModel", "googleSpreadsheetId", "googleDriveFolderId", "googleStorageBucket"];
  for (const sc of SCENARIOS) {
    const root = makeRoot(sc.json);
    try {
      for (const n of names) {
        assert.equal(
          webMod.resolveSetting(n, { root, env: sc.env }),
          rootMod.resolveSetting(n, { root, env: sc.env }),
          `resolveSetting(${n}) mismatch for scenario: ${sc.name}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("web maskKey matches root loader (never leaks full key)", () => {
  for (const v of [undefined, "", "   ", "abcd", "short12", SAMPLE_KEY, "sk-longsecretvalue9999"]) {
    assert.equal(webMod.maskKey(v), rootMod.maskKey(v), `maskKey mismatch for ${JSON.stringify(v)}`);
  }
  const masked = webMod.maskKey(SAMPLE_KEY);
  assert.equal(masked, "AIza…4vXQ");
  assert.ok(!masked.includes(SAMPLE_KEY));
});

test("web settingsFilePath honors RUNTIME_SETTINGS_PATH override", () => {
  const prev = process.env.RUNTIME_SETTINGS_PATH;
  process.env.RUNTIME_SETTINGS_PATH = "/custom/rt.json";
  try {
    assert.equal(webMod.settingsFilePath("/ignored"), rootMod.settingsFilePath("/ignored"));
    assert.equal(webMod.settingsFilePath("/ignored"), "/custom/rt.json");
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_SETTINGS_PATH;
    else process.env.RUNTIME_SETTINGS_PATH = prev;
  }
});
