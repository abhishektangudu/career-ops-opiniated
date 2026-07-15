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

### The image is intentionally PII-free — inputs come at runtime

`Dockerfile.server` bakes in only the **system** code + assets. Every private,
user-layer input is excluded via `.dockerignore` (your `cv.md`,
`config/profile.yml`, `config/cv-facts.json`, `modes/_profile.md`,
`modes/_custom.md`, `voice-dna.md`, `portals.yml`, `article-digest.md`, and the
`data/` `reports/` `output/` state). This is deliberate: it keeps the image
clean so `docker build` from your real workspace can't leak PII into Artifact
Registry.

The flip side: those inputs must be **supplied at runtime**, or the bot won't
produce real output. In particular `generate-tailored-cv.mjs` unconditionally
reads `cv.md` (`PATHS.cv`) — **without it the tailored-CV step fails**. Profile-
and voice-dependent prompts (`config/profile.yml`, `modes/_profile.md`,
`modes/_custom.md`, `voice-dna.md`) degrade or fail similarly. So provisioning
these at deploy time (section 2a below) is **required**, not optional.

### Why persistence matters

Cloud Run instances have an **ephemeral filesystem**. After a redeploy or a
scale-to-zero restart, `data/`, `reports/`, and `output/` come back **empty**.

That is dangerous because `sync-google.mjs → syncTrackerToSheets()` is
**destructive**: it does `sheets.spreadsheets.values.clear(<tab>!A1:Z1000)` and
then rewrites the tab from the **local** `data/applications.md`. So if the local
tracker is empty/stale after a restart, the next `/careerops` eval would **wipe
every previously-synced row from the Sheet** — worse than having no sync at all.

There are two layers of protection; **use both**:

### (a) PRIMARY — provision the private inputs + state on a durable volume

The volume serves **two** purposes: (1) it persists the **state** (`data/`,
`reports/`, `output/`) across restarts so the code path is identical to local
and files stay canonical per the data contract (`DATA_CONTRACT.md`), and (2) it
supplies the **private input files** the image deliberately omits (`cv.md`,
`config/profile.yml`, the user `modes/` files, `voice-dna.md`, etc.).

**One-time: seed the state bucket with your private inputs.** Before first
deploy, upload the input files from your local checkout to the paths the volume
mounts expose (so the container finds them at `/app/cv.md`, `/app/config/…`,
`/app/modes/_profile.md`, …):

```bash
STATE_BUCKET=your-state-bucket
gsutil cp cv.md                 gs://$STATE_BUCKET/root/cv.md
gsutil cp voice-dna.md          gs://$STATE_BUCKET/root/voice-dna.md
gsutil cp portals.yml           gs://$STATE_BUCKET/root/portals.yml   # if used
gsutil cp article-digest.md     gs://$STATE_BUCKET/root/article-digest.md  # if used
gsutil cp config/profile.yml    gs://$STATE_BUCKET/config/profile.yml
gsutil cp config/cv-facts.json  gs://$STATE_BUCKET/config/cv-facts.json    # if used
gsutil cp modes/_profile.md     gs://$STATE_BUCKET/modes/_profile.md
gsutil cp modes/_custom.md      gs://$STATE_BUCKET/modes/_custom.md        # if used
# (data/applications.md etc. land under data/ as the bot writes them)
```

**Cloud Run 2nd gen + GCS volume (gcsfuse):** mount one GCS volume per state
directory (`data/`, `reports/`, `output/`), and supply the individual private
input files (`cv.md`, `config/profile.yml`, the user `modes/` files, etc.)
separately via Secret Manager file mounts (see the note below) — this keeps the
system files baked into `config/` and `modes/` intact:

```bash
gcloud run deploy careerops-server \
  --image "$IMAGE" --region "$REGION" \
  --execution-environment gen2 \
  # ── state (read-write, persisted) ──
  --add-volume=name=co-data,type=cloud-storage,bucket=$STATE_BUCKET \
  --add-volume-mount=volume=co-data,mount-path=/app/data \
  --add-volume=name=co-reports,type=cloud-storage,bucket=$STATE_BUCKET \
  --add-volume-mount=volume=co-reports,mount-path=/app/reports \
  --add-volume=name=co-output,type=cloud-storage,bucket=$STATE_BUCKET \
  --add-volume-mount=volume=co-output,mount-path=/app/output
  # ...plus the private-input provisioning below and the flags from sections 3–5
```

> Because `data/`, `reports/`, `output/` are their own directories, one GCS
> volume each is clean. `config/` and `modes/` mix system + user files, so you
> **cannot** mount a whole-directory volume over them (that would hide the system
> assets baked into the image). Provision those user files one of two ways:
>
> - **Secret Manager (recommended for the small text inputs):** store `cv.md`,
>   `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`,
>   `voice-dna.md`, `article-digest.md`, `portals.yml` as secrets and mount each
>   to its exact path, e.g.
>   `--set-secrets=/app/cv.md=CAREEROPS_CV_MD:latest,/app/config/profile.yml=CAREEROPS_PROFILE_YML:latest,/app/modes/_profile.md=CAREEROPS_MODES_PROFILE:latest`.
>   Secret file mounts land a single file at a path without masking sibling
>   files, which is exactly what these mixed dirs need.
> - **A tiny init step:** on container start, `gsutil cp` the input files from
>   `gs://$STATE_BUCKET/...` into place (a wrapper entrypoint) — heavier, use
>   only if you prefer everything in one bucket.
>
> Either way, the result is the same: `cv.md`, `config/profile.yml`, and the
> user `modes/` files exist inside the running container, but were **never baked
> into the image**.

> **gcsfuse caveat:** GCS-FUSE is not a POSIX filesystem — no atomic renames,
> weak concurrent-write consistency, and higher latency. Combined with
> `--concurrency=1` and a single instance (section 4) this is fine for a
> personal tool, but do **not** run multiple concurrent writers against it.

**Fly.io persistent volume (alternative host):** Fly gives you a real
block-device volume. Attach one and mount `data/`, `reports/`, `output/` into it,
and place the private input files (`cv.md`, `config/profile.yml`, the user
`modes/` files, `voice-dna.md`, …) on the volume too (or in Fly secrets mounted
to their paths). **A Fly volume is single-instance** (it binds to one machine) —
keep the app at one machine so there is exactly one writer. On Fly, ADC needs a
key file (set `GOOGLE_APPLICATION_CREDENTIALS`), unlike Cloud Run.

> **Minimum to produce real output:** `cv.md` must exist in the running
> container or `generate-tailored-cv.mjs` fails. Treat `cv.md` +
> `config/profile.yml` + `modes/_profile.md` as the required input set; the rest
> are optional but improve tailoring/voice.

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
`/careerops <real posting url>` from your phone. Confirm a tailored CV comes
back (proves `cv.md` and the profile inputs from section 2a are present in the
container — the image doesn't ship them). After a redeploy, confirm prior
evaluations are still present (Sheet rows intact, report/PDF files still in the
mounted volume / Drive / GCS) — that's the Persistence guarantee from section 2.

---

## 7. Runtime settings from the PWA (Integrations tab)
career-ops is local-first and single-user. This doc covers the one cloud
concern that the "Configurable Single-User PWA" feature adds: **where the
PWA-written settings file lives on Cloud Run, and how env / Secret Manager /
the file interact.**

## What the PWA writes

The Config → Integrations tab lets you set, at runtime (no redeploy):

- `GEMINI_API_KEY` (secret) + `GEMINI_MODEL`
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_STORAGE_BUCKET`

These persist to a JSON file (`config/runtime.json` locally). Every consumer
(`server.mjs`, `gemini-eval.mjs`) re-reads them **per invocation** through the
shared loader `runtime-settings.mjs`, so a saved value takes effect without a
restart of the process that reads it.

## Precedence: env > file > unset

```
explicit env var   >   settings file (runtime.json)   >   unset
```

- Env-override preserves the deploy contract: Cloud Run / CI can pin a value
  and it always wins.
- The file lets you manage values from the UI.

**Leave-env-unset requirement.** Because env shadows the file, if you keep
`GEMINI_API_KEY` / `GOOGLE_*` set as Cloud Run env vars (for example the
Secret-Manager-backed `GEMINI_API_KEY` some deploys wire in), those env values
**shadow anything you save from the UI** — the UI save is written to the file
but never surfaces. To manage a value from the PWA, **unset the matching env
var on the service**.

## Durable location on Cloud Run: `RUNTIME_SETTINGS_PATH`

Cloud Run's filesystem is ephemeral, and `config/` **cannot be volume-mounted**
(a mount there would hide the baked-in system assets under `config/`, and
Secret Manager file mounts are read-only anyway). So on Cloud Run, redirect the
settings file into the **already-mounted writable `data/` GCS volume** via:

```
RUNTIME_SETTINGS_PATH=/app/data/runtime.json
```

`settingsFilePath()` honors `RUNTIME_SETTINGS_PATH` and otherwise falls back to
`<root>/config/runtime.json`. Pointing it inside the mounted `data/` volume is
what makes the PWA-written settings **durable across instances/restarts**
without mounting over `config/`.

### gcsfuse caveat (non-atomic rename)

The `data/` volume is a GCS bucket mounted via **gcsfuse**, which does **not**
provide POSIX atomic renames. The web writer uses `atomicWriteWithBackup`
(write a unique temp file, then `rename`) — on gcsfuse that temp+rename is
**not guaranteed atomic**. This is acceptable for this tool because:

- it is **single-user** and the service runs with `--concurrency=1`, so there
  is a single writer — no concurrent-write race to lose;
- the write is small and idempotent (a full re-serialize of the merged object),
  and a `.bak-<ts>` snapshot is taken before each overwrite;
- if a rename ever fails on gcsfuse, a **non-atomic direct overwrite** of the
  target is an acceptable fallback for a personal single-user tool (worst case:
  re-save from the UI).

Run the service with `--concurrency=1` when relying on the file for writes.

## Optional: Gemini-key write-through to Secret Manager

When `SECRET_MANAGER_SECRET=projects/<project>/secrets/<name>` is set, a
successful PWA save of the Gemini key **also** writes the key as a new Secret
Manager version (base64 payload, via `googleapis` `secretmanager_v1`
`projects.secrets.addVersion`). This is for **future deploys/restarts** that
source the key from Secret Manager as an env var.

- **Off by default** (only runs when the env flag is set).
- **Non-blocking:** a write-through failure (e.g. `PERMISSION_DENIED`) is
  surfaced in the verify result but never blocks the local file write.
- **Does NOT hot-refresh a running instance.** A Secret-Manager-backed env var
  is resolved at instance startup; writing a new version does not change the
  env of an already-running instance. And remember: if that env var is set, it
  **shadows** the file value (see precedence above). Treat the write-through as
  "seed the value for the next cold start", not "update the live process".

## Verify-before-save

`POST /api/settings` server-side **verifies** the provided targets (a tiny live
Gemini call + Drive/Sheet/GCS access checks under ADC, via the spawned
`verify-google-access.mjs`) **before** persisting. An invalid key/ID is never
written — even via a direct API call — and the submitted key is never echoed or
logged.
