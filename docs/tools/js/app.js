(async function () {
  const $ = id => document.getElementById(id), cfg = window.PROMPTER_CONFIG;
  const destinations = ["sum-input", "tr-input", "chat-input", "rep-input", "ss-input", "notes-input", "vs-srt", "clips-input", "safe-input"];
  for (const [id, selected] of [["tr-from", "auto"], ["tr-to", "en"], ["vs-from", "auto"], ["vs-to", "en"]]) {
    for (const [code, name] of cfg.languages) {
      if (selected === "en" && code === "auto") continue;
      const option = document.createElement("option"); option.value = code; option.textContent = name; option.selected = code === selected; $(id).appendChild(option);
    }
  }
  function useSource(text) {
    destinations.forEach(id => { $(id).value = text; });
    if (text.includes("-->")) $("burn-srt").value = SRT.toSRT(SRT.parseSRT(text));
    $("chat-q-row").classList.add("hidden");
    $("import-status").textContent = "Transcript loaded into all text tools. Choose a tool below.";
  }
  $("use-source").addEventListener("click", () => {
    try { if (!$("source-text").value.trim()) throw new Error("Paste or import a transcript first."); useSource($("source-text").value); }
    catch (e) { $("import-status").textContent = e.message; }
  });
  $("source-file").addEventListener("change", async () => {
    const file = $("source-file").files[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("Import a text file under 1 MB.");
      const text = await file.text(); $("source-text").value = text; useSource(text);
    } catch (e) { $("import-status").textContent = e.message; }
  });
  // Text and structured outputs remain editable/copyable without rendering model HTML.
  document.querySelectorAll("pre.output").forEach(pre => {
    const actions = document.createElement("div"); actions.className = "row output-actions hidden";
    const copy = document.createElement("button"); copy.className = "ghost"; copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1800); }
      catch { copy.textContent = "Select text to copy"; }
    });
    const exportButton = document.createElement("button"); exportButton.className = "ghost"; exportButton.textContent = "Download text";
    exportButton.addEventListener("click", () => {
      let extension = "txt";
      if (pre.id === "notes-output") { try { JSON.parse(pre.textContent); extension = "json"; } catch {} }
      if (pre.id === "tr-output" && /^\d+\s*\n.*-->/m.test(pre.textContent)) extension = "srt";
      PrompterTools.download(pre.textContent, "prompter-" + pre.id.replace("-output", "") + "." + extension);
    });
    actions.append(copy, exportButton); pre.after(actions);
    const update = () => actions.classList.toggle("hidden", pre.classList.contains("hidden") || !pre.textContent.trim());
    new MutationObserver(update).observe(pre, { attributes: true, childList: true, characterData: true, subtree: true }); update();
  });
  let savedOperation;
  try { savedOperation = JSON.parse(sessionStorage.getItem("prompter_ai_operation") || "null"); } catch {}
  if (savedOperation?.handler) {
    $("resume-row").classList.remove("hidden");
    $("resume-operation").addEventListener("click", () => {
      for (const [id, value] of Object.entries(savedOperation.values || {})) if ($(id) && typeof value === "string") $(id).value = value;
      PrompterTools.restoreIndex();
      const button = [...document.querySelectorAll("button[onclick]")].find(b => b.getAttribute("onclick") === savedOperation.handler + "(this)");
      if (button && typeof window[savedOperation.handler] === "function") {
        $("resume-row").classList.add("hidden"); button.closest(".panel").scrollIntoView({ behavior: "smooth" }); window[savedOperation.handler](button);
      }
    });
    $("discard-operation").addEventListener("click", () => { sessionStorage.removeItem("prompter_ai_operation"); $("resume-row").classList.add("hidden"); });
  }
  const params = new URLSearchParams(location.search), sourceJob = params.get("source_job"), aiJob = params.get("ai_job");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (sourceJob && uuid.test(sourceJob)) {
    $("import-status").textContent = "Loading your completed transcript…";
    try {
      // The same Worker relays release assets, avoiding GitHub asset CORS problems.
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      let job;
      try {
        const response = await fetch(cfg.proxyUrl.replace(/\/ai$/, "") + "/status?include_subtitles=1&job_id=" + encodeURIComponent(sourceJob), { signal: controller.signal });
        job = await response.json(); if (!response.ok) throw new Error(job.error || "Couldn't load the transcript.");
      } finally { clearTimeout(timer); }
      if (job.status !== "done" || !job.transcript) throw new Error("This transcript is not ready or has expired. Open its original job link to check progress.");
      const text = job.subtitles || job.transcript; $("source-text").value = text; useSource(text);
      $("import-status").textContent = "Imported your Prompter transcript" + (job.subtitles ? " with timestamps." : ".");
    } catch (e) { $("import-status").textContent = e.message; }
  }
  if (aiJob && uuid.test(aiJob)) (async () => {
    $("saved-job").classList.remove("hidden");
    const render = job => { $("saved-status").textContent = job.message || "Checking saved job…"; };
    try {
      const result = await NVIDIA.poll(aiJob, render);
      $("saved-output").textContent = result?.choices?.[0]?.message?.content || JSON.stringify(result, null, 2);
      $("saved-status").textContent = "Result ready. This link expires after 24 hours.";
    } catch (e) { $("saved-status").textContent = e.message; }
  })();
  // Availability checks never start inference. Existing media jobs are unaffected.
  try {
    const state = await NVIDIA.http("/config");
    $("service-status").textContent = state.available ? "AI tools ready. Choose a tool when you are ready." : "AI tools are being configured. Download and transcription are available.";
    $("service-status").classList.toggle("error", !state.available);
  } catch { $("service-status").textContent = "AI service is unavailable right now. Download and transcription are available."; }
  $("vs-video").addEventListener("error", () => { $("vs-output").textContent = "This video could not be loaded. Try a local MP4 or a direct video URL that allows playback."; $("vs-output").classList.remove("hidden"); });
  if (cfg.turnstileSiteKey) {
    let widget, waiters = [];
    const settle = (error, token) => { const pending = waiters; waiters = []; pending.forEach(w => error ? w.reject(error) : w.resolve(token)); };
    window.captionTurnstileReady = () => {
      widget = window.turnstile.render("#caption-ts", { sitekey: cfg.turnstileSiteKey, execution: "execute", appearance: "interaction-only", theme: "dark",
        callback: token => settle(null, token), "error-callback": () => { settle(new Error("Verification failed. Try again.")); return true; } });
    };
    window.getCaptionTurnstileToken = () => new Promise((resolve, reject) => {
      if (widget === undefined) { reject(new Error("Verification has not loaded yet. Please try again.")); return; }
      const timer = setTimeout(() => settle(new Error("Verification timed out.")), 20000);
      waiters.push({ resolve: t => { clearTimeout(timer); resolve(t); }, reject: e => { clearTimeout(timer); reject(e); } }); window.turnstile.execute(widget);
    });
    window.resetCaptionTurnstile = () => window.turnstile.reset(widget);
    const script = document.createElement("script"); script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=captionTurnstileReady&render=explicit"; script.async = true; document.head.appendChild(script);
  }
})();
