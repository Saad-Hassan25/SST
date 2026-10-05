import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { AIJob, validateAI } from '../worker/ai.js';

const ID = '12345678-1234-4123-8123-123456789abc';
const origin = 'https://prompter.neuralforge.tech';
const chat = (model = 'nvidia/nemotron-3-super-120b-a12b') => ({ request_id: ID, kind: 'chat',
  payload: { model, messages: [{ role: 'user', content: 'Summarize the meeting.' }], max_tokens: 2048 } });
const completion = content => ({ choices: [{ message: { content } }] });
const call = (path, body, headers = {}) => new Request('https://relay.test' + path, body === undefined ? undefined : {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.lock = Promise.resolve(); }
  async get(key) {
    if (Array.isArray(key)) { assert.ok(key.length <= 128); return new Map(key.filter(k => this.data.has(k)).map(k => [k, structuredClone(this.data.get(k))])); }
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    if (typeof key === 'object') { assert.ok(Object.keys(key).length <= 128); for (const [k, v] of Object.entries(key)) await this.put(k, v); }
    else { assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024); this.data.set(key, structuredClone(value)); }
  }
  async delete(keys) { if (!Array.isArray(keys)) keys = [keys]; assert.ok(keys.length <= 128); keys.forEach(k => this.data.delete(k)); }
  async deleteAll() { this.data.clear(); }
  async list({ prefix, limit }) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); }
  async setAlarm(time) { this.alarm = time; }
  transaction(fn) { const promise = this.lock.then(() => fn(this)); this.lock = promise.catch(() => {}); return promise; }
}
function environment(extra = {}) {
  const instances = new Map();
  const env = { NVIDIA_API_KEY: 'test-server-secret', GITHUB_TOKEN: 'test-github-secret', GITHUB_OWNER: 'owner', GITHUB_REPO: 'repo', ALLOWED_ORIGIN: origin, ...extra };
  env.AI_JOBS = { idFromName: name => name, get(name) {
    if (!instances.has(name)) {
      const ctx = { storage: new Storage(), blockConcurrencyWhile: async fn => fn() };
      const object = new AIJob(ctx, env); instances.set(name, object);
    }
    return { fetch: (url, init) => instances.get(name).fetch(new Request(url, init)) };
  } };
  return { env, instances };
}

test('AI models and payloads are restricted', () => {
  assert.equal(validateAI(chat()).payload.stream, false);
  assert.equal(validateAI(chat()).payload.chat_template_kwargs.enable_thinking, false);
  assert.throws(() => validateAI(chat('unapproved/model')), /Unsupported/);
  const invalid = chat(); invalid.payload.max_tokens = 100000; assert.throws(() => validateAI(invalid));
  invalid.payload.max_tokens = 2048; invalid.payload.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://internal.test/image' } }] }];
  assert.throws(() => validateAI(invalid), /image/);
  assert.throws(() => validateAI({ ...chat(), request_id: '../../credentials' }));
  assert.throws(() => validateAI({ request_id: ID, kind: 'embed', payload: { model: 'nvidia/nemotron-3-embed-1b', input: [''], input_type: 'passage' } }));
});
test('existing health: CORS, invalid download, diarization and YouTube rejection', async () => {
  const { env } = environment();
  const preflight = await worker.fetch(new Request('https://relay.test/trigger', { method: 'OPTIONS' }), env);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  for (const body of [ { mode: 'download', url: 'ftp://test' }, { mode: 'download', url: 'https://youtube.com/watch?v=test' },
    { mode: 'download', url: 'https://media.test/video', quality: 'invalid' }, { mode: 'transcribe', url: 'https://media.test/video', diarize: true, speakers: '2;bad' } ])
    assert.equal((await worker.fetch(call('/trigger', body), env)).status, 400);
});
test('download and speaker-labelled transcription dispatch retain the existing contract', async t => {
  const { env } = environment(); let payload;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { payload = JSON.parse(opts.body); return new Response(null, { status: 204 }); });
  const response = await worker.fetch(call('/trigger', { mode: 'transcribe', url: 'https://media.test/video', diarize: true, speakers: 2 }), env);
  assert.equal(response.status, 200); assert.ok((await response.json()).job_id);
  assert.equal(payload.event_type, 'transcribe'); assert.equal(payload.client_payload.speakers, 2); assert.equal(payload.client_payload.diarize, true);
  assert.equal((await worker.fetch(call('/trigger', { mode: 'download', url: 'https://media.test/video', quality: '720p' }), env)).status, 200);
  assert.equal(payload.event_type, 'download'); assert.equal(payload.client_payload.quality, '720p');
});
test('half-uploaded releases remain running and completed transcripts prefer diarized files', async t => {
  const { env } = environment();
  let done = false;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/releases/tags/')) return Response.json({ name: 'Job test (transcribe)', body: `status: ${done ? 'done' : 'running'}\nstage: uploading\nmode: transcribe`, assets: [
      { name: 'plain.txt', browser_download_url: 'https://assets.test/plain' }, { name: 'x.diarized.txt', browser_download_url: 'https://assets.test/diarized' },
      { name: 'x.diarized.srt', browser_download_url: 'https://assets.test/srt' } ] });
    return new Response(url.endsWith('/diarized') ? 'Speaker 1: hello' : 'timed subtitles');
  });
  let result = await (await worker.fetch(call('/status?job_id=test'), env)).json(); assert.equal(result.status, 'running');
  done = true; result = await (await worker.fetch(call('/status?job_id=test&include_subtitles=1'), env)).json();
  assert.equal(result.transcript, 'Speaker 1: hello'); assert.equal(result.subtitles, 'timed subtitles'); assert.equal(result.files.length, 3);
  result = await (await worker.fetch(call('/status?job_id=test'), env)).json();
  assert.equal(result.subtitles, null, 'existing status polls must not wait on an extra subtitle download');
});
test('caption dispatch validates fixed styles and passes timed SRT without shell interpretation', async t => {
  const { env } = environment(); let dispatched;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { dispatched = JSON.parse(opts.body); return new Response(null, { status: 204 }); });
  const body = { mode: 'captions', url: 'https://media.test/video', caption_style: 'bold', subtitles: '1\n00:00:00,000 --> 00:00:01,000\nHello\n' };
  assert.equal((await worker.fetch(call('/trigger', body), env)).status, 200);
  assert.equal(dispatched.client_payload.caption_style, 'bold'); assert.equal(dispatched.event_type, 'captions');
  assert.equal((await worker.fetch(call('/trigger', { ...body, caption_style: "';bad" }), env)).status, 400);
});
test('AI is additive when bindings/key are unavailable and rejects foreign browser origins', async () => {
  assert.equal((await worker.fetch(call('/ai/jobs', chat()), {})).status, 503);
  const { env } = environment();
  assert.equal((await worker.fetch(call('/ai/jobs', chat(), { Origin: 'https://foreign.test' }), env)).status, 403);
  assert.equal((await worker.fetch(call('/ai/jobs/../../secret'), env)).status, 404);
});
test('persistent jobs start quickly, survive object recreation, keep keys server-side and expire', async t => {
  const { env, instances } = environment();
  const response = await worker.fetch(call('/ai/jobs', chat()), env); assert.equal(response.status, 202);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const state = instances.get(ID).ctx;
  instances.set(ID, new AIJob(state, env));
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer test-server-secret');
    return Response.json(completion('The meeting summary.'));
  });
  await instances.get(ID).alarm();
  const done = await (await worker.fetch(call('/ai/jobs/' + ID), env)).json();
  assert.equal(done.status, 'done'); assert.equal(done.result.choices[0].message.content, 'The meeting summary.');
  assert.ok(!JSON.stringify(done).includes('test-server-secret')); assert.ok(!state.storage.data.has('input:count'));
  await state.storage.put('job', { ...await state.storage.get('job'), expires_at: Date.now() - 1 });
  await instances.get(ID).alarm(); assert.equal(state.storage.data.size, 0);
});
test('request ids are idempotent; different inputs cannot overwrite an existing job', async () => {
  const { env, instances } = environment();
  assert.equal((await worker.fetch(call('/ai/jobs', chat()), env)).status, 202);
  assert.equal((await worker.fetch(call('/ai/jobs', chat()), env)).status, 202);
  const other = chat(); other.payload.messages[0].content = 'Different';
  assert.equal((await worker.fetch(call('/ai/jobs', other), env)).status, 409);
  assert.equal((await instances.get('quota').storage.get('visitor:' + await digest('local'))).count, 1);
});
test('accepted slow NVIDIA requests are polled instead of submitted again', async t => {
  const { env, instances } = environment(); const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, method: opts.method || 'GET' });
    assert.equal(opts.headers.Authorization, 'Bearer test-server-secret');
    return calls.length === 1 ? Response.json({ status: 'pending-evaluation', reqId: ID }, { status: 202 }) : Response.json(completion('Slow result completed'));
  });
  await worker.fetch(call('/ai/jobs', chat()), env); await instances.get(ID).alarm();
  assert.equal(calls.length, 2); assert.equal(calls[0].method, 'POST'); assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/' + ID);
  const job = await (await worker.fetch(call('/ai/jobs/' + ID), env)).json();
  assert.equal(job.status, 'done'); assert.equal(job.upstream_id, undefined);
});
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join(''); }
test('NVIDIA 429 is retried with backoff and results cached', async t => {
  const cache = new Map(); const { env, instances } = environment({ RATE_LIMIT: { get: async k => cache.get(k), put: async (k, v) => cache.set(k, JSON.parse(v)) } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '60' } }) : Response.json(completion('Ready')));
  await worker.fetch(call('/ai/jobs', chat()), env); const object = instances.get(ID);
  await object.alarm(); let job = await object.storage.get('job'); assert.equal(job.status, 'queued'); assert.equal(job.attempt, 1);
  assert.ok(object.storage.alarm > Date.now() + 59000); await object.alarm(); assert.equal((await object.storage.get('job')).status, 'done');
  const id2 = crypto.randomUUID(); await worker.fetch(call('/ai/jobs', { ...chat(), request_id: id2 }), env);
  assert.equal((await instances.get(id2).storage.get('job')).cached, true); assert.equal(calls, 2);
});
test('empty chat replies fall back but specialized models never substitute generic chat', async t => {
  const { env, instances } = environment(); const models = [];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { models.push(JSON.parse(opts.body).model); return Response.json(completion(models.length === 1 ? '' : 'Fallback answer')); });
  await worker.fetch(call('/ai/jobs', chat()), env); await instances.get(ID).alarm(); await instances.get(ID).alarm();
  assert.deepEqual(models, ['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3-flash']);
  const body = chat('nvidia/riva-translate-4b-instruct-v2'); body.request_id = crypto.randomUUID();
  t.mock.method(globalThis, 'fetch', async () => new Response('upstream secret must not leak', { status: 404 }));
  await worker.fetch(call('/ai/jobs', body), env); await instances.get(body.request_id).alarm();
  const job = await instances.get(body.request_id).storage.get('job'); assert.equal(job.status, 'error'); assert.match(job.message, /specialized/); assert.doesNotMatch(job.message, /secret/);
});
test('authentication failures are actionable; repeated timeouts stop after three attempts', async t => {
  const { env, instances } = environment();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await worker.fetch(call('/ai/jobs', chat()), env); await instances.get(ID).alarm();
  assert.match((await instances.get(ID).storage.get('job')).message, /authorized inference/);
  const id = crypto.randomUUID(); await worker.fetch(call('/ai/jobs', { ...chat(), request_id: id }), env);
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('slow'), { name: 'AbortError' }); });
  for (let i = 0; i < 3; i++) await instances.get(id).alarm();
  const job = await instances.get(id).storage.get('job'); assert.equal(job.status, 'error'); assert.equal(job.attempt, 3);
});
test('large vision inputs are persisted in bounded chunks', async t => {
  const { env, instances } = environment(); const body = chat('meta/llama-3.2-90b-vision-instruct');
  body.payload.messages[0].content = [{ type: 'text', text: 'Describe four frames.' }, ...Array.from({ length: 4 }, () => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(900000) } }))];
  await worker.fetch(call('/ai/jobs', body), env);
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { assert.equal(JSON.parse(opts.body).messages[0].content.length, 5); return Response.json(completion('Four frames')); });
  await instances.get(ID).alarm(); assert.equal((await instances.get(ID).storage.get('job')).status, 'done');
});
test('global model budget and per-IP admission limits are atomic', async () => {
  const { env, instances } = environment({ AI_RATE_LIMIT_PER_HOUR: '2' });
  const quota = env.AI_JOBS.get('quota');
  for (let i = 0; i < 30; i++) assert.equal((await (await quota.fetch('https://ai.internal/reserve', { method: 'POST', body: '{}' })).json()).wait, 0);
  assert.ok((await (await quota.fetch('https://ai.internal/reserve', { method: 'POST', body: '{}' })).json()).wait > 0);
  for (let i = 0; i < 3; i++) {
    const response = await worker.fetch(call('/ai/jobs', { ...chat(), request_id: crypto.randomUUID() }), env);
    assert.equal(response.status, i < 2 ? 202 : 429);
  }
});
