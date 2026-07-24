// Cloudflare Worker — secure relay between the static GitHub Pages frontend and
// GitHub Actions. The GitHub token lives here as a server-side secret and never
// reaches the browser. Two endpoints:
//   POST /trigger  -> validates input, fires a repository_dispatch, returns { job_id }
//   GET  /status   -> reports queued | running | done | error for a job_id
//
// Configure via wrangler.toml [vars] + secrets (see wrangler.toml).

const MODES = new Set(["download", "transcribe"]);
const QUALITIES = new Set(["best", "1080p", "720p", "480p", "360p"]);
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

  const { url, mode, quality = "best", turnstileToken } = body || {};
  if (!MODES.has(mode)) return json(env, { error: "Pick download or transcribe." }, 400);
  if (!isHttpUrl(url)) return json(env, { error: "Enter a valid video link (http or https)." }, 400);
  if (mode === "download" && !QUALITIES.has(quality))
    return json(env, { error: "Unknown quality option." }, 400);

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
        client_payload: { url, quality, mode, job_id: jobId },
      }),
    }
  );

  if (dispatch.status !== 204) {
    const detail = (await dispatch.text()).slice(0, 200);
    return json(env, { error: "Couldn't start the job. Try again.", detail }, 502);
  }
  return json(env, { job_id: jobId, mode });
}

async function handleStatus(request, env) {
  const jobId = new URL(request.url).searchParams.get("job_id") || "";
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) return json(env, { error: "Invalid job id." }, 400);

  const rel = await fetch(
    `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/job-${jobId}`,
    { headers: ghHeaders(env) }
  );

  if (rel.status === 404) return json(env, { status: "queued" });
  if (!rel.ok) return json(env, { error: "Couldn't check status." }, 502);

  const data = await rel.json();
  const assets = data.assets || [];
  const notes = data.body || "";

  const hadError = assets.some((a) => a.name === "ERROR.txt") || notes.includes("status: error");
  if (hadError)
    return json(env, {
      status: "error",
      message: "The job failed. Try a different link or quality.",
    });

  if (assets.length === 0) return json(env, { status: "running" });

  const files = assets.map((a) => ({
    name: a.name,
    size: a.size,
    url: a.browser_download_url,
  }));

  // For transcripts, fetch the .txt so the page can show it inline. The repo is
  // public, so browser_download_url is fetchable server-side without auth (and
  // routing it through the Worker avoids browser CORS on the asset CDN).
  let transcript = null;
  const txt = files.find((f) => f.name.toLowerCase().endsWith(".txt") && f.name !== "ERROR.txt");
  if (txt) {
    const c = await fetch(txt.url);
    if (c.ok) transcript = await c.text();
  }

  return json(env, { status: "done", files, transcript });
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
