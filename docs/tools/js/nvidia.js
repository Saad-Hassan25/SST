/* Server-side keys only. Model calls become resumable jobs, never long browser fetches. */
(function () {
  const cfg = window.PROMPTER_CONFIG;
  const base = () => cfg.proxyUrl.replace(/\/$/, "");
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let lastDigest;
  const read = () => { try { return JSON.parse(sessionStorage.getItem("prompter_ai_requests") || "{}"); } catch { return {}; } };
  const save = value => { try { sessionStorage.setItem("prompter_ai_requests", JSON.stringify(value)); } catch { /* storage may be disabled */ } };
  async function http(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(base() + path, { ...options, signal: controller.signal });
      const value = await res.json();
      if (!res.ok) throw Object.assign(new Error(value.error || "AI service unavailable."), { status: res.status });
      return value;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Connection timed out. Your model job can still be running.");
      throw e;
    } finally { clearTimeout(timer); }
  }
  function report(value) { if (window.NVIDIA.onProgress) window.NVIDIA.onProgress(value); }
  async function poll(id, onProgress = report) {
    const started = Date.now();
    let failures = 0;
    while (Date.now() - started < 20 * 60000) {
      let job;
      try { job = await http("/jobs/" + encodeURIComponent(id)); failures = 0; }
      catch (e) {
        if (e.status === 404) throw e;
        onProgress({ job_id: id, status: "reconnecting", message: "Connection interrupted. Reconnecting to your saved job." });
        if (++failures >= 12) throw new Error("Unable to reconnect. Use the saved job link to check later.");
        await pause(5000); continue;
      }
      onProgress({ ...job, job_id: id });
      if (job.status === "done") return job.result;
      if (job.status === "error") throw new Error(job.message || "The model job failed.");
      await pause(job.status === "queued" ? 4000 : 3000);
    }
    throw new Error("This model job is taking longer than expected. Use its saved link to keep checking.");
  }
  async function req(kind, payload) {
    const bytes = new TextEncoder().encode(JSON.stringify({ kind, payload }));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
    const saved = read();
    lastDigest = digest;
    // Replaying a resumed multi-step tool reuses completed jobs and waits for the
    // in-flight step, instead of charging quota and redoing previous batches.
    let record = saved[digest];
    if (!record || Date.now() - record.created > 23 * 3600000) {
      record = { id: crypto.randomUUID(), created: Date.now(), submitted: false };
      saved[digest] = record;
      save(saved);
    }
    if (!record.submitted) {
      const job = await http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: record.id, kind, payload, refresh: !!record.refresh }) });
      record.submitted = true; save(saved); report(job);
    }
    try { return await poll(record.id); }
    catch (e) {
      // Failed/expired jobs can be submitted afresh on the next explicit run.
      if (e.status === 404 || /model job failed|NVIDIA|three attempts|within 15 minutes|specialized|rejected this input/i.test(e.message)) {
        delete saved[digest]; save(saved);
      }
      throw e;
    }
  }
  async function chat(messages, opts = {}) {
    const result = await req("chat", { model: opts.model || cfg.models.chat, messages,
      max_tokens: opts.maxTokens || 2048, temperature: opts.temperature ?? 0.3 });
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("The model returned no answer.");
    return content;
  }
  async function embed(texts, inputType = "passage") {
    const result = await req("embed", { model: cfg.models.embed, input: texts, input_type: inputType });
    const rows = result.data.slice().sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length || rows.some((row, i) => row.index !== i)) throw new Error("The embedding result is incomplete.");
    return rows.map(row => row.embedding);
  }
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) throw new Error("Search index dimensions changed. Re-index the transcript.");
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
    return dot / (Math.sqrt(aa * bb) || 1);
  }
  function invalidateResult() {
    if (!lastDigest) return;
    const saved = read(); saved[lastDigest] = { id: crypto.randomUUID(), created: Date.now(), submitted: false, refresh: true }; save(saved);
  }
  window.NVIDIA = { chat, embed, cosine, poll, http, invalidateResult, onProgress: null };
})();
