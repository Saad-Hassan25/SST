(function () {
  function tsToSec(value) {
    const m = String(value).match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[,.](\d{3})$/);
    if (!m) throw new Error("Invalid subtitle timestamp: " + value);
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  }
  function secToTs(sec, comma) {
    if (!Number.isFinite(sec) || sec < 0) throw new Error("Invalid subtitle time.");
    const total = Math.round(sec * 1000);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(total / 3600000))}:${p(Math.floor(total / 60000) % 60)}:${p(Math.floor(total / 1000) % 60)}${comma ? "," : "."}${p(total % 1000, 3)}`;
  }
  function parseSRT(text) {
    const normalized = String(text).replace(/^\uFEFF/, "").replace(/\r/g, "");
    const cues = [];
    for (const block of normalized.split(/\n\s*\n/)) {
      const lines = block.split("\n");
      const index = lines.findIndex(line => line.includes("-->"));
      if (index < 0) continue;
      const times = lines[index].split("-->").map(s => s.trim().split(/\s/)[0]);
      const start = tsToSec(times[0]), end = tsToSec(times[1]);
      const caption = lines.slice(index + 1).join("\n").trim();
      if (end <= start || !caption) throw new Error("Subtitle cues must contain text and end after they start.");
      if (cues.length && start < cues[cues.length - 1].start) throw new Error("Subtitles must be in time order.");
      cues.push({ start, end, text: caption });
    }
    return cues;
  }
  const toSRT = cues => cues.map((c, i) => `${i + 1}\n${secToTs(c.start, true)} --> ${secToTs(c.end, true)}\n${c.text}\n`).join("\n");
  const toVTT = cues => "WEBVTT\n\n" + cues.map(c => `${secToTs(c.start)} --> ${secToTs(c.end)}\n${c.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n`).join("\n");
  function textToCues(text, secPerCue = 4) {
    const words = text.trim() ? text.trim().split(/\s+/) : [];
    const cues = [];
    for (let i = 0; i < words.length; i += 12) cues.push({ start: i / 12 * secPerCue, end: (i / 12 + 1) * secPerCue, text: words.slice(i, i + 12).join(" ") });
    return cues;
  }
  // Sentence-aware wrapping with the supplied cue boundaries preserved exactly.
  function wrap(text, width = 42) {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const lines = []; let line = "";
    for (const word of words) {
      if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
      else line += (line ? " " : "") + word;
    }
    if (line) lines.push(line);
    return lines.join("\n");
  }
  function passages(text, size = 1800) {
    const cues = text.includes("-->") ? parseSRT(text) : [];
    const units = cues.length ? cues.map(c => ({ text: `[${secToTs(c.start)}] ${c.text.replace(/\n/g, " ")}`, start: c.start }))
      : text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim()).flatMap(s => {
        const parts = [];
        while (s.length > size) {
          const whitespace = s.lastIndexOf(" ", size);
          const end = whitespace > 0 ? whitespace : size;
          parts.push({ text: s.slice(0, end) }); s = s.slice(end).trimStart();
        }
        if (s.trim()) parts.push({ text: s });
        return parts;
      });
    const result = []; let chunk = "", start;
    for (const unit of units) {
      if (chunk && chunk.length + unit.text.length > size) { result.push({ text: chunk, start }); chunk = ""; }
      if (!chunk) start = unit.start;
      chunk += (chunk ? "\n" : "") + unit.text;
    }
    if (chunk) result.push({ text: chunk, start });
    return result;
  }
  const api = { tsToSec, secToTs, parseSRT, toSRT, toVTT, textToCues, wrap, passages };
  if (typeof window !== "undefined") window.SRT = api;
  if (typeof module !== "undefined") module.exports = api;
})();
