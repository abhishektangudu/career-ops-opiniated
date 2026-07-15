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

## 4. Telegram (optional, same pipeline)

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
