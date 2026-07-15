import 'dotenv/config';
import express from 'express';
import { execFile } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync, existsSync } from 'fs';
import https from 'https';
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
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
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

      // 3. Find the newly created report file
      const reportsDir = join(__dirname, 'reports');
      const files = readdirSync(reportsDir).filter(f => /^\d{3}-/.test(f));
      files.sort((a, b) => b.localeCompare(a)); // Sort descending to get latest
      const latestReport = files[0];
      
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
