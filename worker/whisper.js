// GitHub Actions bridges NVIDIA's gRPC service. Audio stays in private DO storage;
// the dispatch contains only a random job ID, never audio or credentials.
import { writeLarge, readLarge, clearLarge } from './ai.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGES = new Set(['auto','en','ar','ur','hi','es','es-us','fr','de','it','pt','pt-br','ru','zh','zh-tw','ja','ko','nl','sv','da','fi','no','pl','tr','vi','th','id','ms','cs','ro','uk','el','hu','bg','hr','sk','sl','et','lv','lt','fa']);
const reply = (value, status = 200) => Response.json(value, { status });
const ready = env => !!(env.WHISPER_JOBS && env.WHISPER_BRIDGE_KEY && env.GITHUB_TOKEN && env.NVIDIA_API_KEY && env.AI_JOBS);
export const whisperAvailable = ready;

export async function handleWhisper(request, env, audio) {
  if (!ready(env)) return reply({ error: 'Whisper is not configured yet. Choose Parakeet for English.' }, 503);
  const url = new URL(request.url);
  if (url.pathname === '/speech/whisper' && request.method === 'POST') {
    const language = url.searchParams.get('language') || 'auto';
    if (!LANGUAGES.has(language)) return reply({ error: 'Unsupported Whisper language.' }, 400);
    const id = crypto.randomUUID();
    // Encode in bounded pieces to avoid overflowing the JavaScript argument stack.
    let binary = '';
    for (let i = 0; i < audio.length; i += 8192) binary += String.fromCharCode(...audio.subarray(i, i + 8192));
    return env.WHISPER_JOBS.get(env.WHISPER_JOBS.idFromName(id)).fetch('https://whisper.internal/start', {
      method: 'POST', body: JSON.stringify({ id, language, audio: btoa(binary) }) });
  }
  const match = url.pathname.match(/^\/speech\/whisper\/([^/]+)(?:\/(input|result|quota))?$/);
  if (!match || !UUID.test(match[1])) return reply({ error: 'Whisper job not found.' }, 404);
  if (match[2] && request.headers.get('Authorization') !== 'Bearer ' + env.WHISPER_BRIDGE_KEY)
    return reply({ error: 'Bridge authentication required.' }, 403);
  const allowed = match[2] === 'input' ? 'GET' : match[2] ? 'POST' : 'GET';
  if (request.method !== allowed) return reply({ error: 'Method not allowed.' }, 405);
  if (match[2] === 'result' && Number(request.headers.get('Content-Length')) > 1000000) return reply({ error: 'Result is too large.' }, 413);
  return env.WHISPER_JOBS.get(env.WHISPER_JOBS.idFromName(match[1])).fetch(new Request('https://whisper.internal/' + (match[2] || 'status'), {
    method: request.method, ...(request.method === 'POST' ? { body: request.body, duplex: 'half' } : {}) }));
}

export class WhisperJob {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.storage = ctx.storage; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/start') {
      const input = await request.json(), now = Date.now();
      const job = { job_id: input.id, language: input.language, status: 'queued', progress: 0,
        created: now, expires: now + 3600000, message: 'Waiting for a GitHub Actions runner to connect to NVIDIA Whisper…' };
      await this.storage.transaction(async storage => {
        await writeLarge(storage, 'audio', input.audio); await storage.put('job', job); await storage.setAlarm(now + 20 * 60000);
      });
      let response;
      try {
        response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/dispatches`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + this.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Prompter-Whisper', 'X-GitHub-Api-Version': '2022-11-28' },
          body: JSON.stringify({ event_type: 'whisper', client_payload: { job_id: input.id } }), signal: AbortSignal.timeout(20000) });
      } catch { /* The caller may retry later; never silently resubmit an uncertain dispatch. */ }
      if (!response?.ok) {
        const message = response ? `GitHub rejected the Whisper dispatch (HTTP ${response.status}). The site owner needs to check the relay GitHub credentials.` : 'Could not connect to the Whisper runner. Try again later.';
        await this.storage.put('job', { ...job, status: 'error', message });
        await clearLarge(this.storage, 'audio'); return reply({ error: message }, 502);
      }
      return reply({ job_id: input.id, status: 'queued' }, 202);
    }
    const job = await this.storage.get('job');
    if (!job || job.expires < Date.now()) return reply({ error: 'Whisper job expired or was not found.' }, 404);
    if (path === '/status') return reply({ ...job, ...(job.status === 'done' ? await readLarge(this.storage, 'result') : {}) });
    if (path === '/input') {
      if (!['queued', 'running'].includes(job.status)) return reply({ error: 'This job has already finished.' }, 409);
      const audio = await readLarge(this.storage, 'audio');
      if (!audio) return reply({ error: 'Input audio expired.' }, 410);
      await this.storage.put('job', { ...job, status: 'running', message: 'Connected to NVIDIA Whisper. Transcribing audio…' });
      return new Response(Uint8Array.from(atob(audio), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'audio/wav', 'X-Speech-Language': job.language } });
    }
    if (path === '/quota') {
      if (!['queued', 'running'].includes(job.status)) return reply({ error: 'This job has already finished.' }, 409);
      const quota = this.env.AI_JOBS.get(this.env.AI_JOBS.idFromName('quota'));
      return quota.fetch('https://ai.internal/reserve', { method: 'POST', body: '{}' });
    }
    if (path === '/result') {
      if (!['queued', 'running'].includes(job.status)) return reply({ error: 'This job has already finished.' }, 409);
      const raw = await request.text();
      if (raw.length > 1000000) return reply({ error: 'Result is too large.' }, 413);
      let result; try { result = JSON.parse(raw); } catch { return reply({ error: 'Invalid result.' }, 400); }
      if (result.error) {
        await this.storage.put('job', { ...job, status: 'error', message: 'NVIDIA Whisper could not finish. Check the selected language, model access, or API quota and try again.' });
      } else {
        const validCue = cue => cue && typeof cue.text === 'string' && cue.text.length <= 10000 && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.end <= 62;
        if (typeof result.text !== 'string' || result.text.length > 50000 || !Array.isArray(result.segments) || !Array.isArray(result.words) ||
            result.segments.length > 500 || result.words.length > 10000 || !result.segments.every(validCue) || !result.words.every(validCue))
          return reply({ error: 'Invalid Whisper output.' }, 400);
        await writeLarge(this.storage, 'result', { text: result.text, words: result.words, segments: result.segments, timing_quality: result.segments.length ? 'approximate' : 'word', model: 'NVIDIA-hosted Whisper Large v3' });
        await this.storage.put('job', { ...job, status: 'done', progress: 1, message: 'Whisper transcript ready.' });
      }
      await clearLarge(this.storage, 'audio'); await this.storage.setAlarm(job.expires);
      return reply({ ok: true });
    }
    return reply({ error: 'Not found.' }, 404);
  }
  async alarm() {
    const job = await this.storage.get('job');
    if (!job || job.expires <= Date.now()) { await this.storage.deleteAll(); return; }
    if (['queued', 'running'].includes(job.status)) {
      await this.storage.put('job', { ...job, status: 'error', message: 'The Whisper runner did not finish within 20 minutes. Please retry.' });
      await clearLarge(this.storage, 'audio');
    }
    await this.storage.setAlarm(job.expires);
  }
}
