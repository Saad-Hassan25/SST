import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const SRT = createRequire(import.meta.url)('../docs/tools/js/srt.js');
const RIVA='nvidia/riva-translate-4b-instruct-v2', FAST='nvidia/nemotron-3.5-lightning-30b-a3b', DEEPSEEK='deepseek-ai/deepseek-v4.1-flash';
function translator(chat){
  const context={window:{PROMPTER_CONFIG:{models:{translate:RIVA,chatFast:FAST},languages:[['en','English'],['es','Spanish'],['ar','Arabic'],['fr','French'],['ur','Urdu']]}},document:{},NVIDIA:{chat},SRT};
  vm.runInNewContext(readFileSync(new URL('../docs/tools/js/tools.js',import.meta.url),'utf8'),context);
  return context.window.PrompterTools;
}

test('translation falls back on unavailable Riva and keeps subtitle timing and speaker labels',async()=>{
  const calls=[],cues=[{start:.16,end:.96,text:'Speaker 1: Hello'},{start:2,end:3,text:'Welcome'}];
  const tools=translator(async(messages,{model})=>{calls.push(model);if(model===RIVA)throw new Error('NVIDIA HTTP 503');return '[0] Hola [1] Bienvenido';});
  const result=await tools.translateCues(cues,'en','es');
  assert.deepEqual(calls,[RIVA,FAST]);assert.equal(result[0].text,'Speaker 1: Hola');
  assert.equal(SRT.toSRT(result),'1\n00:00:00,160 --> 00:00:00,960\nSpeaker 1: Hola\n\n2\n00:00:02,000 --> 00:00:03,000\nBienvenido\n');
});

test('malformed Riva and Nemotron replies use DeepSeek; all failed models publish no partial subtitles',async()=>{
  const calls=[],cues=[{start:0,end:1,text:'Hello'},{start:2,end:3,text:'World'}];
  const tools=translator(async(_messages,{model})=>{calls.push(model);return model===DEEPSEEK?'[0] Hola [1] Mundo':'[0] Missing a cue';});
  const result=await tools.translateCues(cues,'en','es');assert.equal(result[1].text,'Mundo');assert.deepEqual(calls,[RIVA,FAST,DEEPSEEK]);
  const broken=translator(async()=> '[0] Missing a cue');
  await assert.rejects(()=>broken.translateCues(cues,'en','es'),/did not preserve every subtitle cue/);assert.equal(cues[1].text,'World');
});

test('a failed Riva pivot retries the original language and source with the backup',async()=>{
  const calls=[];
  const tools=translator(async(messages,{model})=>{calls.push({model,messages});if(model===RIVA){if(calls.length===1)return '[0] English pivot';throw new Error('Unavailable');}return '[0] Bonjour';});
  await tools.translateCues([{start:0,end:1,text:'Original Arabic source'}],'ar','fr');
  assert.deepEqual(calls.map(c=>c.model),[RIVA,RIVA,FAST]);assert.equal(calls[2].messages[1].content,'[0] Original Arabic source');assert.match(calls[2].messages[0].content,/from Arabic to French/);
});

test('an unavailable translator is skipped for later batches; Urdu bypasses Riva',async()=>{
  const calls=[],cues=Array.from({length:13},(_,i)=>({start:i*2,end:i*2+1,text:'Hello'}));
  const tools=translator(async(messages,{model})=>{calls.push(model);if(model===RIVA)throw new Error('Unavailable');if(!messages[1].content.includes('[0]'))return 'Urdu translation';return [...messages[1].content.matchAll(/\[\d+\]/g)].map(m=>m[0]+' Translated').join(' ');});
  assert.equal((await tools.translateCues(cues,'en','es')).length,13);assert.deepEqual(calls,[RIVA,FAST,FAST]);
  calls.length=0;assert.equal(await tools.translateText('Hello','en','ur'),'Urdu translation');assert.deepEqual(calls,[FAST]);
});
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
