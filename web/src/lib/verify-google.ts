/**
 * verify-google.ts — spawn the root verify-google-access.mjs to run a live
 * "verify before save" round-trip against Google/Gemini targets, and (as a
 * SEPARATE post-persist step) the optional Secret Manager write-through.
 *
 * The web workspace has NO Google deps (web/package.json), so it does NOT import
 * @google/generative-ai / googleapis directly. Instead it spawns the root CLI
 * (which owns those deps + ADC), passing targets on stdin and reading back a
 * per-target { ok, error } JSON report — the same subprocess pattern used by
 * web/src/lib/core/pipeline.ts.
 *
 * SECURITY: the Gemini key is passed only via the child's stdin (never argv,
 * never logged) and is never echoed back in the result.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import type { SettingName } from "@/lib/runtime-settings";

export type VerifyTargets = Partial<Record<SettingName, string>>;
export type TargetResult = { ok: boolean; error?: string };
export type VerifyResults = Partial<Record<SettingName | "secretManager", TargetResult>>;

export type VerifyOutcome = {
  available: boolean;
  results: VerifyResults;
  error?: string;
};

type SpawnParseResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

/** Run the root CLI with `args`, feeding `payload` as JSON on stdin. */
function runRootCli(args: string[], payload: Record<string, string>, timeoutMs: number): Promise<SpawnParseResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [rootScript("verify-google-access"), ...args], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: SpawnParseResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, spawnError: "verification timed out" });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, spawnError: e instanceof Error ? e.message : "spawn failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Only forward non-empty string targets. */
function cleanTargets(targets: VerifyTargets): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(targets)) {
    if (typeof v === "string" && v.trim()) clean[k] = v.trim();
  }
  return clean;
}

/**
 * Spawn verify-google-access.mjs with cwd = careerOpsRoot(), feeding `targets`
 * as JSON on stdin. Returns the parsed per-target results.
 *
 * A missing script, spawn failure, non-zero exit, non-JSON output, or a missing
 * `results` object are ALL treated as verification-UNAVAILABLE (available:false)
 * — never as success. Callers must reject the save on available:false.
 */
export async function verifyGoogleAccess(targets: VerifyTargets, timeoutMs = 30_000): Promise<VerifyOutcome> {
  const script = rootScript("verify-google-access");
  if (!fs.existsSync(script)) {
    return { available: false, results: {}, error: "verify-google-access.mjs not available in this checkout." };
  }

  const clean = cleanTargets(targets);
  const r = await runRootCli([], clean, timeoutMs);

  if (r.spawnError) return { available: false, results: {}, error: r.spawnError };
  if (r.code !== 0) {
    return { available: false, results: {}, error: r.stderr.trim().slice(0, 200) || `verifier exited with code ${r.code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim() || "null");
  } catch {
    return { available: false, results: {}, error: r.stderr.trim().slice(0, 200) || "verifier returned non-JSON output" };
  }
  if (!parsed || typeof parsed !== "object" || !("results" in parsed) || typeof (parsed as { results: unknown }).results !== "object") {
    return { available: false, results: {}, error: "verifier returned no results" };
  }

  return { available: true, results: (parsed as { results: VerifyResults }).results ?? {} };
}

/**
 * POST-persist advisory Secret Manager write-through. Runs the root CLI's
 * --sm-write action with the key on stdin. Returns the { ok, error } advisory,
 * or null when disabled / unavailable (never throws, never blocks the caller).
 */
export async function secretManagerWriteThrough(geminiApiKey: string, timeoutMs = 30_000): Promise<TargetResult | null> {
  const script = rootScript("verify-google-access");
  if (!fs.existsSync(script) || !geminiApiKey.trim()) return null;

  const r = await runRootCli(["--sm-write"], { geminiApiKey: geminiApiKey.trim() }, timeoutMs);
  if (r.spawnError || r.code !== 0) {
    return { ok: false, error: (r.spawnError || r.stderr.trim().slice(0, 200) || `write-through exited with code ${r.code}`) };
  }
  try {
    const parsed = JSON.parse(r.stdout.trim() || "null") as { secretManager?: TargetResult | null } | null;
    return parsed?.secretManager ?? null;
  } catch {
    return { ok: false, error: "write-through returned non-JSON output" };
  }
}

/**
 * True only when EVERY expected target verified with { ok:true }. Pass the
 * target keys that were requested — a missing per-target result (e.g. because
 * the verifier crashed and returned {}) counts as a FAILURE, not a pass.
 * `secretManager` is advisory and never gates this.
 */
export function allTargetsOk(results: VerifyResults, expectedKeys: string[]): boolean {
  if (expectedKeys.length === 0) return false;
  return expectedKeys.every((k) => {
    const r = results[k as SettingName];
    return !!r && r.ok === true;
  });
}
