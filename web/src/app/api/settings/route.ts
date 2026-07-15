/**
 * /api/settings — read + write the runtime integration settings (Gemini key +
 * model, Google Sheet/Drive/GCS identifiers) persisted to config/runtime.json
 * (redirected via RUNTIME_SETTINGS_PATH on Cloud Run).
 *
 *   GET  → per-field { set, source, masked } status. The Gemini key is masked
 *          (AIza…4vXQ); the Sheet/Drive/bucket IDs are returned plain (they are
 *          identifiers, not secrets) but never logged. The raw key is NEVER
 *          returned.
 *   POST → validate shape → server-side VERIFY the provided targets (spawns the
 *          root verify-google-access.mjs) → reject with per-target errors if any
 *          fails → deep-merge ONLY the provided keys into the existing file (409
 *          if the file exists but is invalid JSON) → atomicWriteWithBackup.
 *          Returns the masked status. The key is NEVER echoed or logged.
 *
 * "Verify before save" is enforced HERE so a direct API call cannot persist an
 * invalid key/ID. A test-only ?skipVerify=1 flag bypasses the live check.
 */
import fs from "node:fs";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import {
  resolveAllSettings,
  maskKey,
  settingsFilePath,
  loadRuntimeSettings,
  SETTING_NAMES,
  type SettingName,
} from "@/lib/runtime-settings";
import { verifyGoogleAccess, allTargetsOk, secretManagerWriteThrough } from "@/lib/verify-google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keys whose value is a secret (masked, never returned raw).
const SECRET_KEYS: SettingName[] = ["geminiApiKey"];

// The credential/identifier targets the verifier can confirm. geminiModel is
// intentionally excluded — it is not a standalone verifiable target (it only
// rides along with the key so the verifier can use it).
const VERIFIABLE_KEYS: SettingName[] = [
  "geminiApiKey",
  "googleSpreadsheetId",
  "googleDriveFolderId",
  "googleStorageBucket",
];

type FieldStatus = { set: boolean; source: string; masked: string | null };

/** Build the masked, key-safe status payload from resolved settings. */
function statusPayload() {
  const { values, sources } = resolveAllSettings();
  const fields: Record<string, FieldStatus> = {};
  for (const name of SETTING_NAMES) {
    const value = values[name];
    const isSecret = SECRET_KEYS.includes(name);
    fields[name] = {
      set: sources[name] !== "unset",
      source: sources[name],
      // Secrets are masked; identifiers are returned plain (not secrets).
      masked: isSecret ? maskKey(value) : (value ?? null),
    };
  }
  return fields;
}

export async function GET() {
  return Response.json({ fields: statusPayload() });
}

// ── POST validation ─────────────────────────────────────────────────────────

// Basic key charset/length guard (Google AI Studio keys are ~39 chars,
// alphanumeric plus - _ and .). Deliberately permissive on length to avoid
// rejecting future key formats, but rejects obviously-bad input before a live
// verify. Note: real Gemini keys can contain a dot, so `.` is allowed here.
const KEY_RE = /^[A-Za-z0-9._-]{20,200}$/;
// Google identifiers (Sheet/Drive/bucket) — conservative but permissive.
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const MODEL_RE = /^[A-Za-z0-9.:_-]{1,100}$/;

type Body = Partial<Record<SettingName, unknown>>;

function validate(body: Body): { patch: Partial<Record<SettingName, string>>; error?: string } {
  const patch: Partial<Record<SettingName, string>> = {};
  const allowed = new Set<string>(SETTING_NAMES);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { patch, error: `unknown field: ${key}` };
  }
  for (const name of SETTING_NAMES) {
    if (!(name in body)) continue;
    const v = body[name];
    if (typeof v !== "string") return { patch, error: `${name} must be a string` };
    const trimmed = v.trim();
    if (!trimmed) return { patch, error: `${name} must not be empty` };
    if (name === "geminiApiKey" && !KEY_RE.test(trimmed)) return { patch, error: "geminiApiKey has an invalid format" };
    if (name === "geminiModel" && !MODEL_RE.test(trimmed)) return { patch, error: "geminiModel has an invalid format" };
    if (
      (name === "googleSpreadsheetId" || name === "googleDriveFolderId" || name === "googleStorageBucket") &&
      !ID_RE.test(trimmed)
    ) {
      return { patch, error: `${name} has an invalid format` };
    }
    patch[name] = trimmed;
  }
  return { patch };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The ?skipVerify=1 flag is a TEST-ONLY affordance — it must NEVER be honored in
 * production, or a POST could persist an unverified (invalid) key/ID. It is only
 * effective when the process is explicitly in test mode.
 */
function skipVerifyAllowed(): boolean {
  return process.env.NODE_ENV === "test" || process.env.CAREER_OPS_TEST_SKIP_VERIFY === "1";
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const skipVerify = url.searchParams.get("skipVerify") === "1" && skipVerifyAllowed();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!isObj(body)) return Response.json({ error: "expected an object" }, { status: 400 });

  const { patch, error } = validate(body);
  if (error) return Response.json({ error }, { status: 400 });
  if (Object.keys(patch).length === 0) return Response.json({ error: "nothing to save" }, { status: 400 });

  // ── Verify BEFORE persist (unless a test explicitly opts out) ──────────────
  // geminiModel alone is not a verifiable target — only verify when at least one
  // credential/identifier is present.
  const verifiable: Partial<Record<SettingName, string>> = {};
  for (const k of VERIFIABLE_KEYS) {
    if (patch[k]) verifiable[k] = patch[k];
  }
  // A Gemini model is passed alongside the key so the verifier can use it.
  if (verifiable.geminiApiKey && patch.geminiModel) verifiable.geminiModel = patch.geminiModel;

  // The keys we actually expect the verifier to confirm.
  const expectedKeys = VERIFIABLE_KEYS.filter((k) => verifiable[k]);

  if (!skipVerify && expectedKeys.length > 0) {
    const outcome = await verifyGoogleAccess(verifiable);
    if (!outcome.available) {
      // Crash / non-zero exit / non-JSON / timeout → treat as unavailable, never
      // as success. outcome.error carries the terse reason.
      return Response.json({ error: outcome.error ?? "verification unavailable", verified: false }, { status: 503 });
    }
    if (!allTargetsOk(outcome.results, expectedKeys)) {
      // Every provided target must be { ok:true }; a missing per-target result
      // counts as failure. Never echo the key — only the per-target report.
      return Response.json({ error: "verification failed", verified: false, results: outcome.results }, { status: 422 });
    }
  }

  // ── Load existing file: distinguish missing vs invalid-JSON (→409) ─────────
  const file = settingsFilePath(careerOpsRoot());
  let base: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "read failed" }, { status: 500 });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      base = isObj(parsed) ? parsed : {};
    } catch {
      // File EXISTS but is corrupt — refuse to overwrite (mirror api/profile).
      return Response.json(
        { error: "runtime.json exists but is not valid JSON — refusing to overwrite it." },
        { status: 409 },
      );
    }
  } else {
    // Tolerant read (in case RUNTIME_SETTINGS_PATH points elsewhere yet parses).
    base = loadRuntimeSettings(careerOpsRoot());
  }

  // Deep-merge ONLY the provided keys (never clobber other settings).
  const merged: Record<string, unknown> = { ...base, ...patch };
  try {
    atomicWriteWithBackup(file, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }

  // ── POST-PERSIST advisory Secret Manager write-through ─────────────────────
  // Runs only AFTER the local save succeeds, so a secret version is never added
  // for a save that later 409s/500s. Non-blocking: a failure is surfaced as an
  // advisory warning but the POST still succeeds (the local file is the SSOT).
  let secretManager: { ok: boolean; error?: string } | null = null;
  if (patch.geminiApiKey) {
    try {
      secretManager = await secretManagerWriteThrough(patch.geminiApiKey);
    } catch (e) {
      secretManager = { ok: false, error: e instanceof Error ? e.message : "write-through failed" };
    }
  }

  const res: Record<string, unknown> = { ok: true, fields: statusPayload() };
  // Only surface the advisory when the write-through actually ran (non-null).
  if (secretManager) {
    res.secretManager = secretManager;
    if (!secretManager.ok) res.warning = "Settings saved. Secret Manager write-through failed (non-blocking).";
  }
  return Response.json(res);
}
