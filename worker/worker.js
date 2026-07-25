// Cloudflare Worker — secure relay between the static GitHub Pages frontend and
// GitHub Actions. The GitHub token lives here as a server-side secret and never
// reaches the browser. Two endpoints:
//   POST /trigger  -> validates input, fires a repository_dispatch, returns { job_id }
//   GET  /status   -> reports queued | running | done | error for a job_id
//
// Configure via wrangler.toml [vars] + secrets (see wrangler.toml).

const MODES = new Set(["download", "transcribe"]);
const QUALITIES = new Set(["best", "1080p", "720p", "480p", "360p"]);
const MAX_SPEAKERS = 20;   // keep in sync with scripts/transcribe.py
const GH_API = "https://api.github.com";

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "yt-actions-relay",
  };
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

// YouTube blocks the datacenter IPs that GitHub Actions runners come from, and no
// yt-dlp option fixes that — cookies and PO tokens address account access, not IP
// reputation. So these jobs can only ever fail. Rejecting them here costs no Actions
// minutes, spends no rate-limit quota, and gives the user a real reason instead of a
// generic "job failed" ten minutes later.
const YOUTUBE_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
const YOUTUBE_MESSAGE =
  "YouTube isn't supported: it blocks the datacenter IPs this tool runs on, so the " +
  "job would always fail. Links from most other sites work.";

// Suffix match on a dot boundary. A plain includes("youtube.com") would also accept
// notyoutube.com and youtube.com.attacker.net.
function isYouTubeUrl(u) {
  let host;
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return false;
  }
  return YOUTUBE_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

// Optional bot check. Returns true (allowed) when no secret is configured.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token || "",
    remoteip: ip || "",
  });
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const d = await r.json();
  return !!d.success;
}

// Optional per-IP rate limit. Skipped when no RATE_LIMIT KV namespace is bound.
async function underRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return true;
  const key = `rl:${ip}`;
  const count = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  const limit = parseInt(env.RATE_LIMIT_PER_HOUR || "10", 10);
  if (count >= limit) return false;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function handleTrigger(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "";

  let body;
  try {
    body = await request.json();
  } catch {
    return json(env, { error: "Invalid request." }, 400);
  }

  const { url, mode, quality = "best", diarize = false, speakers, turnstileToken } = body || {};
  if (!MODES.has(mode)) return json(env, { error: "Pick download or transcribe." }, 400);
  if (!isHttpUrl(url)) return json(env, { error: "Enter a valid video link (http or https)." }, 400);
  if (mode === "download" && !QUALITIES.has(quality))
    return json(env, { error: "Unknown quality option." }, 400);
  if (isYouTubeUrl(url)) return json(env, { error: YOUTUBE_MESSAGE }, 400);

  // Diarization is transcribe-only. `speakers` ends up as a command argument on the
  // runner, so it has to be a plain small integer. Number() rather than parseInt():
  // parseInt("2; rm -rf /") happily returns 2, Number() returns NaN.
  const wantDiarize = mode === "transcribe" && diarize === true;
  let speakerCount = 0;
  if (wantDiarize) {
    const n = Number(speakers);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SPEAKERS)
      return json(env, { error: `Enter a speaker count between 1 and ${MAX_SPEAKERS}.` }, 400);
    speakerCount = n;
  }

  if (!(await verifyTurnstile(env, turnstileToken, ip)))
    return json(env, { error: "Verification failed. Reload the page and try again." }, 403);

  if (!(await underRateLimit(env, ip)))
    return json(env, { error: "You've hit the hourly limit. Try again later." }, 429);

  const jobId = crypto.randomUUID();
  const dispatch = await fetch(
    `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({
        event_type: mode,
        client_payload: {
          url,
          quality,
          mode,
          job_id: jobId,
          diarize: wantDiarize,
          speakers: speakerCount,
        },
      }),
    }
  );

  if (dispatch.status !== 204) {
    const detail = (await dispatch.text()).slice(0, 200);
    return json(env, { error: "Couldn't start the job. Try again.", detail }, 502);
  }
  return json(env, { job_id: jobId, mode });
}

// The workflow writes the release notes as `key: value` lines (status / stage / mode).
// Parse them into an object; unknown or malformed lines are ignored.
function parseNotes(body) {
  const out = {};
  for (const line of (body || "").split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// mode from notes if present, else parsed from the release title "Job <id> (mode)".
function modeFrom(release, notes) {
  if (notes.mode && MODES.has(notes.mode)) return notes.mode;
  const m = (release.name || "").match(/\((download|transcribe)\)\s*$/);
  return m ? m[1] : null;
}

async function handleStatus(request, env) {
  const jobId = new URL(request.url).searchParams.get("job_id") || "";
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) return json(env, { error: "Invalid job id." }, 400);

  const rel = await fetch(
    `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/job-${jobId}`,
    { headers: ghHeaders(env) }
  );

  // No release yet = the runner hasn't picked the job up.
  if (rel.status === 404) return json(env, { status: "queued" });
  if (!rel.ok) return json(env, { error: "Couldn't check status." }, 502);

  const data = await rel.json();
  const assets = data.assets || [];
  const rawNotes = data.body || "";
  const notes = parseNotes(rawNotes);
  const mode = modeFrom(data, notes);

  // --- error: an ERROR.txt asset, or notes marked error --------------------
  const errorAsset = assets.find((a) => a.name === "ERROR.txt");
  if (errorAsset || notes.status === "error" || rawNotes.includes("status: error")) {
    let message = "The job failed. Try a different link or quality.";
    if (errorAsset) {
      // ERROR.txt holds the concise, user-facing reason our scripts wrote.
      try {
        const c = await fetch(errorAsset.browser_download_url);
        if (c.ok) {
          const t = (await c.text()).trim();
          if (t) message = t.slice(0, 500);
        }
      } catch {
        /* fall back to the generic message */
      }
    }
    return json(env, { status: "error", message, mode });
  }

  // --- done: authoritative signal is the notes, NOT asset presence ---------
  // The publish step uploads assets one by one, then marks the notes "done" LAST.
  // Keying "done" off the notes (not "any asset exists") closes the race where a
  // poll landing mid-upload returned done before the .txt transcript was up.
  const isDone = notes.status === "done" || rawNotes.includes("status: done");
  if (!isDone) {
    // running — surface the current stage (downloading / transcribing / uploading …)
    return json(env, { status: "running", stage: notes.stage || null, mode });
  }

  const files = assets
    .filter((a) => a.name !== "ERROR.txt")
    .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));

  // For transcripts, fetch the .txt so the page can show it inline. The repo is
  // public, so browser_download_url is fetchable server-side without auth (and
  // routing it through the Worker avoids browser CORS on the asset CDN).
  // With diarization on, output holds BOTH X.txt and X.diarized.txt; asset order from
  // the API isn't guaranteed, so prefer the labelled one explicitly.
  let transcript = null;
  const txts = files.filter((f) => f.name.toLowerCase().endsWith(".txt"));
  const txt = txts.find((f) => f.name.toLowerCase().endsWith(".diarized.txt")) || txts[0];
  if (txt) {
    const c = await fetch(txt.url);
    if (c.ok) transcript = await c.text();
  }

  return json(env, { status: "done", files, transcript, mode });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/trigger") return handleTrigger(request, env);
    if (request.method === "GET" && pathname === "/status") return handleStatus(request, env);
    return json(env, { error: "Not found." }, 404);
  },
};
