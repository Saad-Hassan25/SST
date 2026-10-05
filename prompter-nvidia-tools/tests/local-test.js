/* Local logic tests - run: node tests/local-test.js */
const SRT = require("../js/srt.js");
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
}
eq("tsToSec", SRT.tsToSec("00:01:02,500"), 62.5);
eq("secToTs srt", SRT.secToTs(62.5, true), "00:01:02,500");
eq("secToTs vtt", SRT.secToTs(62.5, false), "00:01:02.500");
const srt = "1\n00:00:01,000 --> 00:00:04,000\nمرحبا بالعالم\n\n2\n00:00:05,000 --> 00:00:08,000\nهذا اختبار\n";
const cues = SRT.parseSRT(srt);
eq("parse count", cues.length, 2);
eq("parse first", cues[0], { start: 1, end: 4, text: "مرحبا بالعالم" });
eq("roundtrip contains", SRT.toSRT(cues).includes("00:00:05,000 --> 00:00:08,000"), true);
eq("vtt header", SRT.toVTT(cues).startsWith("WEBVTT"), true);
const tc = SRT.textToCues("one two three four five six seven eight nine ten eleven twelve thirteen", 4);
eq("textToCues splits", tc.length, 2);
eq("textToCues timing", [tc[1].start, tc[1].end], [4, 8]);
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
