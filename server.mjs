import 'dotenv/config';
import express from 'express';
import { execFile } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, existsSync } from 'fs';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

// Import Google sync functions
import { 
  syncTrackerToSheets, 
  syncScanHistoryToSheets, 
  uploadToDriveAndGetLink,
  uploadToGcsAndGetLink
} from './sync-google.mjs';

// Import Playwright scraper and CV tailor
import { scrapeJobDescription } from './scrape-jd.mjs';
import { generateTailoredCV } from './generate-tailored-cv.mjs';

// Gemini API-key text generation (Decision 5b — same pattern as gemini-eval.mjs).
import { GoogleGenerativeAI } from '@google/generative-ai';

// Server-side action dispatcher for the Slack co-pilot (Phase 3, Task 12).
import {
  dispatchEnvelopes,
  hasPending,
  isAffirmative,
  confirmPending,
  clearPending,
} from './server-actions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Capture the raw request bytes so we can compute the Slack HMAC over the exact
// body Slack signed. The global body parsers consume the stream, so this
// `verify` hook is the only reliable place to stash the bytes.
const captureRawBody = (req, _res, buf) => { req.rawBody = buf; };
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));

// Serve tailored CVs and reports statically
app.use('/output', express.static(join(__dirname, 'output')));
app.use('/reports', express.static(join(__dirname, 'reports')));

const PORT = process.env.PORT || 8080;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const STORAGE_BUCKET = process.env.GOOGLE_STORAGE_BUCKET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Auth secrets. Each auth path is independent and FAILS CLOSED: if the relevant
// secret is unset, requests for that path are rejected (never accepted unsigned).
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const SERVER_API_KEY = process.env.SERVER_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Free-tier model shared with gemini-eval.mjs; overridable via env.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Slack's anti-replay window: reject request timestamps older than 5 minutes.
const SLACK_MAX_SKEW_SECONDS = 60 * 5;

// ---------------------------------------------------------------------------
// Auth helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Verify a Slack request signature per Slack's spec.
 * Computes HMAC-SHA256(secret, `v0:{timestamp}:{rawBody}`) and timing-safe
 * compares it to the provided `v0=<hex>` signature. Also enforces the anti-replay
 * window on the timestamp. FAILS CLOSED: any missing input (secret, timestamp,
 * signature, or body) returns false.
 *
 * @param {Buffer|string} rawBody - The exact raw request body bytes.
 * @param {string} timestamp - The X-Slack-Request-Timestamp header (unix seconds).
 * @param {string} signature - The X-Slack-Signature header (`v0=<hex>`).
 * @param {string} secret - The Slack signing secret.
 * @param {number} [now=Date.now()] - Current time in ms (injectable for tests).
 * @returns {boolean} True only if the signature is valid and fresh.
 */
export function verifySlackSignature(rawBody, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !timestamp || !signature || rawBody == null) return false;

  // Anti-replay: reject stale (or non-numeric) timestamps.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - ts) > SLACK_MAX_SKEW_SECONDS) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const base = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(String(signature), 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Does a parsed request body look like a Slack request? True for slash commands
 * (`command` + `response_url`) and future Events API payloads (a Slack `type`).
 * Used to enforce Slack HMAC for ALL Slack-shaped requests so an attacker cannot
 * bypass auth by omitting the signature header.
 *
 * @param {object} body - The parsed request body.
 * @returns {boolean}
 */
export function isSlackShapedBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.command && body.response_url) return true;
  // Events API / interactivity payloads carry a Slack `type`.
  if (typeof body.type === 'string' && body.type.length > 0) return true;
  return false;
}

/**
 * Parse the exact saved report filename from gemini-eval.mjs stdout.
 * gemini-eval.mjs prints `✅  Report saved: reports/{filename}` — consuming that
 * exact file avoids a concurrency race where rediscovering "latest" by sorting
 * reports/ could pick another overlapping request's freshly-created report.
 *
 * @param {string} stdout - The eval process stdout.
 * @returns {string|null} The report filename (e.g. `007-foo.md`), or null if the
 *   line can't be parsed (caller should fall back to sort-latest).
 */
export function parseReportFilenameFromStdout(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  // Match `Report saved: reports/<filename>` tolerating the emoji/whitespace
  // prefix and an optional leading `reports/` path segment.
  const m = stdout.match(/Report saved:\s*(?:reports[/\\])?([^\s/\\]+\.md)\b/);
  return m ? m[1] : null;
}

/**
 * Build the argv array for invoking gemini-eval.mjs.
 * IMPORTANT: gemini-eval.mjs has NO `--url` flag; any non-flag arg is treated as
 * JD text. So we pass ONLY the scraped JD text — never the URL (which would leak
 * into the evaluated text and pollute the eval).
 *
 * @param {string} evalScript - Absolute path to gemini-eval.mjs.
 * @param {string} jdText - The scraped job description text.
 * @returns {string[]} argv for execFile (excluding the node executable).
 */
export function buildEvalArgs(evalScript, jdText) {
  return [evalScript, jdText];
}

// ---------------------------------------------------------------------------
// Health check endpoints
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('🤖 career-ops webhook server is running! Point your Slack/Telegram/WhatsApp webhooks here.');
});

// ---------------------------------------------------------------------------
// Helper: Send Slack Callback message
// ---------------------------------------------------------------------------
function postToSlack(responseUrl, textMessage) {
  const data = JSON.stringify({
    text: textMessage,
    response_type: 'in_channel',
    replace_original: true
  });

  const url = new URL(responseUrl);
  // Slack response_url is always https in production; honor http for local,
  // in-process test servers so the suite never needs real outbound network.
  const transport = url.protocol === 'http:' ? http : https;
  const options = {
    hostname: url.hostname,
    port: url.port || undefined,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = transport.request(options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => { responseBody += chunk; });
    res.on('end', () => {
      console.log(`[slack] Postback response status: ${res.statusCode}`);
      if (res.statusCode !== 200) {
        console.error(`[slack] Postback failed response body: ${responseBody}`);
      }
    });
  });
  
  req.on('error', (err) => {
    console.error('[slack] Network post back failed:', err.message);
  });

  req.write(data);
  req.end();
}

// ---------------------------------------------------------------------------
// Helper: Send Telegram Message
// ---------------------------------------------------------------------------
function postToTelegram(chatId, textMessage) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[telegram] Bot token not set. Cannot reply to chat.');
    return;
  }

  const data = JSON.stringify({
    chat_id: chatId,
    text: textMessage,
    parse_mode: 'Markdown'
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });
  
  req.on('error', (err) => {
    console.error('[telegram] Failed to send message:', err.message);
  });
  
  req.write(data);
  req.end();
}

// ---------------------------------------------------------------------------
// Helper: Post a message into a Slack thread via the Web API (chat.postMessage).
// Used by the Events-API co-pilot (Task 11), which replies in-thread with the
// bot token rather than a slash-command response_url. Returns a promise so the
// dispatcher can await ordered posts.
// ---------------------------------------------------------------------------
function postToSlackThread(channel, threadTs, textMessage) {
  return new Promise((resolvePromise) => {
    if (!SLACK_BOT_TOKEN) {
      console.warn('[slack] SLACK_BOT_TOKEN not set. Cannot post to thread.');
      return resolvePromise(false);
    }
    if (!channel) {
      console.warn('[slack] No channel to post to.');
      return resolvePromise(false);
    }
    const payload = { channel, text: textMessage };
    if (threadTs) payload.thread_ts = threadTs;
    const data = JSON.stringify(payload);

    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (!parsed.ok) console.error('[slack] chat.postMessage error:', parsed.error);
        } catch {
          console.error('[slack] chat.postMessage: non-JSON response');
        }
        resolvePromise(true);
      });
    });
    req.on('error', (err) => {
      console.error('[slack] chat.postMessage failed:', err.message);
      resolvePromise(false);
    });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Slack co-pilot (Events API) — Gemini reply bridge (Task 11)
// ---------------------------------------------------------------------------

// Slack resends an event on any non-200 / slow ACK. De-dupe on event_id (and
// the retry header) so a redelivery never double-posts. Bounded to avoid
// unbounded growth on a long-lived instance.
const seenSlackEvents = new Set();
const SEEN_EVENTS_MAX = 500;
function alreadyProcessedSlackEvent(eventId) {
  if (!eventId) return false;
  if (seenSlackEvents.has(eventId)) return true;
  seenSlackEvents.add(eventId);
  if (seenSlackEvents.size > SEEN_EVENTS_MAX) {
    // Drop the oldest ~half (insertion order) to cap memory.
    const drop = Math.floor(SEEN_EVENTS_MAX / 2);
    let i = 0;
    for (const k of seenSlackEvents) {
      seenSlackEvents.delete(k);
      if (++i >= drop) break;
    }
  }
  return false;
}

// System prompt for the Slack co-pilot. Adapted from the web assistant's
// SYSTEM_PREAMBLE but SLACK-appropriate: no web-only UI framing, replies kept
// short. The action envelopes it may emit are executed server-side by
// server-actions.mjs (read-mostly allowlist); everything else is web-app-only.
const SLACK_COPILOT_PROMPT = `You are the career-ops co-pilot — a proactive, friendly career assistant for a person who is actively job-hunting. You answer over Slack, so keep replies SHORT (a few sentences), plain, and useful. No markdown headers, no long dumps.

You can DO a few things by emitting an ACTION ENVELOPE inside your reply. An envelope is ONE line, on its own line (never inside a code fence):
<<act:ACTION_ID {"arg":"value"}>>
The server parses the envelope and performs the action, then posts the result into this thread — so just say briefly what you're doing, then emit the envelope.

ACTIONS AVAILABLE OVER SLACK:
- evaluate {"url":"https://…"} — evaluate a SPECIFIC job posting URL (scores it A–F and tailors a CV). Only when you actually have a real URL from the user.
- generatePdf {"n":"42"} — generate an ATS-optimized CV tailored to a already-evaluated application #42.
- setStatus {"n":"42","status":"Applied"} — move a tracked application to a new state (the server will ask the user to confirm before writing). Canonical states: Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP.

Any other action (navigate, filter, apply, editing the profile, research, etc.) is only available in the web app — if the user asks for one, tell them to open the web app for that; do NOT emit an envelope for it.

RULES: NEVER invent URLs. Spending actions cost the user tokens — only fire them when clearly asked or clearly useful. Answer general career questions directly, warmly, and briefly.`;

/**
 * Generate a co-pilot reply with the Gemini API-key path (reuses GEMINI_API_KEY,
 * same @google/generative-ai pattern as gemini-eval.mjs). Returns the raw model
 * text (envelopes intact — the caller strips + dispatches them). Injectable via
 * the `gen` param so tests never touch the network.
 *
 * @param {string} userText - The user's message (mention stripped).
 * @param {(prompt:string)=>Promise<string>} [gen] - Optional generator override.
 * @returns {Promise<string>}
 */
async function generateCopilotReply(userText, gen) {
  if (typeof gen === 'function') return await gen(userText);
  if (!GEMINI_API_KEY) {
    return "I can't reach my AI right now (GEMINI_API_KEY isn't set on the server).";
  }
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
  });
  try {
    const result = await model.generateContent([
      { text: SLACK_COPILOT_PROMPT },
      { text: `\n\nUser: ${userText}\nAssistant:` },
    ]);
    return result.response.text();
  } catch (err) {
    const sanitized = (err.message || '').split(GEMINI_API_KEY).join('[REDACTED]');
    console.error('[copilot] Gemini error:', sanitized);
    return "Sorry — I hit an error generating a reply. Try again in a moment.";
  }
}

/**
 * Build the action-dispatch ctx for a given Slack thread: wires the read-mostly
 * runners (evaluate/generatePdf/setStatus) to the real pipeline + CLIs and keys
 * the confirm-gate on channel+thread.
 */
function buildActionCtx({ channel, threadTs, baseUrl, userId, teamId }) {
  const threadKey = `${channel}:${threadTs || channel}`;
  return {
    threadKey,
    // Bind confirm-gated writes to the requesting Slack user/workspace so another
    // user in a shared channel thread can't fire someone else's tracker write.
    userId: userId || null,
    teamId: teamId || null,
    // evaluate {url} → run the Phase-1 pipeline, posting progress + result into
    // the thread. Resolves once kicked off (the pipeline posts asynchronously).
    runEvaluate: async (args) => {
      runAsyncPipeline({
        jdUrl: args.url,
        jdText: '',
        source: 'slack-thread',
        responseTarget: { channel, threadTs },
        baseUrl,
      }).catch((err) => console.error('[copilot-evaluate] pipeline error:', err));
      return { text: `⏳ Evaluating ${args.url} — I'll post the score here when it's ready.` };
    },
    // generatePdf {n} → tailor a CV for an already-evaluated application #n,
    // using the stored report as the JD context.
    runGeneratePdf: async (args) => runGeneratePdfForApp(args.n, baseUrl),
    // setStatus runner is the module default (shells out to set-status.mjs) —
    // no override needed here.
  };
}

/**
 * generatePdf runner: find report #n, tailor a CV from it, and return a link.
 */
async function runGeneratePdfForApp(n, baseUrl) {
  try {
    const num = String(n).trim().padStart(3, '0');
    const reportsDir = join(__dirname, 'reports');
    const files = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.startsWith(`${num}-`) && f.endsWith('.md'))
      : [];
    if (files.length === 0) {
      return { text: `⚠️ I couldn't find an evaluation report for application #${n}. Evaluate it first.` };
    }
    const reportPath = join(reportsDir, files[0]);
    const reportContent = readFileSync(reportPath, 'utf8');
    const companyMatch = reportContent.match(/# Evaluation:\s*(.*?)\s*—/);
    const roleMatch = reportContent.match(/# Evaluation:.*?—\s*(.*?)$/m);
    const companyName = companyMatch ? companyMatch[1].trim() : 'Company';
    const roleTitle = roleMatch ? roleMatch[1].trim() : 'Role';

    const cvResults = await generateTailoredCV(reportContent, companyName, roleTitle);
    let pdfLink = `${baseUrl}/output/${cvResults.pdfFilename}`;
    if (STORAGE_BUCKET) {
      try {
        pdfLink = await uploadToGcsAndGetLink(cvResults.pdfFilename, cvResults.pdfPath, STORAGE_BUCKET);
      } catch (gcsErr) {
        console.warn('[gcs] generatePdf upload failed:', gcsErr.message);
      }
    } else if (DRIVE_FOLDER_ID) {
      try {
        pdfLink = await uploadToDriveAndGetLink(cvResults.pdfFilename, cvResults.pdfPath, DRIVE_FOLDER_ID);
      } catch (driveErr) {
        console.warn('[drive] generatePdf upload failed:', driveErr.message);
      }
    }
    return { text: `📄 Tailored CV for #${n} (${companyName}): ${pdfLink}` };
  } catch (err) {
    console.error('[copilot-generatePdf] error:', err.message);
    return { text: `❌ Could not generate the CV for #${n}: ${err.message}` };
  }
}

/**
 * Handle one Slack co-pilot event (app_mention / message.im) in the background:
 * confirm-gate follow-ups first, else generate a reply, strip + dispatch
 * envelopes, and post everything into the thread. `gen` is injectable for tests.
 */
async function handleCopilotEvent({ channel, threadTs, text, baseUrl, userId, teamId }, gen) {
  const ctx = buildActionCtx({ channel, threadTs, baseUrl, userId, teamId });
  const post = (msg) => postToSlackThread(channel, threadTs, msg);

  const cleaned = (text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();

  // 1. Confirm-gate follow-up: if this thread has a pending write and the SAME
  // user said "yes", execute it. A "yes" from a DIFFERENT user is ignored (the
  // pending action stays for the rightful user). Any other message from the
  // requester drops the pending action and falls through to a normal reply.
  if (hasPending(ctx.threadKey, ctx)) {
    if (isAffirmative(cleaned)) {
      const result = await confirmPending(ctx.threadKey, ctx);
      // mismatch: a different user tried to confirm — leave it pending, say nothing.
      if (result && result.mismatch) return;
      if (result) return post(result.text);
    } else {
      clearPending(ctx.threadKey, ctx);
    }
  }

  // 2. Generate a reply, strip/hide envelopes, dispatch them server-side.
  const raw = await generateCopilotReply(cleaned, gen);
  const { visible, results } = await dispatchEnvelopes(raw, ctx);
  if (visible) await post(visible);
  for (const r of results) {
    if (r && r.text) await post(r.text);
  }
}

// ---------------------------------------------------------------------------
// Main Evaluation & Sync Pipeline
// ---------------------------------------------------------------------------
async function runAsyncPipeline({ jdUrl, jdText, source, responseTarget, baseUrl }) {
  console.log(`[pipeline] Starting evaluation pipeline. Source: ${source}`);
  
  let finalJdText = jdText;
  let pageTitle = '';
  
  try {
    // 1. Scrape if URL is provided
    if (jdUrl) {
      const scraped = await scrapeJobDescription(jdUrl);
      finalJdText = scraped.text;
      pageTitle = scraped.title;
    }
    
    if (!finalJdText || finalJdText.length < 100) {
      throw new Error('No valid job description text found.');
    }

    // Send a processing update back to Slack/Telegram
    const updateMsg = `⏳ Job description loaded. Running Gemini evaluation...`;
    sendResponse(source, responseTarget, updateMsg);

    // 2. Run gemini-eval.mjs. gemini-eval.mjs has NO `--url` flag — any non-flag
    // arg is treated as JD text — so pass ONLY the scraped JD text (finalJdText).
    const evalScript = join(__dirname, 'gemini-eval.mjs');
    const evalArgs = buildEvalArgs(evalScript, finalJdText);

    execFile(process.execPath, evalArgs, { cwd: __dirname }, async (error, stdout, stderr) => {
      if (error) {
        console.error('[eval] Script error:', error.message);
        console.error('[eval] Script stdout:', stdout);
        console.error('[eval] Script stderr:', stderr);
        sendResponse(source, responseTarget, `❌ Evaluation failed: ${error.message}`);
        return;
      }

      console.log('[eval] Evaluation completed successfully.');

      // 3. Identify the report this eval produced. Prefer the EXACT path the
      // eval printed to stdout (`✅  Report saved: reports/<file>`) so overlapping
      // requests can't pick each other's report. Fall back to sort-latest only
      // if that line can't be parsed (defensive; e.g. output format changed).
      const reportsDir = join(__dirname, 'reports');
      let latestReport = parseReportFilenameFromStdout(stdout);
      if (latestReport && !existsSync(join(reportsDir, latestReport))) {
        console.warn(`[eval] Parsed report ${latestReport} not found on disk; falling back to sort-latest.`);
        latestReport = null;
      }
      if (!latestReport) {
        const files = readdirSync(reportsDir).filter(f => /^\d{3}-/.test(f));
        files.sort((a, b) => b.localeCompare(a)); // Sort descending to get latest
        latestReport = files[0];
      }

      if (!latestReport) {
        sendResponse(source, responseTarget, `❌ Evaluation succeeded but no report file was found in reports/.`);
        return;
      }

      const reportPath = join(reportsDir, latestReport);
      const reportContent = readFileSync(reportPath, 'utf8');

      // Parse metadata from report
      const companyMatch = reportContent.match(/\*\*Evaluation:\*\*?\s*(.*?)\s*—/m) || reportContent.match(/# Evaluation:\s*(.*?)\s*—/);
      const roleMatch = reportContent.match(/—\s*(.*?)$/m) || reportContent.match(/# Evaluation:.*?—\s*(.*?)$/m);
      const scoreMatch = reportContent.match(/\*\*Score:\*\*?\s*(.*?)$/m);
      const archetypeMatch = reportContent.match(/\*\*Archetype:\*\*?\s*(.*?)$/m);
      
      const companyName = companyMatch ? companyMatch[1].trim() : 'Company';
      const roleTitle = roleMatch ? roleMatch[1].trim() : 'Role';
      const scoreStr = scoreMatch ? scoreMatch[1].trim() : 'N/A';
      const archetype = archetypeMatch ? archetypeMatch[1].trim() : 'N/A';

      // Send update
      sendResponse(source, responseTarget, `📈 Score: ${scoreStr}. Tailoring CV PDF...`);

      // 4. Generate Tailored CV
      let pdfLink = 'Error generating CV';
      let cvTailorError = null;
      
      try {
        const cvResults = await generateTailoredCV(finalJdText, companyName, roleTitle);
        pdfLink = `${baseUrl}/output/${cvResults.pdfFilename}`;
        
        // 5. Upload Tailored CV PDF to Google Cloud Storage (preferred) or Google Drive
        if (STORAGE_BUCKET) {
          try {
            const gcsLink = await uploadToGcsAndGetLink(cvResults.pdfFilename, cvResults.pdfPath, STORAGE_BUCKET);
            pdfLink = gcsLink;
          } catch (gcsErr) {
            console.warn('[gcs] Failed to upload PDF to GCS:', gcsErr.message);
          }
        }

        if (DRIVE_FOLDER_ID) {
          try {
            const driveLink = await uploadToDriveAndGetLink(cvResults.pdfFilename, cvResults.pdfPath, DRIVE_FOLDER_ID);
            if (!STORAGE_BUCKET || pdfLink.includes(baseUrl)) {
              pdfLink = driveLink;
            }
          } catch (driveErr) {
            console.warn('[drive] Failed to upload PDF to Google Drive, using self-hosted link:', driveErr.message);
          }
        }
      } catch (err) {
        console.error('[cv-tailor] Error tailoring CV:', err.message);
        cvTailorError = err.message;
      }

      // 6. Upload Evaluation Report MD to Google Cloud Storage (preferred) or Google Drive
      let reportLink = `${baseUrl}/reports/${latestReport}`;
      if (STORAGE_BUCKET) {
        try {
          const gcsLink = await uploadToGcsAndGetLink(latestReport, reportPath, STORAGE_BUCKET);
          reportLink = gcsLink;
        } catch (gcsErr) {
          console.warn('[gcs] Failed to upload Report to GCS:', gcsErr.message);
        }
      }

      if (DRIVE_FOLDER_ID) {
        try {
          const driveLink = await uploadToDriveAndGetLink(latestReport, reportPath, DRIVE_FOLDER_ID);
          if (!STORAGE_BUCKET || reportLink.includes(baseUrl)) {
            reportLink = driveLink;
          }
        } catch (driveErr) {
          console.warn('[drive] Failed to upload Report to Google Drive, using self-hosted link:', driveErr.message);
        }
      }

      // 7. Sync tracker and scan history to Google Sheets
      if (SPREADSHEET_ID) {
        try {
          const trackerPath = join(__dirname, 'data', 'applications.md');
          const scanHistoryPath = join(__dirname, 'data', 'scan-history.tsv');
          await syncTrackerToSheets(trackerPath, SPREADSHEET_ID, 'Applications', STORAGE_BUCKET);
          await syncScanHistoryToSheets(scanHistoryPath, SPREADSHEET_ID);
        } catch (err) {
          console.error('[sheets] Sheets sync error:', err.message);
        }
      }

      // 8. Build final markdown output and send to chat client
      const finalMsg = [
        `✅ *Evaluation Complete!*`,
        `🏢 *Company:* ${companyName}`,
        `💼 *Role:* ${roleTitle}`,
        `🎯 *Archetype:* ${archetype}`,
        `📊 *Score:* ${scoreStr}`,
        ``,
        `📝 *Evaluation Report (GDrive):* [Open Link](${reportLink})`,
        `📄 *Tailored CV PDF (GDrive):* ${pdfLink.startsWith('http') ? `[Open Link](${pdfLink})` : `_${pdfLink}_`}`,
        cvTailorError ? `⚠️ _CV Tailoring Note: ${cvTailorError}_` : ''
      ].filter(Boolean).join('\n');

      sendResponse(source, responseTarget, finalMsg);
    });
    
  } catch (err) {
    console.error('[pipeline] Critical error:', err.message);
    sendResponse(source, responseTarget, `❌ Error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: Send message to the correct platform
// ---------------------------------------------------------------------------
function sendResponse(source, target, message) {
  if (source === 'slack') {
    postToSlack(target, message);
  } else if (source === 'slack-thread') {
    // Events-API co-pilot: target is { channel, threadTs }; post via bot token.
    postToSlackThread(target && target.channel, target && target.threadTs, message);
  } else if (source === 'telegram') {
    postToTelegram(target, message);
  } else {
    console.log(`[local-log] Response:`, message);
  }
}

// ---------------------------------------------------------------------------
// Helper: reject a request as unauthorized (logs the reason, sends 401).
// Centralizes the fail-closed response so every auth path is identical.
// ---------------------------------------------------------------------------
function rejectUnauthorized(res, reason) {
  console.warn(`[auth] ${reason}`);
  return res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  // -------------------------------------------------------------------------
  // Authentication. Three INDEPENDENT paths, each FAILS CLOSED on a missing
  // secret. Enforced BEFORE any body handling so unauthenticated requests never
  // reach the pipeline.
  // -------------------------------------------------------------------------
  const body = req.body || {};

  if (isSlackShapedBody(body)) {
    // Slack: enforce HMAC for ALL Slack-shaped requests (do NOT gate on the
    // header being present — an attacker could otherwise omit it and bypass
    // auth). Fail closed if the signing secret is unset.
    if (!SLACK_SIGNING_SECRET) {
      return rejectUnauthorized(res, 'Rejecting Slack-shaped request: SLACK_SIGNING_SECRET is not set.');
    }
    const timestamp = req.get('X-Slack-Request-Timestamp');
    const signature = req.get('X-Slack-Signature');
    if (!verifySlackSignature(req.rawBody, timestamp, signature, SLACK_SIGNING_SECRET)) {
      return rejectUnauthorized(res, 'Rejecting Slack request: invalid or missing signature.');
    }
  } else if (body.message && body.message.chat) {
    // Telegram: verify the secret token header. Fail closed if unset.
    if (!TELEGRAM_WEBHOOK_SECRET) {
      return rejectUnauthorized(res, 'Rejecting Telegram request: TELEGRAM_WEBHOOK_SECRET is not set.');
    }
    const provided = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (provided !== TELEGRAM_WEBHOOK_SECRET) {
      return rejectUnauthorized(res, 'Rejecting Telegram request: secret token mismatch.');
    }
  } else if (body.url || body.text) {
    // Direct-JSON API: require X-Api-Key (or Bearer) == SERVER_API_KEY. Fail
    // closed if unset.
    if (!SERVER_API_KEY) {
      return rejectUnauthorized(res, 'Rejecting direct API request: SERVER_API_KEY is not set.');
    }
    const apiKey = req.get('X-Api-Key');
    const authHeader = req.get('Authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const provided = apiKey || bearer;
    if (provided !== SERVER_API_KEY) {
      return rejectUnauthorized(res, 'Rejecting direct API request: API key mismatch.');
    }
  }

  // -------------------------------------------------------------------------
  // Slack Events API (Task 11). Events are JSON, so they came through the same
  // fail-closed HMAC path above (isSlackShapedBody matches `type`). Handle the
  // url_verification handshake and app_mention / message.im events here, BEFORE
  // the slash-command / eval routing below.
  // -------------------------------------------------------------------------
  if (body.type === 'url_verification') {
    // Answer Slack's one-time Request-URL challenge.
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.type === 'event_callback') {
    // ACK within 3s no matter what; process in the background.
    res.status(200).send('OK');

    // De-dupe Slack retries (X-Slack-Retry-Num header and/or event_id).
    const retryNum = req.get('X-Slack-Retry-Num');
    const eventId = body.event_id;
    if (alreadyProcessedSlackEvent(eventId)) {
      console.log(`[copilot] Skipping duplicate Slack event ${eventId} (retry ${retryNum || '0'}).`);
      return;
    }

    const event = body.event || {};
    // Only respond to human mentions / DMs — never to our own bot messages or
    // message subtypes (edits, joins, bot_message) to avoid loops.
    const isMention = event.type === 'app_mention';
    const isDirectMessage = event.type === 'message' && event.channel_type === 'im';
    const fromBot = !!event.bot_id || !!event.bot_profile || event.subtype === 'bot_message';
    if ((isMention || isDirectMessage) && !fromBot && event.text) {
      const channel = event.channel;
      // Thread the reply: reuse the message's own thread if any, else start one
      // rooted at this message (app_mention has no thread_ts on the first turn).
      const threadTs = event.thread_ts || event.ts;
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const baseUrl = `${protocol}://${req.get('host')}`;
      // Bind confirm-gated writes to the requester (user + workspace).
      const userId = event.user || null;
      const teamId = body.team_id || (event.team) || null;
      handleCopilotEvent({ channel, threadTs, text: event.text, baseUrl, userId, teamId })
        .catch((err) => console.error('[copilot] event handling error:', err));
    }
    return;
  }

  let jdUrl = '';
  let jdText = '';
  let source = 'direct';
  let responseTarget = null;
  let ackMessage = 'Acknowledged. Processing your request...';

  // 1. Detect Slack Slash Command
  if (req.body.command && req.body.response_url) {
    source = 'slack';
    responseTarget = req.body.response_url;
    const input = req.body.text ? req.body.text.trim() : '';
    if (input.startsWith('http')) {
      jdUrl = input;
    } else {
      jdText = input;
    }
    ackMessage = `Evaluating job offer...`;
  } 
  // 2. Detect Telegram Bot Webhook
  else if (req.body.message && req.body.message.chat) {
    source = 'telegram';
    responseTarget = req.body.message.chat.id;
    const input = req.body.message.text ? req.body.message.text.trim() : '';
    
    // Support "/eval <url>" or just pasting a URL / text
    if (input.startsWith('/eval ')) {
      const arg = input.slice(6).trim();
      if (arg.startsWith('http')) {
        jdUrl = arg;
      } else {
        jdText = arg;
      }
    } else if (input.startsWith('http')) {
      jdUrl = input;
    } else {
      jdText = input;
    }
    ackMessage = `Received. Spawning Playwright container browser...`;
  }
  // 3. Direct JSON API request
  else if (req.body.url || req.body.text) {
    jdUrl = req.body.url || '';
    jdText = req.body.text || '';
    source = req.body.source || 'direct';
    responseTarget = req.body.callback_url || null;
  }

  // Input validation
  if (!jdUrl && !jdText) {
    return res.status(400).json({ error: 'Please provide a "url" or "text" parameter.' });
  }

  // Respond immediately to avoid webhook timeouts (Slack/Telegram/WhatsApp)
  if (source === 'slack') {
    res.json({ text: ackMessage, response_type: 'in_channel' });
  } else if (source === 'telegram') {
    res.status(200).send('OK');
    postToTelegram(responseTarget, ackMessage);
  } else {
    res.status(202).json({ message: 'Request accepted. Processing in background.' });
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;

  // Run the long-running pipeline asynchronously in the background
  runAsyncPipeline({ jdUrl, jdText, source, responseTarget, baseUrl })
    .catch(err => console.error('[webhook-pipeline] Run error:', err));
});

// ---------------------------------------------------------------------------
// Start the server (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`🚀 Webhook server listening on port ${PORT}`);
    console.log(`   Spreadsheet ID: ${SPREADSHEET_ID || 'Not set'}`);
    console.log(`   GDrive Folder ID: ${DRIVE_FOLDER_ID || 'Not set'}`);
    console.log(`   GCS Storage Bucket: ${STORAGE_BUCKET || 'Not set'}`);
  });
}

export { app };
