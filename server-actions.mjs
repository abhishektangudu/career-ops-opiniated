/**
 * server-actions.mjs — server-side action dispatcher for the Slack co-pilot
 * (Phase 3, Task 12).
 *
 * The web assistant emits action envelopes `<<act:ID {json}>>` inside its reply
 * text; in the browser those are parsed and executed CLIENT-SIDE by
 * web/src/app/actions/registry.ts. A Slack bot proxying the same model gets the
 * envelopes as INERT TEXT, so Slack needs its own server-side executor.
 *
 * This module:
 *   1. mirrors the client `parseEnvelopes` (web/src/components/assistant-console.tsx)
 *      so envelopes are extracted identically (complete `<<act:ID {json}>>`,
 *      skip code fences, tolerate smart quotes / a trailing comma), and
 *   2. dispatches a READ-MOSTLY ALLOWLIST of actions server-side — `evaluate`,
 *      `generatePdf`, and the CONFIRM-GATED `setStatus`. Everything else returns
 *      a short "open the web app for that" no-op so the surface stays small and
 *      safe; more actions can be added incrementally.
 *
 * NOTHING here makes network calls of its own: the evaluate / generatePdf /
 * set-status runners are injected via `ctx` so server.mjs can wire them to the
 * real pipeline and tests can stub them.
 */

import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Envelope parsing — MIRRORS the client parser in assistant-console.tsx so the
// server executes exactly the envelopes the browser would.
// ---------------------------------------------------------------------------

/**
 * Byte ranges of fenced code blocks (```…```). Envelopes inside a fence are
 * illustrative, not actionable, so the parser skips them.
 * @param {string} s
 * @returns {[number, number][]}
 */
export function codeRanges(s) {
  const ranges = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(s))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(i, ranges) {
  return ranges.some(([a, b]) => i >= a && i < b);
}

/**
 * Normalize a JSON-ish args string so JSON.parse tolerates model quirks:
 * smart quotes → straight quotes and a single trailing comma before `}`.
 * @param {string} s
 * @returns {string}
 */
export function normalizeJson(s) {
  return s
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*}$/, '}')
    .trim();
}

/**
 * Extract complete `<<act:ID {json}>>` envelopes from `text`.
 * An envelope is opened by `<<act:ID` + whitespace and closed by the next `>>`.
 * Matches the client regex `/<<act:([a-zA-Z]+)[ \t]+/g` exactly.
 *
 * @param {string} text
 * @returns {{ complete: {start:number,end:number,id:string,argsJson:string}[], hidePartialFrom:number }}
 */
export function parseEnvelopes(text) {
  const acc = typeof text === 'string' ? text : '';
  const ranges = codeRanges(acc);
  const complete = [];
  let hidePartialFrom = -1;
  const open = /<<act:([a-zA-Z]+)[ \t]+/g;
  let m;
  while ((m = open.exec(acc))) {
    const start = m.index;
    if (inRanges(start, ranges)) continue;
    const argsStart = m.index + m[0].length;
    const close = acc.indexOf('>>', argsStart);
    if (close === -1) {
      if (hidePartialFrom === -1 || start < hidePartialFrom) hidePartialFrom = start;
      continue;
    }
    complete.push({ start, end: close + 2, id: m[1], argsJson: acc.slice(argsStart, close).trim() });
  }
  return { complete, hidePartialFrom };
}

/**
 * Remove `[start,end)` cuts from a string (merging overlaps), the same helper
 * the client uses to hide envelopes from the visible transcript.
 */
function removeRanges(s, cuts) {
  if (!cuts.length) return s;
  const merged = [...cuts].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out += s.slice(pos, a);
    pos = Math.max(pos, b);
  }
  out += s.slice(pos);
  return out;
}

/**
 * Return the user-visible text with every complete envelope (and any trailing
 * partial envelope) stripped out, collapsed whitespace. This is what we post
 * into Slack instead of the raw model text.
 * @param {string} text
 * @returns {string}
 */
export function stripEnvelopes(text) {
  const acc = typeof text === 'string' ? text : '';
  const { complete, hidePartialFrom } = parseEnvelopes(acc);
  const cuts = complete.map((e) => [e.start, e.end]);
  if (hidePartialFrom !== -1) cuts.push([hidePartialFrom, acc.length]);
  return removeRanges(acc, cuts).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Action allowlist
// ---------------------------------------------------------------------------

/** Actions we actually execute server-side (read-mostly). */
export const ALLOWED_ACTIONS = new Set(['evaluate', 'generatePdf', 'setStatus']);

/**
 * Actions the web registry supports but which are web-app-only for now. Kept as
 * an explicit list for documentation / tests; anything not in ALLOWED_ACTIONS
 * gets the same no-op reply regardless.
 */
export const WEB_ONLY_ACTIONS = new Set([
  'navigate',
  'filterPipeline',
  'apply',
  'setProfile',
  'setPortals',
  'evaluateCompany',
  'research',
  'setApplyField',
  'remember',
]);

const WEB_ONLY_MESSAGE = 'That action is only available in the web app.';

// Confirm-gated pending actions, keyed by `${channel}:${thread}`. This is an
// in-memory map: acceptable for a personal, single-instance tool, but it does
// NOT survive a restart and is NOT shared across instances — if the server
// redeploys between the prompt and the "yes", the user must re-issue the
// action. Documented in docs/slack-bot.md.
const defaultPending = new Map();

// ---------------------------------------------------------------------------
// Default runners (injectable via ctx for tests / for wiring the real pipeline)
// ---------------------------------------------------------------------------

/**
 * Default setStatus runner: shells out to the canonical set-status.mjs CLI.
 * Returns a short user-facing message; never throws.
 */
export function defaultRunSetStatus({ n, status, note } = {}) {
  return new Promise((resolvePromise) => {
    const script = join(__dirname, 'set-status.mjs');
    const args = [script, String(n), String(status), '--json'];
    if (note) args.push('--note', String(note));
    execFile(process.execPath, args, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || '').trim().slice(0, 300);
        resolvePromise({ text: `❌ Could not update the tracker: ${detail}` });
        return;
      }
      resolvePromise({ text: `✅ Marked application #${n} as *${status}*.` });
    });
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a single parsed envelope server-side.
 *
 * @param {string} id - Action id (the `<<act:ID ...>>` id).
 * @param {object} args - Parsed JSON args.
 * @param {object} [ctx] - Injection / context:
 *   @param {(args:object)=>Promise<{text:string}>} [ctx.runEvaluate] - runs the eval pipeline on a URL.
 *   @param {(args:object)=>Promise<{text:string}>} [ctx.runGeneratePdf] - tailors a CV PDF for #n.
 *   @param {(args:object)=>Promise<{text:string}>} [ctx.runSetStatus] - executes the status write.
 *   @param {Map} [ctx.pending] - the confirm-gate pending map.
 *   @param {string} [ctx.threadKey] - `${channel}:${thread}` key for the confirm gate.
 * @returns {Promise<{text:string, confirm?:boolean, executed?:boolean}>}
 */
export async function dispatchAction(id, args = {}, ctx = {}) {
  if (!id || !ALLOWED_ACTIONS.has(id)) {
    return { text: WEB_ONLY_MESSAGE };
  }

  if (id === 'evaluate') {
    const url = args && args.url;
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return { text: '⚠️ I need a real posting URL (https://…) to evaluate.' };
    }
    const runner = ctx.runEvaluate;
    if (typeof runner !== 'function') {
      return { text: '⚠️ Evaluation is not available on this server.' };
    }
    return await runner(args);
  }

  if (id === 'generatePdf') {
    const n = args && args.n;
    if (n == null || String(n).trim() === '') {
      return { text: '⚠️ Tell me which application number to tailor a CV for (e.g. #42).' };
    }
    const runner = ctx.runGeneratePdf;
    if (typeof runner !== 'function') {
      return { text: '⚠️ CV generation is not available on this server.' };
    }
    return await runner(args);
  }

  if (id === 'setStatus') {
    // CONFIRM-GATED: never write immediately. Stash the pending action keyed by
    // the Slack thread and ask the user to confirm with "yes".
    const n = args && args.n;
    const status = args && args.status;
    if (n == null || String(n).trim() === '' || !status) {
      return { text: '⚠️ setStatus needs an application number and a status.' };
    }
    const pending = ctx.pending || defaultPending;
    const key = ctx.threadKey || 'default';
    pending.set(key, { id, args, at: Date.now() });
    return {
      text: `You want to set application #${n} to *${status}*. Reply \`yes\` to confirm.`,
      confirm: true,
    };
  }

  return { text: WEB_ONLY_MESSAGE };
}

// ---------------------------------------------------------------------------
// Confirm-gate helpers
// ---------------------------------------------------------------------------

/** Does the given Slack thread have a pending confirm-gated action? */
export function hasPending(threadKey, ctx = {}) {
  const pending = ctx.pending || defaultPending;
  return pending.has(threadKey || 'default');
}

/**
 * Is `text` an affirmative confirmation ("yes", "y", "confirm", "yep", "ok")?
 * Tolerant of surrounding whitespace / punctuation and case.
 */
export function isAffirmative(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  return t === 'yes' || t === 'y' || t === 'confirm' || t === 'yep' || t === 'yeah' || t === 'ok' || t === 'okay';
}

/**
 * Execute the pending confirm-gated action for a thread, then clear it.
 * Returns the runner's result message, or null if there was nothing pending.
 *
 * @param {string} threadKey
 * @param {object} [ctx] - same injection surface as dispatchAction; uses
 *   ctx.runSetStatus (default: defaultRunSetStatus) for setStatus.
 * @returns {Promise<{text:string, executed?:boolean}|null>}
 */
export async function confirmPending(threadKey, ctx = {}) {
  const pending = ctx.pending || defaultPending;
  const key = threadKey || 'default';
  const p = pending.get(key);
  if (!p) return null;
  pending.delete(key);
  if (p.id === 'setStatus') {
    const runner = ctx.runSetStatus || defaultRunSetStatus;
    const result = await runner(p.args);
    return { ...result, executed: true };
  }
  return null;
}

/** Clear any pending action for a thread (e.g. the user said "no"/changed topic). */
export function clearPending(threadKey, ctx = {}) {
  const pending = ctx.pending || defaultPending;
  pending.delete(threadKey || 'default');
}

/**
 * Parse all envelopes from model text and dispatch them, returning the visible
 * text (envelopes stripped) plus the dispatch result messages. Bad-JSON
 * envelopes are skipped (mirrors the client's tolerant JSON.parse behavior).
 *
 * @param {string} text
 * @param {object} [ctx]
 * @returns {Promise<{visible:string, results:{text:string,confirm?:boolean}[]}>}
 */
export async function dispatchEnvelopes(text, ctx = {}) {
  const { complete } = parseEnvelopes(text);
  const results = [];
  for (const env of complete) {
    let args = {};
    if (env.argsJson) {
      try {
        args = JSON.parse(normalizeJson(env.argsJson));
      } catch {
        continue; // skip malformed envelope, same as the client
      }
    }
    results.push(await dispatchAction(env.id, args, ctx));
  }
  return { visible: stripEnvelopes(text), results };
}
