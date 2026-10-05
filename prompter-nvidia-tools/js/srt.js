/* SRT/VTT helpers + subtitle translation (shared by browser app and node test). */
(function () {
  function tsToSec(ts) {
    const m = ts.replace(",", ".").match(/(\d+):(\d+):(\d+)\.(\d+)/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }
  function secToTs(sec, comma) {
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    const p = (n, l) => String(n).padStart(l, "0");
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + (comma ? "," : ".") + p(ms, 3);
  }
  function parseSRT(text) {
    const cues = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
    for (const b of blocks) {
      const lines = b.split("\n").filter(l => l.trim() !== "");
      const ti = lines.findIndex(l => l.includes("-->"));
      if (ti === -1) continue;
      const [a, z] = lines[ti].split("-->").map(x => x.trim().split(" ")[0]);
      cues.push({ start: tsToSec(a), end: tsToSec(z), text: lines.slice(ti + 1).join(" ").trim() });
    }
    return cues;
  }
  function toSRT(cues) {
    return cues.map((c, i) => (i + 1) + "\n" + secToTs(c.start, true) + " --> " + secToTs(c.end, true) + "\n" + c.text + "\n").join("\n");
  }
  function toVTT(cues) {
    return "WEBVTT\n\n" + cues.map(c => secToTs(c.start) + " --> " + secToTs(c.end) + "\n" + c.text + "\n").join("\n");
  }
  /* Split plain transcript text into timed cues (Smart Subtitles fallback when no SRT exists). */
  function textToCues(text, secPerCue) {
    secPerCue = secPerCue || 4;
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const cues = []; const per = 12; // ~12 words per cue
    for (let i = 0; i < words.length; i += per) {
      const start = (i / per) * secPerCue;
      cues.push({ start, end: start + secPerCue, text: words.slice(i, i + per).join(" ") });
    }
    return cues;
  }
  const api = { tsToSec, secToTs, parseSRT, toSRT, toVTT, textToCues };
  if (typeof window !== "undefined") window.SRT = api;
  if (typeof module !== "undefined") module.exports = api;
})();
