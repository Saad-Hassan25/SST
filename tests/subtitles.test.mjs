import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const SRT = createRequire(import.meta.url)('../docs/tools/js/srt.js');
test('subtitle timestamps carry milliseconds and reject malformed input', () => {
  assert.equal(SRT.secToTs(59.9996, true), '00:01:00,000');
  assert.equal(SRT.tsToSec('01:02.500'), 62.5);
  assert.throws(() => SRT.tsToSec('00:99:99,999'));
  assert.throws(() => SRT.secToTs(-1));
});
test('SRT and VTT imports preserve Unicode, speakers, line breaks and timings', () => {
  const source = '\uFEFF1\r\n00:00:01,000 --> 00:00:04,000\r\nSpeaker 1: مرحبا\r\nالعالم\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nHello';
  const cues = SRT.parseSRT(source);
  assert.equal(cues.length, 2); assert.equal(cues[0].text, 'Speaker 1: مرحبا\nالعالم');
  assert.deepEqual(SRT.parseSRT(SRT.toSRT(cues)), cues);
  assert.deepEqual(SRT.parseSRT('WEBVTT\n\n00:01.000 --> 00:04.000\nhello'), [{ start: 1, end: 4, text: 'hello' }]);
  assert.ok(SRT.toVTT([{ start: 0, end: 1, text: '<script>&' }]).includes('&lt;script&gt;&amp;'));
});
test('invalid cue durations/order fail instead of producing broken subtitles', () => {
  assert.throws(() => SRT.parseSRT('1\n00:00:04,000 --> 00:00:01,000\nhello'));
  assert.throws(() => SRT.parseSRT('1\n00:00:04,000 --> 00:00:05,000\nhello\n\n2\n00:00:01,000 --> 00:00:02,000\nworld'));
  assert.deepEqual(SRT.textToCues(''), []);
});
test('retrieval chunking includes the final unpunctuated passage and retains timestamps', () => {
  const chunks = SRT.passages('First sentence. Final thought without punctuation', 18);
  assert.match(chunks.map(c => c.text).join(' '), /without\s+punctuation/);
  const timed = SRT.passages('1\n00:00:01,000 --> 00:00:04,000\nhello');
  assert.equal(timed[0].start, 1); assert.match(timed[0].text, /00:00:01.000/);
  assert.ok(SRT.wrap('one two three four five six', 12).split('\n').every(line => line.length <= 12));
});
