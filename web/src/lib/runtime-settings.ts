/**
 * runtime-settings.ts — web-side mirror of the root runtime-settings.mjs loader.
 *
 * A STATIC build-time import of the root `runtime-settings.mjs` is IMPOSSIBLE
 * here: Turbopack's root is pinned to web/ (web/next.config.mjs) and refuses
 * modules outside it (same constraint documented in web/src/lib/tracker-table.mjs).
 * So this module reads settingsFilePath(careerOpsRoot()) with fs and applies the
 * SAME precedence / masking contract as the root loader.
 *
 * runtime-settings-web.test.mjs asserts this resolver's output matches the root
 * loader for identical inputs, so the two implementations cannot drift.
 *
 * Precedence is strictly: env var > file > unset.
 */
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

/** Logical setting name → environment-variable name (mirror of root loader). */
export const SETTING_ENV_MAP = {
  geminiApiKey: "GEMINI_API_KEY",
  geminiModel: "GEMINI_MODEL",
  googleSpreadsheetId: "GOOGLE_SPREADSHEET_ID",
  googleDriveFolderId: "GOOGLE_DRIVE_FOLDER_ID",
  googleStorageBucket: "GOOGLE_STORAGE_BUCKET",
} as const;

export type SettingName = keyof typeof SETTING_ENV_MAP;

export const SETTING_NAMES = Object.keys(SETTING_ENV_MAP) as SettingName[];

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export type Source = "env" | "file" | "unset";

/**
 * Absolute path to the persisted settings file. Honors RUNTIME_SETTINGS_PATH
 * (durable cloud location) else config/runtime.json under the given root.
 */
export function settingsFilePath(root: string = careerOpsRoot()): string {
  const override = process.env.RUNTIME_SETTINGS_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(root, "config", "runtime.json");
}

/**
 * Load the persisted settings object. Tolerant: missing file or broken JSON
 * returns {} and never throws.
 */
export function loadRuntimeSettings(root: string = careerOpsRoot()): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFilePath(root), "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Trim a candidate to a non-empty string, or undefined. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

type ResolveOpts = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  file?: Record<string, unknown>;
};

/** Resolve a single setting with precedence env > file > unset. */
export function resolveSetting(name: SettingName, opts: ResolveOpts = {}): string | undefined {
  const { root = careerOpsRoot(), env = process.env, file } = opts;
  const fromEnv = clean(env[SETTING_ENV_MAP[name]]);
  if (fromEnv !== undefined) return fromEnv;
  const settings = file ?? loadRuntimeSettings(root);
  return clean(settings[name]);
}

function sourceOf(name: SettingName, opts: Required<Pick<ResolveOpts, "env">> & ResolveOpts): Source {
  const { root = careerOpsRoot(), env, file } = opts;
  if (clean(env[SETTING_ENV_MAP[name]]) !== undefined) return "env";
  const settings = file ?? loadRuntimeSettings(root);
  if (clean(settings[name]) !== undefined) return "file";
  return "unset";
}

export type ResolvedSettings = {
  values: Record<SettingName, string | undefined>;
  sources: Record<SettingName, Source>;
};

/**
 * Resolve all five settings + a per-field sources map. The model default applies
 * ONLY when both env and file are unset (sources.geminiModel stays "unset").
 * SECURITY: `sources` never contains the raw key.
 */
export function resolveAllSettings(opts: { root?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedSettings {
  const { root = careerOpsRoot(), env = process.env } = opts;
  const file = loadRuntimeSettings(root);
  const values = {} as Record<SettingName, string | undefined>;
  const sources = {} as Record<SettingName, Source>;
  for (const name of SETTING_NAMES) {
    values[name] = resolveSetting(name, { root, env, file });
    sources[name] = sourceOf(name, { root, env, file });
  }
  if (values.geminiModel === undefined) values.geminiModel = DEFAULT_GEMINI_MODEL;
  return { values, sources };
}

/**
 * Mask a secret for display: keep the "AIza" hint (if present) + last 4 chars,
 * e.g. "AIza…4vXQ". null when unset. Never returns the full key; short values
 * are fully redacted.
 */
export function maskKey(value: unknown): string | null {
  const v = clean(value);
  if (v === undefined) return null;
  const last4 = v.slice(-4);
  if (v.length <= 8) return "…" + last4;
  const prefix = v.startsWith("AIza") ? "AIza" : v.slice(0, 4);
  return `${prefix}…${last4}`;
}
