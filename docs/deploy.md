# Deploying the career-ops server (Cloud Run)

Host `server.mjs` 24/7 so `/careerops` works from your phone without the laptop
running. Recommended target: **Google Cloud Run** — it maps cleanly to how the
code already authenticates to Google APIs (Application Default Credentials =
the runtime service account, so no `sa-key.json` is ever shipped), gives you
native `$PORT`, Secret Manager, and HTTPS.

For the Slack app setup and local testing, see [`slack-bot.md`](./slack-bot.md).

> **Read the Persistence section before you deploy.** Cloud Run's filesystem is
> ephemeral, and the Sheets sync is destructive — without a durable volume you
> can lose data on the next eval after a restart.

---

## 1. Build and push the image

Uses [`Dockerfile.server`](../Dockerfile.server) (server-only, lean — no Go/TeX).

```bash
PROJECT=your-gcp-project
REGION=us-central1
IMAGE=$REGION-docker.pkg.dev/$PROJECT/careerops/careerops-server:latest

# One-time: create an Artifact Registry repo
gcloud artifacts repositories create careerops \
  --repository-format=docker --location=$REGION

gcloud auth configure-docker $REGION-docker.pkg.dev
docker build -f Dockerfile.server -t "$IMAGE" .
docker push "$IMAGE"
```

(Or let Cloud Build do it: `gcloud run deploy --source .` — but then point it at
`Dockerfile.server`, e.g. via a `cloudbuild.yaml` or by renaming; the explicit
`docker build -f` above is simplest.)

---

## 2. Persistence — REQUIRED (do not skip)

### Why this matters

Cloud Run instances have an **ephemeral filesystem**. After a redeploy or a
scale-to-zero restart, `data/`, `reports/`, and `output/` come back **empty**.

That is dangerous because `sync-google.mjs → syncTrackerToSheets()` is
**destructive**: it does `sheets.spreadsheets.values.clear(<tab>!A1:Z1000)` and
then rewrites the tab from the **local** `data/applications.md`. So if the local
tracker is empty/stale after a restart, the next `/careerops` eval would **wipe
every previously-synced row from the Sheet** — worse than having no sync at all.

There are two layers of protection; **use both**:

### (a) PRIMARY — mount a durable volume at `data/`, `reports/`, `output/`

Mounting persistent storage at those three directories keeps the canonical
files across restarts, so the code path is **identical to local** and the files
stay canonical per the repo's data contract (`DATA_CONTRACT.md`). Pick one host:

**Cloud Run 2nd gen + GCS volume (gcsfuse):**

```bash
gcloud run deploy careerops-server \
  --image "$IMAGE" --region "$REGION" \
  --execution-environment gen2 \
  --add-volume=name=careerops-data,type=cloud-storage,bucket=YOUR_STATE_BUCKET \
  --add-volume-mount=volume=careerops-data,mount-path=/app/data \
  --add-volume=name=careerops-reports,type=cloud-storage,bucket=YOUR_STATE_BUCKET \
  --add-volume-mount=volume=careerops-reports,mount-path=/app/reports \
  --add-volume=name=careerops-output,type=cloud-storage,bucket=YOUR_STATE_BUCKET \
  --add-volume-mount=volume=careerops-output,mount-path=/app/output
  # ...plus the flags from sections 3–5 below
```

> **gcsfuse caveat:** GCS-FUSE is not a POSIX filesystem — no atomic renames,
> weak concurrent-write consistency, and higher latency. Combined with
> `--concurrency=1` and a single instance (section 4) this is fine for a
> personal tool, but do **not** run multiple concurrent writers against it.

**Fly.io persistent volume (alternative host):** Fly gives you a real
block-device volume. Attach one and mount the three dirs into it. **A Fly volume
is single-instance** (it binds to one machine) — keep the app at one machine so
there is exactly one writer. On Fly, ADC needs a key file (set
`GOOGLE_APPLICATION_CREDENTIALS`), unlike Cloud Run.

### (b) DEFENSIVE — the empty-tracker guard (already in the code)

Even with a volume, a misconfiguration could leave the tracker empty.
`syncTrackerToSheets()` now bails out before the destructive clear+update when
the local tracker is missing or has no data rows, logging:

```
[sheets] local tracker empty — skipping destructive sync to avoid wiping remote rows
```

This is a backstop, not a substitute for the volume — with no volume you simply
stop syncing new evals (they don't persist), rather than losing existing rows.

### (c) OPTIONAL — commit markdown back to the fork

A stronger way to keep the git-diffable markdown canonical (per upstream
doctrine) is to `git add reports/ data/applications.md && git commit && git push`
after each eval, using a deploy token stored in Secret Manager. This makes the
fork itself the store of record and survives everything, but it's heavier
(needs a scoped write token, serializes writes, and adds a push to each eval).
The mounted volume is the recommended default; treat commit-back as an upgrade.

---

## 3. Secrets (Google Secret Manager → env vars)

Store every secret in Secret Manager and map it to an env var on the service.
Create each secret once, then reference it with `--set-secrets`:

```bash
# Example: create a secret
printf '%s' "$GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-

gcloud run deploy careerops-server \
  --image "$IMAGE" --region "$REGION" \
  --set-secrets=\
GEMINI_API_KEY=GEMINI_API_KEY:latest,\
SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,\
SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,\
TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,\
TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,\
SERVER_API_KEY=SERVER_API_KEY:latest \
  --set-env-vars=\
GOOGLE_SPREADSHEET_ID=your_spreadsheet_id,\
GOOGLE_DRIVE_FOLDER_ID=your_drive_folder_id,\
GOOGLE_STORAGE_BUCKET=your_gcs_bucket
  # ...plus sections 2, 4, 5 flags
```

The `GOOGLE_*` IDs are plain config (not sensitive) so `--set-env-vars` is fine;
they're all optional (each sync no-ops when unset). See
[`.env.example`](../.env.example) for the full list and meanings.

**Do NOT set `GOOGLE_APPLICATION_CREDENTIALS` on Cloud Run** — `sync-google.mjs`
uses `google.auth.GoogleAuth`, i.e. ADC, which resolves to the Cloud Run runtime
service account automatically. No key file is shipped or needed.

### IAM the runtime service account needs

- `roles/storage.objectAdmin` on the GCS bucket(s) — upload report/PDF files
  (and, if used, the gcsfuse state bucket from section 2a).
- `roles/secretmanager.secretAccessor` — read the mapped secrets.
- **Share the target Google Sheet and the Drive folder with the service
  account's email** (`…@…​.iam.gserviceaccount.com`), as Editor — Sheets/Drive
  access is granted by document sharing, not by an IAM role.

---

## 4. Sizing and concurrency

```bash
gcloud run deploy careerops-server \
  --image "$IMAGE" --region "$REGION" \
  --memory=2Gi \
  --concurrency=1 \
  --max-instances=1
  # ...plus sections 2, 3, 5 flags
```

- **Memory ~1–2 GiB.** Chromium/Playwright is memory-hungry; 2 GiB is a safe
  default, 1 GiB is the floor.
- **`--concurrency=1` (important).** Setting a single instance alone does **not**
  serialize requests — one instance handles many concurrent requests by default.
  `gemini-eval.mjs` derives the next report number by scanning `reports/`, and
  the pipeline writes files as it runs, so two overlapping `/careerops` calls can
  collide on report numbering / file writes. `--concurrency=1` serializes them.
  `--max-instances=1` (plus the single-instance volume in section 2) keeps there
  from being multiple instances writing at once.

---

## 5. CPU allocation — REQUIRED for the background pipeline

By default Cloud Run **throttles CPU to near-zero after the HTTP response is
sent**. But this server ACKs Slack within 3s and then keeps running
`runAsyncPipeline()` in the **background** — scraping, calling Gemini, rendering
the PDF, syncing to Google. Under default (request-based) CPU allocation that
post-ACK work can stall and never finish.

Fix: enable **CPU always allocated** (instance-based billing):

```bash
gcloud run deploy careerops-server \
  --image "$IMAGE" --region "$REGION" \
  --no-cpu-throttling
  # ...plus sections 2, 3, 4 flags
```

**Cost trade-off:** with CPU always allocated you're billed for the instance's
CPU for as long as it's up (not only during requests). With `--max-instances=1`
and scale-to-zero when idle this stays cheap for a personal tool, but it is more
than pure request-based billing.

**More robust alternative (future improvement):** instead of doing heavy work
after the ACK, have `/webhook` enqueue a Cloud Tasks / Pub-Sub message to a
separate worker endpoint that does the pipeline **inside its own request
lifecycle** (where CPU is guaranteed). That removes the throttling concern
entirely and lets the front-end scale to zero. Out of scope for the MVP.

---

## 6. Point Slack / Telegram at the deployed URL

After `gcloud run deploy` prints the service URL (`https://careerops-server-….run.app`):

- **Slack:** in the app config, set the `/careerops` slash command **Request
  URL** to `https://<cloud-run-url>/webhook`. The Slack `response_url` is valid
  for ~30 minutes, so a cold start (or a slow eval) still posts the result fine.
- **Telegram (if used):** register the webhook with the secret token:

  ```bash
  curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    --data-urlencode "url=https://<cloud-run-url>/webhook" \
    --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
  ```

Verify: `curl https://<cloud-run-url>/healthz` → `OK`, then run
`/careerops <real posting url>` from your phone. After a redeploy, confirm prior
evaluations are still present (Sheet rows intact, report/PDF files still in the
mounted volume / Drive / GCS) — that's the Persistence guarantee from section 2.
