import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleSpeech } from '../worker/speech.js';
import { WhisperJob, handleWhisper } from '../worker/whisper.js';
const { wordsToCues, wavBlob } = createRequire(import.meta.url)('../docs/studio/media.js');

test('word timing produces ordered cues with sentence and silence boundaries', () => {
  const words = [{ text: 'Hello', start: 0.1, end: 0.3 }, { text: 'world.', start: 0.4, end: 0.7 }, { text: 'Next', start: 2, end: 2.4 }, { text: 'part', start: 4, end: 4.5 }];
  assert.deepEqual(wordsToCues(words), [{ start: 0.1, end: 0.7, text: 'Hello world.' }, { start: 2, end: 2.4, text: 'Next' }, { start: 4, end: 4.5, text: 'part' }]);
  assert.throws(() => wordsToCues([{ text: 'bad', start: 2, end: 1 }]), /invalid word timing/);
});

test('Whisper dispatch contains only a job ID and audio is deleted after a validated result', async () => {
  const data = new Map();
  const storage = {
    async get(key) { return Array.isArray(key) ? new Map(key.filter(k => data.has(k)).map(k => [k, data.get(k)])) : data.get(key); },
    async put(key, value) { if (typeof key === 'object') Object.entries(key).forEach(([k,v]) => data.set(k,v)); else data.set(key,value); },
    async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(key => data.delete(key)); },
    async transaction(fn) { return fn(storage); }, async setAlarm() {}, async deleteAll() { data.clear(); }
  };
  const config = { ...env, GITHUB_TOKEN: 'github-secret', GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', WHISPER_BRIDGE_KEY: 'bridge-secret' };
  const object = new WhisperJob({ storage }, config);
  config.WHISPER_JOBS = { idFromName: id => id, get: () => ({ fetch: (...args) => object.fetch(new Request(...args)) }) };
  const original = globalThis.fetch, id = '12345678-1234-4123-8123-123456789abc';
  globalThis.fetch = async (url, options) => { assert.equal(url, 'https://api.github.com/repos/owner/repo/dispatches'); assert.deepEqual(JSON.parse(options.body), { event_type: 'whisper', client_payload: { job_id: id } }); return new Response(null, { status: 204 }); };
  try {
    const start = await object.fetch(new Request('https://internal/start', { method: 'POST', body: JSON.stringify({ id, language: 'ur', audio: btoa('private-audio') }) }));
    assert.equal(start.status, 202);
    const status = await (await object.fetch(new Request('https://internal/status'))).json();
    assert.ok(!JSON.stringify(status).includes('private-audio'));
    assert.equal((await handleWhisper(new Request('https://relay/speech/whisper/' + id + '/input'), config)).status, 403);
    const input = await handleWhisper(new Request('https://relay/speech/whisper/' + id + '/input', { headers: { Authorization: 'Bearer bridge-secret' } }), config);
    assert.equal(await input.text(), 'private-audio'); assert.equal(input.headers.get('X-Speech-Language'), 'ur');
    const result = await object.fetch(new Request('https://internal/result', { method: 'POST', body: JSON.stringify({ text: 'hello', words: [], segments: [{ start: 0, end: 4, text: 'hello' }] }) }));
    assert.equal(result.status, 200); assert.ok(!data.has('audio:count')); assert.ok(!data.has('audio:0'));
    const done = await (await object.fetch(new Request('https://internal/status'))).json();
    assert.equal(done.status, 'done'); assert.equal(done.timing_quality, 'approximate');
    assert.equal((await object.fetch(new Request('https://internal/input'))).status, 409);
  } finally { globalThis.fetch = original; }
});
test('browser audio conversion writes signed mono PCM with the correct WAV header', async () => {
  const wav = wavBlob(new Float32Array([-2, -0.5, 0, 0.5, 2])), view = new DataView(await wav.arrayBuffer());
  assert.equal(view.byteLength, 54); assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(52, true), 32767);
});
const origin = 'https://prompter.neuralforge.tech';
const env = { NVIDIA_API_KEY: 'private-test-key', ALLOWED_ORIGIN: origin, AI_JOBS: {
  idFromName: name => name, get: () => ({ fetch: async url => Response.json(url.endsWith('admit') ? { allowed: true } : { wait: 0 }) }) } };
const request = (body, headers = {}) => new Request('https://relay.test/speech/transcribe', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/wav', ...headers }, body });
test('speech rejects foreign origins, unsupported audio, and oversized uploads before inference', async () => {
  assert.equal((await handleSpeech(request('bad', { Origin: 'https://other.test' }), env)).status, 403);
  assert.equal((await handleSpeech(request('bad'), env)).status, 400);
  assert.equal((await handleSpeech(request('bad', { 'Content-Length': '2000001' }), env)).status, 413);
  assert.equal((await handleSpeech(request('bad', { 'Content-Type': 'text/plain' }), env)).status, 415);
});
test('speech keeps credentials server-side and converts NVIDIA milliseconds into seconds', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith('https://1598d209-')); assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    assert.equal(options.body.get('language'), 'en-US');
    return Response.json({ text: 'Hello.', words: [{ word: 'Hello.', start: 160, end: 640 }] });
  };
  try {
    const response = await handleSpeech(request(wavBlob(new Float32Array(16000))), env), value = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(value.words, [{ text: 'Hello.', start: 0.16, end: 0.64 }]);
    assert.ok(!JSON.stringify(value).includes('private-test-key'));
  } finally { globalThis.fetch = original; }
});
