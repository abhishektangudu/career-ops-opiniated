/**
 * test-alias-loader.mjs — Node module-resolution hook that maps the web app's
 * "@/..." path alias (tsconfig.json paths → ./src/*) to real file URLs, so the
 * TypeScript modules under web/src can be imported directly by `node --test`
 * (which does not understand tsconfig path aliases). Node strips the TS types.
 *
 * Because the aliased imports are extensionless (e.g. "@/lib/career-ops"), the
 * hook probes the usual source extensions (.ts, .tsx, .mjs, .js) and also an
 * index file, mirroring the TS/bundler resolver enough for these tests.
 *
 * Registered by the web parity test via register("./test-alias-loader.mjs", ...).
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "src");
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".jsx"];

function resolveAlias(specifier) {
  const rel = specifier.slice(2); // strip "@/"
  const base = path.join(SRC, rel);
  if (existsSync(base) && !path.extname(base)) {
    // directory import → index file
    for (const ext of EXTS) {
      const idx = path.join(base, `index${ext}`);
      if (existsSync(idx)) return pathToFileURL(idx).href;
    }
  }
  if (path.extname(base) && existsSync(base)) return pathToFileURL(base).href;
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const url = resolveAlias(specifier);
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
