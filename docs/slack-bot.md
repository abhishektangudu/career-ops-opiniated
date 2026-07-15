# career-ops Slack bot — setup + local test

Run `/careerops <job url or pasted JD>` from Slack and get back a fit score, a
tailored CV, and links. The bot is `server.mjs` (Express): it verifies the
request, ACKs Slack within 3s, then runs the pipeline in the background
(scrape JD → `gemini-eval.mjs` → `generate-tailored-cv.mjs` → optional Google
sync) and posts the result to the channel via the slash command's
`response_url`.

This doc covers the Slack app setup and running/verifying it **locally**. For
hosting it 24/7, see [`deploy.md`](./deploy.md).

---

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   Name it (e.g. `career-ops`) and pick your workspace.
2. **Slash Commands** → **Create New Command**:
   - Command: `/careerops`
   - Request URL: `https://<tunnel-or-host>/webhook` (fill in after step 4/5 —
     the public HTTPS URL of your tunnel or deployed server)
   - Short description: `Evaluate a job posting and tailor a CV`
   - Usage hint: `<job url or pasted JD>`
3. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**: add `commands`
   (add `chat:write` too if you later post via the bot token instead of the
   response_url).
4. **Install App** → **Install to Workspace**, approve. Copy the
   **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
5. **Basic Information** → **App Credentials** → copy the **Signing Secret** →
   `SLACK_SIGNING_SECRET`.

The signing secret is what the server uses to verify every inbound request
(fail-closed: if `SLACK_SIGNING_SECRET` is unset, Slack requests are rejected).

---

## 2. Run locally with a tunnel

```bash
cp .env.example .env      # then fill GEMINI_API_KEY, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
npm run server            # boots server.mjs on http://localhost:8080

# In another terminal, expose it over HTTPS:
cloudflared tunnel --url http://localhost:8080
#   (or: ngrok http 8080)
```

Copy the tunnel's `https://…` URL, append `/webhook`, and paste it as the slash
command's **Request URL** in the Slack app config. Then, from any channel in
your workspace:

```
/careerops https://boards.example.com/some-job-posting
```

You should get an immediate ACK, then (a few seconds later) the score + links.
A `reports/NNN-*.md` file appears locally, and a tailored PDF in `output/`.

Health check: `curl http://localhost:8080/healthz` → `OK`.

---

## 3. Offline local test (no Slack, no tunnel) via curl

You can exercise `/webhook` directly by signing a request the same way Slack
does: `v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{rawBody}")`.

```bash
export SLACK_SIGNING_SECRET=your_slack_signing_secret_here

# Sample x-www-form-urlencoded slash-command body:
BODY='command=/careerops&text=https://example.com/job&response_url=https://httpbin.org/post'
TS=$(date +%s)

# Compute a valid X-Slack-Signature with a small node one-liner:
SIG=$(node -e '
  const crypto = require("crypto");
  const [ts, body] = [process.argv[1], process.argv[2]];
  const base = `v0:${ts}:${body}`;
  const h = crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET).update(base).digest("hex");
  process.stdout.write("v0=" + h);
' "$TS" "$BODY")

curl -sS -X POST http://localhost:8080/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: $TS" \
  -H "X-Slack-Signature: $SIG" \
  --data "$BODY"
```

Expected: an immediate `200` ACK. The pipeline then runs in the background — a
new `reports/NNN-*.md` should appear within a few seconds (the async result is
POSTed to whatever `response_url` you supplied; `httpbin.org/post` just echoes
it so you can eyeball it). A tampered signature or a timestamp older than ~5 min
returns `401`.

---

## 4. Conversational co-pilot (Events API)

Beyond the `/careerops` slash command, the bot can hold a conversation in a
thread: `@career-ops` in a channel (or DM the bot) and it replies in-thread. It
answers career questions and can run a small set of actions server-side
(evaluate a posting, tailor a CV, or — with a confirm step — update a
tracker status).

### 4.1 Extra OAuth scopes

In **OAuth & Permissions → Scopes → Bot Token Scopes**, add (on top of
`commands`):

- `chat:write` — post the threaded replies via the bot token.
- `app_mentions:read` — receive `@career-ops` mentions.
- `im:history` — read direct messages to the bot.

After changing scopes you must **reinstall the app** (OAuth & Permissions →
**Reinstall to Workspace**) and re-copy the Bot User OAuth Token if it changed
(`SLACK_BOT_TOKEN`).

### 4.2 Enable Event Subscriptions

1. **Event Subscriptions** → toggle **Enable Events** on.
2. **Request URL**: `https://<tunnel-or-host>/webhook` (the SAME endpoint as the
   slash command). Slack sends a one-time `url_verification` challenge; the
   server answers it automatically, so the URL should show **Verified** once the
   server is reachable.
3. **Subscribe to bot events**: add `app_mention` and `message.im`.
4. **Save Changes**, then **reinstall** the app if prompted.

The co-pilot generates replies with the Gemini API key (`GEMINI_API_KEY`, the
same key the evaluation pipeline uses) and posts them into the thread with the
bot token. It ACKs Slack within 3s and does the generation in the background,
and de-dupes Slack's retries (`X-Slack-Retry-Num` / `event_id`) so a slow reply
never double-posts.

**Confirm-gated writes:** a `setStatus` request (e.g. "mark #42 applied") does
NOT write immediately — the bot asks you to reply `yes` in the same thread
first. That pending confirmation is held **in memory** on a single server
instance: it is fine for a personal, single-instance deployment, but it does not
survive a restart and is not shared across instances, so if the server redeploys
between the prompt and your `yes` you'll need to re-issue the request.

### 4.3 Verify

From any channel the bot is in:

```
@career-ops hi
```

You should get a short threaded reply. Then try an action:

```
@career-ops evaluate https://boards.example.com/some-job-posting
```

The bot acknowledges and posts the score into the thread when the pipeline
finishes. A `mark #42 applied` request prompts for a `yes` before it writes to
the tracker.

---

## 5. Telegram (optional, same pipeline)

The server also accepts Telegram webhook updates. Create a bot with
[@BotFather](https://t.me/BotFather), set `TELEGRAM_BOT_TOKEN` and a random
`TELEGRAM_WEBHOOK_SECRET` in `.env`, then register the webhook (Telegram sends
the secret back in the `X-Telegram-Bot-Api-Secret-Token` header, which the
server verifies):

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://<tunnel-or-host>/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Then message the bot a job URL or pasted JD. Same score + links come back.
