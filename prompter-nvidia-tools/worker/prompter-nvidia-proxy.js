/* RECOMMENDED (production): Cloudflare Worker proxy - key stays server-side, browser never sees it.
   Deploy: wrangler deploy. Secret: wrangler secret put NVIDIA_API_KEY
   Then in js/config.js set proxyUrl to "https://prompter-nvidia-proxy.<you>.workers.dev/v1" and remove key field usage. */
const ALLOWED = ["/chat/completions", "/embeddings", "/models"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1/, "");
    if (!ALLOWED.includes(path)) return new Response("Not allowed", { status: 404, headers: CORS });
    // TODO (intern): add your own rate limit / Turnstile check here before going public.
    const upstream = "https://integrate.api.nvidia.com/v1" + path;
    const init = { method: req.method, headers: { "Authorization": "Bearer " + env.NVIDIA_API_KEY, "Content-Type": "application/json", "Accept": "application/json" } };
    if (req.method === "POST") init.body = await req.text();
    const r = await fetch(upstream, init);
    return new Response(r.body, { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
};
