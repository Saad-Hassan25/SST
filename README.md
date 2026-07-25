# Relay — download & transcribe media over GitHub Actions

Paste a video link on a static web page; a remote GitHub Actions runner downloads
the video (at a chosen quality) or transcribes it with **NVIDIA Parakeet TDT**, and
the result comes back to the page. No server of your own beyond a tiny Cloudflare
Worker that keeps your GitHub token safe.

## How it works

```
Browser (GitHub Pages)  ──POST /trigger──►  Cloudflare Worker  ──repository_dispatch──►  GitHub Actions
        ▲                                    (holds the token)                                │
        │                                                                                     │ runs yt-dlp / Parakeet
        └──────────GET /status (poll)──────  Worker reads the Release  ◄──uploads asset──  GitHub Release (job-<id>)
```

- The **Worker** is the only thing that talks to the GitHub API. Your token lives
  there as a secret, never in the browser.
- Each job creates a **Release** tagged `job-<id>`. Its state is the signal the page
  polls: no release = queued, release with no assets = running, assets present = done,
  an `ERROR.txt` = failed.
- **Video** comes back as a download link (release asset). **Transcripts** are shown
  inline on the page and offered as `.txt` / `.srt`.

## Repo layout

```
.github/workflows/process.yml   the Actions job (download + transcribe)
scripts/fetch.py                yt-dlp download (video preset or audio-only)
scripts/transcribe.py           Parakeet TDT + Silero VAD -> .txt / .srt
requirements.txt                transcription deps (CPU)
worker/worker.js                Cloudflare Worker (the secure relay)
worker/wrangler.toml            Worker config
docs/index.html                 the GitHub Pages frontend
```

## Setup

### 1. Create the repo
Create a **public** repo and add these files. Everything runs from the **default
branch** — `repository_dispatch` only triggers workflows on the default branch, so the
workflow file must live there.

### 2. Enable GitHub Pages
Settings → Pages → Build and deployment → Deploy from a branch → branch `main`, folder
`/docs`. Note the published URL, e.g. `https://USERNAME.github.io/REPO/`. The origin
you'll need later is just `https://USERNAME.github.io`.

### 3. Create a token for the Worker
Create a **fine-grained personal access token** (Settings → Developer settings →
Fine-grained tokens):
- Repository access: only this repo.
- Permissions: **Contents → Read and write** (this one permission covers both firing
  `repository_dispatch` and reading releases).

The workflow itself does **not** need this token — it uses the built-in `GITHUB_TOKEN`.
The PAT is only for the Worker.

### 4. Deploy the Worker
```bash
npm install -g wrangler
cd worker

# edit wrangler.toml: set GITHUB_OWNER, GITHUB_REPO, ALLOWED_ORIGIN
wrangler login
wrangler secret put GITHUB_TOKEN      # paste the fine-grained PAT
wrangler deploy
```
Copy the deployed URL (e.g. `https://yt-actions-relay.<subdomain>.workers.dev`).

### 5. Point the frontend at the Worker
In `docs/index.html`, edit the CONFIG block near the bottom:
```js
const WORKER_URL = "https://yt-actions-relay.<subdomain>.workers.dev";
const REPO_URL   = "https://github.com/USERNAME/REPO";
```
Commit. Once Pages redeploys, open the Pages URL and try a link.

## Optional hardening (recommended for anything public)

### Bot check (Cloudflare Turnstile)
1. Create a Turnstile widget (free) and note the **site key** and **secret key**.
2. Put the site key in `docs/index.html` → `TURNSTILE_SITE_KEY`.
3. Set the secret on the Worker: `wrangler secret put TURNSTILE_SECRET`, then `wrangler deploy`.

Keep these consistent: only set the Worker secret **if** the frontend has a site key.
(Secret set but no site key ⇒ every request fails verification.)

### Per-IP rate limit — **already on in this repo**
The `RATE_LIMIT` KV namespace is created and bound in `worker/wrangler.toml`, capped by
`RATE_LIMIT_PER_HOUR` (currently 10). Setting it up from scratch elsewhere:
```bash
cd worker
wrangler kv namespace create RATE_LIMIT   # copy the id it prints
# paste the id into the [[kv_namespaces]] block in wrangler.toml
wrangler deploy                           # the cap is not live until you deploy
```
The Worker skips rate limiting entirely when the binding is absent, so deleting that
block silently reopens the hole rather than failing loudly.

**Caveat:** KV reads are eventually consistent (~60s), so this caps sustained abuse, not
a parallel burst — several simultaneous requests can each read a stale count and pass.
For a hard cap, switch to Cloudflare's native rate-limiting binding, which is atomic.

### Release cleanup
`.github/workflows/cleanup.yml` deletes `job-*` releases (and their tags) older than 3
days, nightly. Run it manually from the Actions tab with `dry_run` first to preview.
Keep retention above `process.yml`'s 350-minute timeout so it can't delete a release
belonging to a job that is still running.

## Costs & limits
- **Free** on a public repo (unlimited Actions minutes on standard runners).
- Runners are ~2 vCPU, so transcription runs slower than your laptop — still far under
  the **6-hour per-job cap**. Parakeet at ~0.3–0.5 RTF on a runner means an hour of
  audio in well under an hour.
- GitHub allows ~20 concurrent jobs on free public repos — a natural throttle.

## YouTube is not supported

YouTube blocks the datacenter IP ranges GitHub Actions runners come from ("Sign in to
confirm you're not a bot"). Both the frontend and the Worker reject YouTube links up
front with an explanation, instead of queueing a job that can only fail.

**Don't try to fix this with cookies, PO tokens, or `player_client` tricks.** They buy
account access and bot attestation — not IP reputation. yt-dlp's maintainers file the
logged-out datacenter-IP block under *intractable issues* and state that a PO token will
not help if your IP is already blocked. Account cookies additionally stop working within
days and carry a real risk of the account being banned, so they cannot run unattended.
This was researched and settled; the scaffolding in `fetch.py` predates that finding.

The only lever that changes the outcome is not using a datacenter IP — a self-hosted
runner on a residential connection, or a residential proxy via `YTDLP_PROXY`. Both were
considered and declined: the runner would execute strangers' URLs on a home network, and
a metered proxy lets anyone run up an unbounded bill on a free public tool.

## Optional yt-dlp network config

`process.yml` reads three optional settings and no-ops when they're unset:

| Name | Kind | Purpose |
|---|---|---|
| `YT_COOKIES_B64` | secret | base64 of a Netscape `cookies.txt`, for age-restricted or private content **on sites other than YouTube** |
| `YTDLP_PROXY` | secret | proxy URL (may embed credentials) |
| `YTDLP_PLAYER_CLIENT` | variable | comma-separated yt-dlp player clients |

The cookies file is written to `$RUNNER_TEMP`, never the workspace — anything under
`output/` is swept up by `gh release upload output/*` and would be published.

## Notes
- **Keep yt-dlp current.** The workflow installs the latest each run; most "can't
  download" errors are stale-extractor issues fixed by updating.
- **Quality presets** (best / 1080p / 720p / 480p / 360p) are fixed for v1; yt-dlp picks
  the closest match. Per-video format listing can be added later.
- Test the transcription logic locally first with the companion notebook before relying
  on it in Actions.
