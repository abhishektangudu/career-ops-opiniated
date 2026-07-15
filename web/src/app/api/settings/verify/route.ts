/**
 * POST /api/settings/verify — live round-trip verification of Google/Gemini
 * targets, WITHOUT persisting anything.
 *
 * The web workspace has no Google deps, so this route spawns the root
 * verify-google-access.mjs (see @/lib/verify-google) which runs the actual
 * checks under ADC. Returns per-target { ok, error }.
 *
 * SECURITY: the Gemini key is only forwarded to the child via stdin; it is never
 * logged and never returned in the response.
 */
import { verifyGoogleAccess } from "@/lib/verify-google";
import { SETTING_NAMES, type SettingName } from "@/lib/runtime-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = Partial<Record<SettingName, unknown>>;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected an object of targets" }, { status: 400 });
  }

  const targets: Partial<Record<SettingName, string>> = {};
  for (const name of SETTING_NAMES) {
    const v = body[name];
    if (typeof v === "string" && v.trim()) targets[name] = v.trim();
  }
  if (Object.keys(targets).length === 0) {
    return Response.json({ error: "no targets provided to verify" }, { status: 400 });
  }

  const outcome = await verifyGoogleAccess(targets);
  if (!outcome.available) {
    return Response.json({ available: false, error: outcome.error ?? "verifier unavailable", results: {} }, { status: 503 });
  }
  return Response.json({ available: true, results: outcome.results, error: outcome.error });
}
