/**
 * runtime-settings.mjs — shared runtime-settings loader (fork-only).
 *
 * The four Google/Gemini integration values (Gemini API key + model, Google
 * Sheet ID, Drive folder ID, GCS bucket) used to be read ONCE at process start
 * as module-level constants in server.mjs / gemini-eval.mjs. A value entered in
 * the PWA is written to a file, but a long-running server captured its env
 * constants at module load and would never see the new value.
 *
 * The fix is this ONE shared loader, read PER INVOCATION by every consumer, with
 * an explicit precedence:
 *
 *     explicit env var  >  saved settings file  >  unset
 *
 * Env-override preserves the deploy contract (Cloud Run / CI can pin a value and
 * it wins); the file lets you set values from the UI at runtime with no redeploy.
 *
 * Pure Node (fs + path), no third-party deps, so both the core scripts and the
 * web routes can rely on the exact same contract (the web mirror in
 * web/src/lib/runtime-settings.ts is asserted byte-for-byte against this file by
 * runtime-settings-web.test.mjs).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Logical setting name → environment-variable name. The logical names are what
 * the PWA / JSON file use as keys; the env names are the legacy process.env
 * constants the scripts historically read.
 */
export const SETTING_ENV_MAP = {
  geminiApiKey: 'GEMINI_API_KEY',
  geminiModel: 'GEMINI_MODEL',
  googleSpreadsheetId: 'GOOGLE_SPREADSHEET_ID',
  googleDriveFolderId: 'GOOGLE_DRIVE_FOLDER_ID',
  googleStorageBucket: 'GOOGLE_STORAGE_BUCKET',
};

/** All logical setting names, in a stable order. */
export const SETTING_NAMES = Object.keys(SETTING_ENV_MAP);

/** The default Gemini model — applied ONLY when both env and file are unset. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Absolute path to the persisted settings file.
 *
 * `RUNTIME_SETTINGS_PATH` is the override that makes a WRITABLE, DURABLE cloud
 * location possible (e.g. /app/data/runtime.json inside the mounted data/ GCS
 * volume on Cloud Run) WITHOUT mounting a volume over the whole config/ dir.
 * Locally it defaults to config/runtime.json (gitignored).
 */
export function settingsFilePath(root = process.cwd()) {
  const override = process.env.RUNTIME_SETTINGS_PATH;
  if (override && override.trim()) return override.trim();
  return join(root, 'config', 'runtime.json');
}

/**
 * Load the persisted settings object. Tolerant by construction: a missing file
 * (ENOENT) or a broken/partial JSON returns {} and NEVER throws — a corrupt
 * runtime file must never crash a consumer that only wants env values.
 */
export function loadRuntimeSettings(root = process.cwd()) {
  let raw;
  try {
    raw = readFileSync(settingsFilePath(root), 'utf-8');
  } catch {
    return {}; // ENOENT / unreadable → treat as unset
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {}; // malformed JSON → tolerant fallback
  }
}

/** Trim a candidate to a non-empty string, or undefined. */
function clean(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a single logical setting with precedence env > file > unset.
 * Empty / whitespace-only strings are treated as unset at every layer.
 *
 * No default is applied here (so the caller can distinguish truly-unset from a
 * defaulted model); DEFAULT_GEMINI_MODEL is applied by resolveAllSettings and
 * the model consumers.
 */
export function resolveSetting(name, { root = process.cwd(), env = process.env, file } = {}) {
  const envName = SETTING_ENV_MAP[name];
  if (!envName) return undefined;
  const fromEnv = clean(env[envName]);
  if (fromEnv !== undefined) return fromEnv;
  const settings = file ?? loadRuntimeSettings(root);
  return clean(settings[name]);
}

/** Which layer a resolved value came from. */
function sourceOf(name, { root, env, file }) {
  const envName = SETTING_ENV_MAP[name];
  if (clean(env[envName]) !== undefined) return 'env';
  const settings = file ?? loadRuntimeSettings(root);
  if (clean(settings[name]) !== undefined) return 'file';
  return 'unset';
}

/**
 * Resolve all five settings plus a `sources` map ("env" | "file" | "unset").
 *
 * The GEMINI_MODEL default (gemini-2.5-flash) is applied to `values.geminiModel`
 * ONLY when both env and file are unset; `sources.geminiModel` stays "unset" in
 * that case so callers can tell a defaulted model from a configured one.
 *
 * SECURITY: `sources` NEVER contains the raw key (only the string "env"/"file"/
 * "unset"). Callers that expose status must mask the key themselves.
 */
export function resolveAllSettings({ root = process.cwd(), env = process.env } = {}) {
  const file = loadRuntimeSettings(root);
  const values = {};
  const sources = {};
  for (const name of SETTING_NAMES) {
    values[name] = resolveSetting(name, { root, env, file });
    sources[name] = sourceOf(name, { root, env, file });
  }
  // Model default applies only when BOTH env and file are unset.
  if (values.geminiModel === undefined) values.geminiModel = DEFAULT_GEMINI_MODEL;
  return { values, sources };
}

/**
 * Mask a secret value for display: keep the leading "AIza" hint (if present) and
 * the last 4 characters, e.g. "AIza…4vXQ". Returns null when unset. NEVER
 * returns the full key. Short values are fully redacted to a fixed placeholder
 * so no meaningful prefix/suffix leaks.
 */
export function maskKey(value) {
  const v = clean(value);
  if (v === undefined) return null;
  const last4 = v.slice(-4);
  if (v.length <= 8) return '…' + last4;
  const prefix = v.startsWith('AIza') ? 'AIza' : v.slice(0, 4);
  return `${prefix}…${last4}`;
}
