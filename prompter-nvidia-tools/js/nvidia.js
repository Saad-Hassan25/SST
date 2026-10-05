/* NVIDIA NIM client (OpenAI-compatible). Works direct from browser (user's own key)
   or through the Cloudflare Worker proxy in /worker (recommended for production). */
(function () {
  const cfg = window.PROMPTER_CONFIG;
  const KEY_LS = "prompter_nvidia_key";

  function getKey() { return localStorage.getItem(KEY_LS) || ""; }
  function setKey(k) { k ? localStorage.setItem(KEY_LS, k.trim()) : localStorage.removeItem(KEY_LS); }
  function base() { return (cfg.proxyUrl || cfg.apiBase).replace(/\/$/, ""); }
  function usingProxy() { return !!cfg.proxyUrl; }

  function errMsg(status, body) {
    if (status === 403) return "403 Authorization failed. This key can list models but is not authorized for inference. Fix: on build.nvidia.com open the model page, click 'Generate API Key' there to mint a key for that model, verify your account/phone, or contact help@build.nvidia.com. Also apply first for gated models (Magpie TTS, VoiceChat, AI Video Detector).";
    if (status === 429) return "429 Rate limited (free tier ~40 RPM). Wait a few seconds and retry; the app already queues and backs off once.";
    if (status === 404) return "404 Model not found for this key. Model ids change without notice - re-check the exact id on build.nvidia.com/models.";
    return status + " " + (body || "").slice(0, 300);
  }

  async function req(path, payload, attempt) {
    attempt = attempt || 0;
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (!usingProxy()) {
      const k = getKey();
      if (!k) throw new Error("No NVIDIA API key set. Paste your nvapi- key in Settings (or configure the Worker proxy in js/config.js).");
      headers["Authorization"] = "Bearer " + k;
    }
    let res;
    try {
      res = await fetch(base() + path, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
      throw new Error("Network error calling NVIDIA API (CORS/offline?). For production use the Worker proxy. " + e.message);
    }
    if (res.status === 429 && attempt < 1) {
      await new Promise(r => setTimeout(r, 4000));
      return req(path, payload, attempt + 1);
    }
    if (!res.ok) throw new Error(errMsg(res.status, await res.text().catch(() => "")));
    return res.json();
  }

  async function chat(messages, opts) {
    opts = opts || {};
    const models = [opts.model || cfg.models.chat].concat(cfg.models.chatFallbacks);
    let lastErr;
    for (const m of models) {
      try {
        const j = await req("/chat/completions", {
          model: m, messages, max_tokens: opts.maxTokens || 1200,
          temperature: opts.temperature != null ? opts.temperature : 0.3,
          stream: false
        });
        const c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
        if (c) return c;
        lastErr = new Error("Empty reply from " + m + " (reasoning models need max_tokens >= 1024).");
      } catch (e) { lastErr = e; if (!/404|403/.test(e.message)) throw e; }
    }
    throw lastErr;
  }

  async function embed(texts, inputType) {
    const j = await req("/embeddings", {
      model: cfg.models.embed, input: texts,
      input_type: inputType || "passage", encoding_format: "float", truncate: "END"
    });
    return j.data.map(d => d.embedding);
  }

  function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  async function models() {
    const headers = {};
    if (!usingProxy()) headers["Authorization"] = "Bearer " + getKey();
    const res = await fetch(base() + "/models", { headers });
    if (!res.ok) throw new Error(errMsg(res.status, ""));
    const j = await res.json();
    return j.data.map(m => m.id);
  }

  window.NVIDIA = { getKey, setKey, chat, embed, cosine, models, usingProxy };
})();
