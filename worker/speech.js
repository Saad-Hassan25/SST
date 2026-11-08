// Only the relay holds credentials. Browsers submit short 16 kHz PCM WAV chunks.
const ENDPOINT = 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions';
import { handleWhisper, whisperAvailable } from './whisper.js';
const reply = (value, status = 200) => Response.json(value, { status });
export async function handleSpeech(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/speech/config' && request.method === 'GET')
    return reply({ available: !!(env.NVIDIA_API_KEY && env.AI_JOBS), languages: whisperAvailable(env) ? ['en', 'multilingual'] : ['en'], whisper: whisperAvailable(env), model: 'NVIDIA Parakeet CTC', chunk_seconds: 60 });
  if (path.startsWith('/speech/whisper/')) return handleWhisper(request, env);
  if (!['/speech/transcribe', '/speech/whisper'].includes(path) || request.method !== 'POST') return reply({ error: 'Not found.' }, 404);
  if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return reply({ error: 'Origin not allowed.' }, 403);
  if (!env.NVIDIA_API_KEY || !env.AI_JOBS) return reply({ error: 'Speech service is not configured. Import subtitles or use a public media link.' }, 503);
  if (!request.headers.get('Content-Type')?.startsWith('audio/wav')) return reply({ error: 'Submit a PCM WAV audio chunk.' }, 415);
  if (Number(request.headers.get('Content-Length')) > 2000000) return reply({ error: 'Audio chunks must be under 2 MB.' }, 413);
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (!reader) return reply({ error: 'Missing audio.' }, 400);
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2000000) { await reader.cancel(); return reply({ error: 'Audio chunks must be under 2 MB.' }, 413); }
    chunks.push(value);
  }
  const wav = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
  const view = new DataView(wav.buffer), tag = (a, b) => new TextDecoder().decode(wav.slice(a, b));
  if (size < 44 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WAVE' || tag(12, 16) !== 'fmt ' ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 || view.getUint16(34, true) !== 16)
    return reply({ error: 'Audio must be mono 16-bit PCM WAV at 16 kHz.' }, 400);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') || 'local'));
  const ip = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const quota = env.AI_JOBS.get(env.AI_JOBS.idFromName('quota'));
  const admit = await (await quota.fetch('https://ai.internal/admit', { method: 'POST', body: JSON.stringify({ ip }) })).json();
  if (!admit.allowed) return reply({ error: 'Speech hourly limit reached. Wait before transcribing more audio.' }, 429);
  if (path === '/speech/whisper') return handleWhisper(request, env, wav);
  const reserve = await (await quota.fetch('https://ai.internal/reserve', { method: 'POST', body: '{}' })).json();
  if (reserve.wait) return reply({ error: 'Speech service is busy. Wait a minute, then retry.' }, 429);
  const form = new FormData(); form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.set('language', 'en-US'); form.set('word_time_offsets', 'True');
  try {
    const signal = AbortSignal.timeout(90000), headers = { Authorization: 'Bearer ' + env.NVIDIA_API_KEY };
    let response = await fetch(ENDPOINT, { method: 'POST', headers, body: form, signal });
    while (response.status === 202) {
      const pending = await response.json().catch(() => ({}));
      const id = response.headers.get('nvcf-reqid') || pending.reqId;
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) return reply({ error: 'NVIDIA did not provide a valid speech job ID. Try again.' }, 502);
      await new Promise(resolve => setTimeout(resolve, 3000));
      response = await fetch('https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/' + id, { headers, signal });
    }
    if (!response.ok) return reply({ error: response.status === 429 ? 'NVIDIA speech capacity reached. Try again shortly.' : 'NVIDIA could not transcribe this audio. Try a shorter clip.' }, response.status === 429 ? 429 : 502);
    const result = await response.json();
    return reply({ text: result.text || '', words: (result.words || []).map(w => ({ text: w.word, start: w.start / 1000, end: w.end / 1000 })), model: 'NVIDIA Parakeet CTC' });
  } catch { return reply({ error: 'NVIDIA speech request timed out or lost its connection. Retry the transcription.' }, 504); }
}
