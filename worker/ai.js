// Persistent NVIDIA jobs. Alarms run independently of browser connections.
// Each alarm makes one bounded inference attempt; retries are scheduled, never slept.
const API = "https://integrate.api.nvidia.com/v1";
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHAT = ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3-flash", "openai/gpt-oss-20b"];
const FAST = "nvidia/nemotron-3.5-lightning-30b-a3b";
const EMBED = "nvidia/nemotron-3-embed-1b";
const ALLOWED = new Set([...CHAT, FAST, "nvidia/riva-translate-4b-instruct-v2",
  "meta/llama-3.2-90b-vision-instruct", "meta/llama-3.2-11b-vision-instruct",
  "nvidia/llama-3.1-nemotron-safety-guard-8b-v3"]);
const reply = (body, status = 200) => Response.json(body, { status });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");

export function validateAI(body) {
  if (!body || !UUID.test(body.request_id || "")) throw fail("Invalid request id.");
  const { kind, payload } = body;
  if (!payload || typeof payload !== "object") throw fail("Missing AI input.");
  if (kind === "embed") {
    if (payload.model !== EMBED || !["passage", "query"].includes(payload.input_type) ||
        !Array.isArray(payload.input) || !payload.input.length || payload.input.length > 16 ||
        payload.input.some(t => typeof t !== "string" || !t.trim() || t.length > 8000))
      throw fail("Use 1–16 text passages of up to 8,000 characters.");
    return { kind, payload: { model: EMBED, input: payload.input, input_type: payload.input_type,
      encoding_format: "float", truncate: "END" } };
  }
  if (kind !== "chat" || !ALLOWED.has(payload.model)) throw fail("Unsupported AI model.");
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 12)
    throw fail("Invalid chat messages.");
  let textSize = 0, imageCount = 0;
  const messages = payload.messages.map(m => {
    if (!m || !["user", "system", "assistant"].includes(m.role)) throw fail("Invalid message role.");
    if (typeof m.content === "string") {
      textSize += m.content.length;
      return { role: m.role, content: m.content };
    }
    if (!Array.isArray(m.content) || !m.content.length || m.role !== "user") throw fail("Invalid message content.");
    const content = m.content.map(part => {
      if (part.type === "text" && typeof part.text === "string") {
        textSize += part.text.length;
        return { type: "text", text: part.text };
      }
      // Inline images only: callers cannot turn the relay into an arbitrary URL fetcher.
      if (part.type === "image_url" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url || "")) {
        imageCount++;
        if (part.image_url.url.length > 1500000) throw fail("Resize the image before submitting.");
        return { type: "image_url", image_url: { url: part.image_url.url } };
      }
      throw fail("Unsupported image input.");
    });
    return { role: m.role, content };
  });
  if (textSize > 180000 || !textSize || imageCount > 4) throw fail("AI input is too large or empty.");
  if (imageCount && !payload.model.startsWith("meta/llama-3.2-")) throw fail("Select a vision model for images.");
  const max_tokens = payload.max_tokens ?? 2048;
  const temperature = payload.temperature ?? 0.3;
  if (!Number.isInteger(max_tokens) || max_tokens < 128 || max_tokens > 8192 ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw fail("Invalid generation settings.");
  return { kind, payload: { model: payload.model, messages, max_tokens, temperature, stream: false,
    ...(payload.model.startsWith("nvidia/nemotron-3") ? { chat_template_kwargs: { enable_thinking: false } } : {}) } };
}

export async function handleAI(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/ai/config" && request.method === "GET")
    return reply({ available: !!(env.NVIDIA_API_KEY && env.AI_JOBS), retention_hours: 24 });
  if (!env.AI_JOBS || !env.NVIDIA_API_KEY) return reply({ error: "AI tools are being configured. Download and transcription are still available." }, 503);
  if (path === "/ai/jobs" && request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return reply({ error: "Origin not allowed." }, 403);
    try {
      if (Number(request.headers.get("Content-Length")) > 6000000) throw fail("Input exceeds 6 MB.", 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 6000000) throw fail("Input exceeds 6 MB.", 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw fail("Invalid JSON."); }
      const input = validateAI(body);
      const ip = await hash(request.headers.get("CF-Connecting-IP") || "local");
      const id = body.request_id;
      const stub = env.AI_JOBS.get(env.AI_JOBS.idFromName(id));
      return await stub.fetch("https://ai.internal/start", { method: "POST", body: JSON.stringify({ ...input, id, ip, refresh: body.refresh === true }) });
    } catch (e) { return reply({ error: e.status ? e.message : "Couldn't create the AI job. Try again." }, e.status || 503); }
  }
  const m = path.match(/^\/ai\/jobs\/([^/]+)$/);
  if (m && request.method === "GET") {
    if (!UUID.test(m[1])) return reply({ error: "Invalid AI job id." }, 400);
    return env.AI_JOBS.get(env.AI_JOBS.idFromName(m[1])).fetch("https://ai.internal/status");
  }
  return reply({ error: "Not found." }, 404);
}

// Split JSON so vision inputs and embedding outputs stay below the per-value
// Durable Object storage limit. All blocks are committed in a storage transaction.
async function writeLarge(storage, key, value) {
  const raw = JSON.stringify(value), entries = {};
  for (let i = 0; i < raw.length; i += 20000) entries[`${key}:${i / 20000}`] = raw.slice(i, i + 20000);
  entries[`${key}:count`] = Math.ceil(raw.length / 20000);
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i += 100) await storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, entries[k]])));
}
async function readLarge(storage, key) {
  const count = await storage.get(`${key}:count`);
  const keys = Array.from({ length: count || 0 }, (_, i) => `${key}:${i}`);
  const pieces = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100), values = await storage.get(batch);
    pieces.push(...batch.map(k => values.get(k)));
  }
  return count ? JSON.parse(pieces.join("")) : null;
}

async function clearLarge(storage, key) {
  const count = (await storage.get(`${key}:count`)) || 0;
  const keys = [`${key}:count`, ...Array.from({ length: count }, (_, i) => `${key}:${i}`)];
  for (let i = 0; i < keys.length; i += 100) await storage.delete(keys.slice(i, i + 100));
}

export class AIJob {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.storage = ctx.storage; }
  async quota(action, ip) {
    const stub = this.env.AI_JOBS.get(this.env.AI_JOBS.idFromName("quota"));
    const r = await stub.fetch(`https://ai.internal/${action}`, { method: "POST", body: JSON.stringify({ ip }) });
    return r.json();
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/admit" || path === "/reserve") {
      const { ip } = await request.json(), now = Date.now();
      return this.storage.transaction(async txn => {
        if (path === "/reserve") {
          const recent = ((await txn.get("requests")) || []).filter(t => now - t < 60000);
          if (recent.length >= 30) return reply({ wait: Math.max(1000, 60000 - (now - recent[0])) });
          await txn.put("requests", [...recent, now]);
          return reply({ wait: 0 });
        }
        const key = "visitor:" + ip;
        let visitor = await txn.get(key);
        if (!visitor || now - visitor.start >= 3600000) visitor = { start: now, count: 0 };
        if (visitor.count >= Number(this.env.AI_RATE_LIMIT_PER_HOUR || 120)) return reply({ allowed: false });
        visitor.count++;
        await txn.put(key, visitor);
        await txn.setAlarm(now + DAY);
        return reply({ allowed: true });
      });
    }
    if (path === "/start") {
      const input = await request.json();
      const fingerprint = await hash(JSON.stringify({ kind: input.kind, payload: input.payload }));
      return this.ctx.blockConcurrencyWhile(async () => {
        let job = await this.storage.get("job");
        if (job) {
          if (job.fingerprint !== fingerprint) return reply({ error: "This request id is already in use." }, 409);
          return reply({ job_id: job.id, status: job.status }, 202);
        }
        if (!(await this.quota("admit", input.ip)).allowed) return reply({ error: "You've reached the AI hourly limit. Try again later." }, 429);
        job = { id: input.id, kind: input.kind, fingerprint, status: "queued", attempt: 0,
          model: input.payload.model, created_at: Date.now(), expires_at: Date.now() + DAY };
        // The model result cache uses input hashes; it is never publicly addressable.
        let cached;
        try { if (!input.refresh) cached = await this.env.RATE_LIMIT?.get(`ai-cache:${fingerprint}`, "json"); } catch { /* cache is optional */ }
        await this.storage.transaction(async txn => {
          await txn.put("job", cached ? { ...job, status: "done", cached: true } : job);
          if (cached) await writeLarge(txn, "result", cached);
          else await writeLarge(txn, "input", input.payload);
          await txn.setAlarm(cached ? job.expires_at : Date.now() + 1000);
        });
        return reply({ job_id: job.id, status: cached ? "done" : "queued" }, 202);
      });
    }
    if (path === "/status") {
      const job = await this.storage.get("job");
      if (!job || job.expires_at < Date.now()) return reply({ error: "This AI result expired or was not found." }, 404);
      const { fingerprint, upstream_id, ...publicJob } = job;
      return reply({ ...publicJob, ...(job.status === "done" ? { result: await readLarge(this.storage, "result") } : {}) });
    }
    return reply({ error: "Not found." }, 404);
  }
  async alarm() {
    const job = await this.storage.get("job");
    if (!job) {
      // The quota object's IP records expire independently of the job objects.
      const visitors = await this.storage.list({ prefix: "visitor:", limit: 1000 });
      for (const [key, value] of visitors) if (Date.now() - value.start >= 3600000) await this.storage.delete(key);
      if (visitors.size) await this.storage.setAlarm(Date.now() + DAY);
      return;
    }
    if (job.expires_at <= Date.now()) { await this.storage.deleteAll(); return; }
    if (["done", "error"].includes(job.status)) { await this.storage.setAlarm(job.expires_at); return; }
    // Bound recovery even if the runtime restarts an alarm after an interrupted call.
    if (job.attempt >= 3 || Date.now() - job.created_at > 15 * 60000) {
      await this.finish(job, "error", "The model could not finish within 15 minutes. Please try again."); return;
    }
    try {
      const { wait } = await this.quota("reserve");
      if (wait) {
        await this.storage.put("job", { ...job, status: "queued", message: "Waiting for model capacity." });
        await this.storage.setAlarm(Date.now() + wait + 1000); return;
      }
      const payload = await readLarge(this.storage, "input");
      // Only text models can substitute for each other. Never fall back from safety,
      // translation, embeddings or vision to a generic chat model.
      const fallbacks = CHAT.includes(payload.model) || payload.model === FAST
        ? [payload.model, ...CHAT.filter(m => m !== payload.model)] : [payload.model];
      payload.model = fallbacks[Math.min(job.model_index || 0, fallbacks.length - 1)];
      if (payload.model.startsWith("nvidia/nemotron-3")) payload.chat_template_kwargs = { enable_thinking: false };
      else delete payload.chat_template_kwargs;
      job.attempt++;
      job.status = "running"; job.model = payload.model; job.message = "The model is working. Slow responses can take several minutes.";
      await this.storage.put("job", job);
      // Persist a watchdog before opening the upstream connection. If an alarm
      // invocation is interrupted by a restart/deploy, the job still wakes again.
      await this.storage.setAlarm(Date.now() + 250000);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 240000);
      let response, result;
      try {
        const headers = { Authorization: `Bearer ${this.env.NVIDIA_API_KEY}`, "Content-Type": "application/json" };
        response = job.upstream_id
          ? await fetch(`https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${job.upstream_id}`, { headers, signal: controller.signal })
          : await fetch(`${API}/${job.kind === "embed" ? "embeddings" : "chat/completions"}`, {
            method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
        // NVIDIA can acknowledge slow inference with 202. Poll the accepted
        // request instead of creating a second inference or treating it as empty.
        while (response.status === 202) {
          const pending = await response.json().catch(() => ({}));
          const requestId = response.headers.get("nvcf-reqid") || pending.reqId || job.upstream_id;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId || ""))
            throw new Error("Invalid upstream request id.");
          job.upstream_id = requestId;
          await this.storage.put("job", job);
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (controller.signal.aborted) throw Object.assign(new Error("Timed out"), { name: "AbortError" });
          response = await fetch(`https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${requestId}`, { headers, signal: controller.signal });
        }
        if (response.ok) result = await response.json();
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        const status = response.status;
        // Do not relay upstream bodies: they may contain headers, submitted text or secrets.
        if (status === 401 || status === 403) { await this.finish(job, "error", "NVIDIA has not authorized inference for the configured key. The site owner needs to check model access."); return; }
        if (![404, 408, 429, 500, 502, 503, 504].includes(status)) {
          await this.finish(job, "error", "The model rejected this input. Try a shorter transcript or a different image."); return;
        }
        if (status === 404 && fallbacks.length === 1) { await this.finish(job, "error", "This specialized NVIDIA model is currently unavailable."); return; }
        const retry = Math.min(120000, Math.max(5000, Number(response.headers.get("Retry-After")) * 1000 || 15000 * job.attempt));
        await this.retry(job, status === 429 ? "NVIDIA is busy; retrying shortly." : "The model is unavailable; retrying.", retry, status !== 429); return;
      }
      if (job.kind === "chat" && !result?.choices?.[0]?.message?.content?.trim()) {
        await this.retry(job, "The model returned an empty answer; trying again.", 1000, true); return;
      }
      if (job.kind === "embed" && (!Array.isArray(result?.data) || result.data.length !== payload.input.length ||
          result.data.some(d => !Array.isArray(d.embedding) || !d.embedding.length || d.embedding.some(n => !Number.isFinite(n))))) {
        await this.retry(job, "The embedding model returned an incomplete result; retrying.", 5000); return;
      }
      await this.storage.transaction(async txn => {
        await writeLarge(txn, "result", result);
        await txn.put("job", { ...job, status: "done", message: "Result ready." });
        await clearLarge(txn, "input");
        await txn.setAlarm(job.expires_at);
      });
      try { await this.env.RATE_LIMIT?.put(`ai-cache:${job.fingerprint}`, JSON.stringify(result), { expirationTtl: 86400 }); } catch { /* optional cache */ }
    } catch (e) {
      await this.retry(job, e.name === "AbortError" ? "The model was slow; retrying with available capacity." : "Connection to NVIDIA interrupted; retrying.", 5000, true);
    }
  }
  async retry(job, message, delay, nextModel = false) {
    if (job.attempt >= 3) { await this.finish(job, "error", "NVIDIA could not complete this request after three attempts. Please try again later."); return; }
    const { upstream_id, ...next } = job;
    await this.storage.put("job", { ...next, status: "queued", message, model_index: (job.model_index || 0) + (nextModel ? 1 : 0) });
    await this.storage.setAlarm(Date.now() + delay);
  }
  async finish(job, status, message) {
    await this.storage.put("job", { ...job, status, message });
    await clearLarge(this.storage, "input");
    await this.storage.setAlarm(job.expires_at);
  }
}
