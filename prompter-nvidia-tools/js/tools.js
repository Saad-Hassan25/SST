/* Tool logic. Chat/embedding/vision tools call NVIDIA free endpoints live.
   Gated or non-chat tools (dubbing, audio cleanup, AI-video detector, pose, voicechat)
   render their full UI and explain exactly what unlocks them - see README. */
(function () {
  const M = window.PROMPTER_CONFIG.models;
  const $ = id => document.getElementById(id);
  function out(id, txt) { const e = $(id); e.textContent = txt; e.classList.remove("hidden"); }
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? "Working..." : label; }
  async function guard(btn, label, fn) {
    busy(btn, true);
    try { await fn(); } catch (e) { alert(e.message); }
    busy(btn, false, label);
  }
  function needTranscript(id) {
    const v = $(id).value.trim();
    if (!v) throw new Error("Paste a transcript first (get one from Prompter's Create transcript tool).");
    return v;
  }

  /* 1. Summary + Chapters */
  window.toolSummary = b => guard(b, "Summarize", async () => {
    const t = needTranscript("sum-input");
    const r = await NVIDIA.chat([
      { role: "system", content: "You summarize media transcripts. Output: 5-line summary, then chapters as 'MM:SS - Title' if timestamps exist (else numbered sections), then 5 key moments with one-line why-it-matters. Be faithful, no invented facts." },
      { role: "user", content: t.slice(0, 60000) }], { maxTokens: 1600 });
    out("sum-output", r);
  });

  /* 2. Transcript Translator (text) */
  window.toolTranslate = b => guard(b, "Translate", async () => {
    const t = needTranscript("tr-input");
    const from = $("tr-from").value, to = $("tr-to").value;
    const name = c => (window.PROMPTER_CONFIG.languages.find(l => l[0] === c) || [])[1] || c;
    const chunks = t.match(/[\s\S]{1,2500}/g) || [];
    let done = [];
    for (const ch of chunks) {
      done.push(await NVIDIA.chat([
        { role: "user", content: "Translate the following text" + (from === "auto" ? "" : " from " + name(from)) + " to " + name(to) + ". Preserve paragraphs and speaker labels like 'Speaker 1:'. Output only the translation.\n\n" + ch }],
        { model: M.translate, maxTokens: 2000, temperature: 0 }));
    }
    out("tr-output", done.join("\n"));
  });

  /* 3. Chat with Video / Semantic Search (embeddings + RAG) */
  let chunks = [], vecs = [];
  window.toolIndex = b => guard(b, "Index transcript", async () => {
    const t = needTranscript("chat-input");
    chunks = (t.match(/[^.!?]+[.!?]+/g) || [t]).map(s => s.trim()).filter(Boolean);
    const grouped = [];
    for (let i = 0; i < chunks.length; i += 4) grouped.push(chunks.slice(i, i + 4).join(" "));
    chunks = grouped;
    vecs = [];
    for (let i = 0; i < chunks.length; i += 16) vecs.push(...await NVIDIA.embed(chunks.slice(i, i + 16), "passage"));
    out("chat-output", "Indexed " + chunks.length + " passages. Ask a question below.");
    $("chat-q-row").classList.remove("hidden");
  });
  window.toolAsk = b => guard(b, "Ask", async () => {
    const q = $("chat-q").value.trim(); if (!q) return;
    const [qv] = await NVIDIA.embed([q], "query");
    const top = chunks.map((c, i) => [NVIDIA.cosine(qv, vecs[i]), c]).sort((a, z) => z[0] - a[0]).slice(0, 5).map(x => x[1]).join("\n---\n");
    const r = await NVIDIA.chat([
      { role: "system", content: "Answer only from the transcript excerpts. If not present, say so." },
      { role: "user", content: "Excerpts:\n" + top + "\n\nQuestion: " + q }]);
    out("chat-output", r);
  });

  /* 4. Content Repurposer */
  window.toolRepurpose = b => guard(b, "Repurpose", async () => {
    const t = needTranscript("rep-input"), kind = $("rep-kind").value;
    const prompts = {
      blog: "Turn this transcript into a blog post with headline, subheads and a conclusion. Keep the speaker's points, cut filler.",
      yt: "Write a YouTube description: 2-line hook, summary, chapter list, hashtags.",
      x: "Write an X/Twitter thread (numbered, each under 280 chars) from this transcript's best points.",
      linkedin: "Write a LinkedIn post (professional, first person, line breaks, 3 hashtags) from this transcript.",
      newsletter: "Write a newsletter section: headline, 3 bullet takeaways, one quotable line."
    };
    out("rep-output", await NVIDIA.chat([{ role: "user", content: prompts[kind] + "\n\nTranscript:\n" + t.slice(0, 50000) }], { maxTokens: 1600 }));
  });

  /* 5. Smart Subtitles: text or SRT -> clean SRT/VTT download */
  window.toolSmartSubs = b => guard(b, "Make subtitles", async () => {
    const raw = needTranscript("ss-input");
    const cues = raw.includes("-->") ? SRT.parseSRT(raw) : SRT.textToCues(raw);
    if (!cues.length) throw new Error("No cues found.");
    $("ss-downloads").classList.remove("hidden");
    window._ssCues = cues;
    out("ss-output", SRT.toSRT(cues).slice(0, 4000) + "\n... (" + cues.length + " cues)");
  });
  window.dlSubs = fmt => {
    const cues = window._ssCues || [];
    const blob = new Blob([fmt === "srt" ? SRT.toSRT(cues) : SRT.toVTT(cues)], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "subtitles." + fmt; a.click(); URL.revokeObjectURL(a.href);
  };

  /* 6. Meeting / Podcast Notes */
  window.toolNotes = b => guard(b, "Extract notes", async () => {
    const t = needTranscript("notes-input");
    const r = await NVIDIA.chat([
      { role: "system", content: "Extract structured notes as JSON-ish plain text: DECISIONS, ACTION ITEMS (owner - task - deadline if stated), OPEN QUESTIONS, BEST QUOTES (verbatim). Say 'none stated' where empty." },
      { role: "user", content: t.slice(0, 60000) }], { maxTokens: 1600 });
    out("notes-output", r);
  });

  /* 7. VIDEO SUBTITLE TRANSLATOR (new feature): video (file/URL) + SRT -> translated subs on the video */
  let vsCues = [];
  window.vsLoadVideo = () => {
    const url = $("vs-url").value.trim(), file = $("vs-file").files[0];
    const v = $("vs-video");
    if (file) v.src = URL.createObjectURL(file);
    else if (url) v.src = url;
    else { alert("Upload a video file or paste a video URL first."); return; }
    v.classList.remove("hidden");
  };
  window.vsTranslate = b => guard(b, "Translate subtitles", async () => {
    const raw = $("vs-srt").value.trim();
    if (!raw) throw new Error("Paste the video's subtitles (SRT) or plain transcript. Tip: run the video through Prompter's Create transcript first - e.g. Arabic speech -> Arabic SRT, then translate here to English.");
    vsCues = raw.includes("-->") ? SRT.parseSRT(raw) : SRT.textToCues(raw);
    const to = $("vs-to").value, from = $("vs-from").value;
    const name = c => (window.PROMPTER_CONFIG.languages.find(l => l[0] === c) || [])[1] || c;
    const B = 20, done = [];
    for (let i = 0; i < vsCues.length; i += B) {
      const batch = vsCues.slice(i, i + B);
      const joined = batch.map((c, j) => "[" + j + "] " + c.text).join("\n");
      const r = await NVIDIA.chat([
        { role: "user", content: "Translate each line" + (from === "auto" ? "" : " from " + name(from)) + " to " + name(to) + ". Keep the [n] markers, one line per cue, output only translated lines.\n\n" + joined }],
        { model: M.translate, maxTokens: 2000, temperature: 0 });
      const map = {};
      r.split("\n").forEach(l => { const m = l.match(/^\[(\d+)\]\s*(.*)/); if (m) map[+m[1]] = m[2]; });
      batch.forEach((c, j) => done.push({ start: c.start, end: c.end, text: map[j] || c.text }));
      out("vs-output", "Translating... " + done.length + "/" + vsCues.length + " cues");
    }
    vsCues = done;
    const v = $("vs-video");
    v.querySelectorAll("track").forEach(t => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles"; track.label = name(to); track.default = true;
    track.src = URL.createObjectURL(new Blob([SRT.toVTT(vsCues)], { type: "text/vtt" }));
    v.appendChild(track);
    if (v.textTracks[0]) v.textTracks[0].mode = "showing";
    $("vs-downloads").classList.remove("hidden");
    out("vs-output", "Done: " + vsCues.length + " cues translated to " + name(to) + ". Subtitles are showing on the video (CC button). Download SRT/VTT below. Burned-in subtitles: feed the SRT + video to ffmpeg (command in README).");
  });
  window.vsDl = fmt => {
    const blob = new Blob([fmt === "srt" ? SRT.toSRT(vsCues) : SRT.toVTT(vsCues)], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "subtitles-translated." + fmt; a.click(); URL.revokeObjectURL(a.href);
  };

  /* 8/9. Vision: image describe + video frames describe/Q&A */
  function fileToDataURL(f) { return new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(f); }); }
  async function vision(dataUrl, prompt, fast) {
    return NVIDIA.chat([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
      { model: fast ? M.visionFast : M.vision, maxTokens: 800 });
  }
  window.toolImage = b => guard(b, "Describe image", async () => {
    const f = $("img-file").files[0]; if (!f) throw new Error("Choose an image first.");
    const kind = $("img-kind").value;
    const p = kind === "alt" ? "Write concise alt text for accessibility (max 30 words), then a longer description below it."
      : kind === "ocr" ? "Extract all readable text from this image exactly, preserving layout order."
      : "Describe this image in detail: subjects, setting, text visible, and anything notable.";
    out("img-output", await vision(await fileToDataURL(f), p, true));
  });
  window.toolVideoDescribe = b => guard(b, "Describe video", async () => {
    const f = $("vid-file").files[0]; if (!f) throw new Error("Choose a video file first.");
    const v = document.createElement("video");
    v.src = URL.createObjectURL(f); v.muted = true;
    await new Promise(r => v.onloadedmetadata = r);
    const times = [0.1, 0.35, 0.6, 0.85].map(x => v.duration * x), frames = [];
    const cv = document.createElement("canvas");
    for (const t of times) {
      v.currentTime = t; await new Promise(r => v.onseeked = r);
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext("2d").drawImage(v, 0, 0);
      frames.push(cv.toDataURL("image/jpeg", 0.7));
    }
    const q = $("vid-q").value.trim() || "Describe what happens in this video, scene by scene.";
    const parts = [{ type: "text", text: q + " (4 frames sampled across the video)" }];
    frames.forEach(u => parts.push({ type: "image_url", image_url: { url: u } }));
    out("vid-output", await NVIDIA.chat([{ role: "user", content: parts }], { model: M.vision, maxTokens: 1000 }));
  });

  /* 10. Shorts / Clip Finder */
  window.toolClips = b => guard(b, "Find clips", async () => {
    const t = needTranscript("clips-input");
    const r = await NVIDIA.chat([
      { role: "system", content: "You find short-form clip moments in transcripts. Return the 5 strongest 30-60s moments: quote the opening line, give the topic, and score viral potential 1-10 with one reason. Prefer self-contained, emotional or surprising segments." },
      { role: "user", content: t.slice(0, 60000) }], { model: M.chatFast, maxTokens: 1400 });
    out("clips-output", r);
  });

  /* 11. Content Safety Check */
  window.toolSafety = b => guard(b, "Check safety", async () => {
    const t = needTranscript("safe-input");
    const r = await NVIDIA.chat([
      { role: "user", content: "Classify this text for publication safety. Reply with the safety classification and list any flagged categories (unsafe/toxic content) with brief evidence, or state it is safe.\n\n" + t.slice(0, 8000) }],
      { model: M.safety, maxTokens: 500, temperature: 0 });
    out("safe-output", r);
  });

  /* Settings self-test */
  window.toolSelfTest = b => guard(b, "Run self-test", async () => {
    const lines = [];
    try { const ids = await NVIDIA.models(); lines.push("PASS /models - key lists " + ids.length + " models"); }
    catch (e) { lines.push("FAIL /models - " + e.message); }
    try { const r = await NVIDIA.chat([{ role: "user", content: "Reply with exactly: PROMPTER_OK" }], { maxTokens: 1024, temperature: 0 }); lines.push("PASS chat - " + r.slice(0, 80)); }
    catch (e) { lines.push("FAIL chat - " + e.message); }
    try { const [v] = await NVIDIA.embed(["test"], "query"); lines.push("PASS embeddings - dims " + v.length); }
    catch (e) { lines.push("FAIL embeddings - " + e.message); }
    out("selftest-output", lines.join("\n"));
  });
})();
