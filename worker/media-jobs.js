// Whole-recording jobs: all audio chunks must be uploaded before dispatch.
// Addresses and upload credentials stay in private storage, separate from status.
import { writeLarge, readLarge, clearLarge } from './ai.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANG = /^(?:auto|[a-z]{2}(?:-[a-z]{2})?)$/;
const FILES = new Set(['transcript.txt','subtitles.srt','subtitles.vtt','translation.txt','translated.srt','translated.vtt']);
const reply = (value, status = 200) => Response.json(value, { status });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function videoLink(value) {
  if (typeof value !== 'string' || value.length>2048) throw fail('Enter a public video link (http or https).');
  let url;try{url=new URL(value);}catch{throw fail('Enter a valid video link.');}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw fail('Use a public http or https video link.');
  if (['youtube.com','youtu.be','youtube-nocookie.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))) throw fail('YouTube is unavailable on the hosted downloader. Upload the video file instead.');
  return url.href;
}
export const mediaJobsAvailable = env => !!(env.MEDIA_JOBS && env.AI_JOBS && env.WHISPER_BRIDGE_KEY && env.GITHUB_TOKEN && env.NVIDIA_API_KEY);

async function boundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw fail('Upload is too large.', 413);
  const reader = request.body?.getReader(); if (!reader) throw fail('Missing request body.');
  const parts = []; let length = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw fail('Upload is too large.', 413); } parts.push(value); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function handleMediaJobs(request, env) {
  if (!mediaJobsAvailable(env)) return reply({ error: 'Background media jobs are not configured yet.' }, 503);
  const path = new URL(request.url).pathname;
  try {
    if (path === '/speech/jobs' && request.method === 'POST') {
      if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) throw fail('Origin not allowed.', 403);
      const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 80000)));
      const email = String(input.email || '').trim();
      if (email && (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) throw fail('Enter a valid email address.');
      const sourceURL=input.source_url?videoLink(input.source_url):null;
      if (!['auto','parakeet','whisper'].includes(input.model) || !LANG.test(input.language || '') || !Number.isInteger(input.chunk_count) || (sourceURL?input.chunk_count!==0:input.chunk_count<1||input.chunk_count>20)) throw fail('Choose a valid model, language and recording up to 20 minutes.');
      if (input.render_video && !sourceURL) throw fail('Automatic video rendering requires a video link.');
      if (sourceURL && input.render_video && !['classic','bold','minimal'].includes(input.caption_style)) throw fail('Choose a caption style.');
      if (input.subtitles && (!sourceURL || typeof input.subtitles!=='string' || new TextEncoder().encode(input.subtitles).length>40000 || !/^\d+\s*\n\d{2,}:\d{2}:\d{2},\d{3} --> \d{2,}:\d{2}:\d{2},\d{3}/m.test(input.subtitles))) throw fail('Provide timed SRT subtitles up to 40 KB.');
      if (input.model === 'parakeet' && input.language !== 'en') throw fail('Parakeet supports English. Choose Whisper for other languages.');
      if (input.translate_to && (!LANG.test(input.translate_to) || input.translate_to === 'auto')) throw fail('Choose a translation language.');
      const quota = env.AI_JOBS.get(env.AI_JOBS.idFromName('quota'));
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') || 'local'));
      const ip = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
      if (!(await (await quota.fetch('https://ai.internal/admit', { method:'POST', body:JSON.stringify({ip}) })).json()).allowed) throw fail('Hourly job limit reached. Try again later.', 429);
      const id = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
      const response = await env.MEDIA_JOBS.get(env.MEDIA_JOBS.idFromName(id)).fetch('https://media.internal/create', { method:'POST', body:JSON.stringify({
        id, token, email, model:input.model, language:input.language, translate_to:input.translate_to || null,
        chunk_count:input.chunk_count, source_url:sourceURL,render_video:!!input.render_video,caption_style:input.caption_style || 'classic',subtitles:input.subtitles || '',name:String(input.name || 'Your recording').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,120)
      }) });
      if (!response.ok) return response;
      return reply({job_id:id, upload_token:token, status:'uploading'}, 201);
    }
    const match = path.match(/^\/speech\/jobs\/([^/]+)(?:\/(chunks\/(\d+)|start|manifest|quota|progress|result|notification|files\/([a-z.]+)))?$/);
    if (!match || !UUID.test(match[1])) return reply({error:'Media job not found.'},404);
    const action = match[2] || 'status', bridge = ['manifest','quota','progress','result','notification'].includes(action) || (action.startsWith('chunks/') && request.method === 'GET');
    if (bridge && request.headers.get('Authorization') !== 'Bearer ' + env.WHISPER_BRIDGE_KEY) throw fail('Runner authentication required.',403);
    if (!bridge && request.method !== 'GET' && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) throw fail('Origin not allowed.',403);
    const validMethod = action === 'status' || action === 'manifest' || action.startsWith('files/') ? 'GET' : action.startsWith('chunks/') ? request.method : 'POST';
    if (request.method !== validMethod || !['GET','POST'].includes(request.method)) throw fail('Method not allowed.',405);
    let bytes;
    if (request.method === 'POST') bytes = await boundedBody(request, action.startsWith('chunks/') ? 2000000 : action === 'result' ? 2000000 : 8000);
    return env.MEDIA_JOBS.get(env.MEDIA_JOBS.idFromName(match[1])).fetch('https://media.internal/' + action, {
      method:request.method, headers:{'X-Upload-Token': !bridge ? request.headers.get('Authorization')?.replace(/^Bearer /,'') || '' : '', 'X-Runner':bridge ? 'yes':'no'}, ...(bytes ? {body:bytes}: {}) });
  } catch (error) { return reply({error:error.status ? error.message : 'The media request was invalid. Please retry.'},error.status || 400); }
}

export class MediaJob {
  constructor(ctx, env) { this.ctx=ctx; this.env=env; this.storage=ctx.storage; }
  async clearAudio(job) { for (let i=0;i<job.chunk_count;i++) await clearLarge(this.storage,'audio'+i); }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if (path === '/create') {
      const input=await request.json(), now=Date.now();
      const job={job_id:input.id, name:input.name, model:input.model, language:input.language, translate_to:input.translate_to,
        chunk_count:input.chunk_count, source_type:input.source_url?'link':'upload',render_video:!!input.render_video,caption_style:input.caption_style || 'classic',uploaded:[], status:'uploading', progress:0, message:input.source_url?'Ready to fetch your public video link.':'Uploading audio. Keep this tab open until the upload finishes.',
        notification:input.email ? 'pending':'none', created:now, expires:now+3*86400000};
      await this.storage.put('private',{email:input.email,token:input.token,source_url:input.source_url || null,subtitles:input.subtitles || ''}); await this.storage.put('job',job); await this.storage.setAlarm(now+30*60000);
      return reply({ok:true});
    }
    let job=await this.storage.get('job');
    if (!job || job.expires < Date.now()) return reply({error:'This recording result expired or was not found.'},404);
    const privateData=await this.storage.get('private');
    if (path === '/status') return reply({...job, ...(job.status === 'done' ? {result:await readLarge(this.storage,'result')}: {})});
    if (path.startsWith('/files/')) {
      const name=path.slice(7); if (job.status !== 'done' || !FILES.has(name)) return reply({error:'File is not ready.'},404);
      const value=await readLarge(this.storage,'result'); if (!value?.files?.[name]) return reply({error:'File not found.'},404);
      return new Response(value.files[name],{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`}});
    }
    if (!privateData) return reply({error:'This job no longer accepts uploads or notifications.'},410);
    if (path.startsWith('/chunks/') && request.method === 'POST') {
      if (request.headers.get('X-Upload-Token') !== privateData.token) return reply({error:'Upload authentication required.'},403);
      return this.ctx.blockConcurrencyWhile(async()=>{
        job=await this.storage.get('job');
        if (job.status !== 'uploading') return reply({error:'This upload is already sealed.'},409);
        const index=Number(path.slice(8)); if (!Number.isInteger(index) || index<0 || index>=job.chunk_count) return reply({error:'Invalid audio chunk.'},400);
        const audio=new Uint8Array(await request.arrayBuffer()), view=new DataView(audio.buffer), tag=(a,b)=>new TextDecoder().decode(audio.slice(a,b));
        if (audio.length<46 || audio.length>2000000 || tag(0,4)!=='RIFF' || tag(8,12)!=='WAVE' || tag(12,16)!=='fmt ' || tag(36,40)!=='data' ||
          view.getUint16(20,true)!==1 || view.getUint16(22,true)!==1 || view.getUint32(24,true)!==16000 || view.getUint16(34,true)!==16 || view.getUint32(40,true)+44!==audio.length || (audio.length-44)/32000>60)
          return reply({error:'Use mono 16 kHz PCM WAV chunks of up to 60 seconds.'},400);
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',audio))].map(b=>b.toString(16).padStart(2,'0')).join('');
        const old=await this.storage.get('hash'+index); if (old && old!==hash) return reply({error:'This chunk already contains different audio.'},409);
        if (!old) {
          let binary=''; for (let i=0;i<audio.length;i+=8192) binary+=String.fromCharCode(...audio.subarray(i,i+8192));
          await writeLarge(this.storage,'audio'+index,btoa(binary)); await this.storage.put('hash'+index,hash);
          job.uploaded.push(index); await this.storage.put('job',job);
        }
        return reply({ok:true,uploaded:job.uploaded.length,total:job.chunk_count});
      });
    }
    if (path === '/start') {
      if (request.headers.get('X-Upload-Token') !== privateData.token) return reply({error:'Upload authentication required.'},403);
      return this.ctx.blockConcurrencyWhile(async()=>{
        job=await this.storage.get('job');
        if (job.status !== 'uploading') return reply({job_id:job.job_id,status:job.status});
        if (job.uploaded.length!==job.chunk_count) return reply({error:'The audio upload is incomplete. Keep the tab open and retry.'},409);
        job={...job,status:'queued',message:job.source_type==='link'?'Video link accepted. Waiting for the downloader; you can close this tab.':'Upload complete. Waiting for a processing runner. You can close this tab.',progress:0};
        await this.storage.put('job',job); await this.storage.setAlarm(Date.now()+45*60000);
        try {
          const response=await fetch(`https://api.github.com/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/dispatches`,{method:'POST',headers:{Authorization:'Bearer '+this.env.GITHUB_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'Prompter-Media','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify({event_type:'uploaded-media',client_payload:{job_id:job.job_id}}),signal:AbortSignal.timeout(20000)});
          if (!response.ok) throw new Error('Dispatch failed');
        } catch {
          await this.storage.put('job',{...job,status:'error',notification:job.notification==='pending'?'failed':'none',message:'Could not start the processor. Your upload will be removed; please retry.'}); await this.clearAudio(job);
          return reply({error:'Could not start the processor. Please retry.'},502);
        }
        return reply({job_id:job.job_id,status:'queued'},202);
      });
    }
    if (request.headers.get('X-Runner')!=='yes') return reply({error:'Runner authentication required.'},403);
    if (path === '/manifest') return reply({...job,email:privateData.email,source_url:privateData.source_url,subtitles:privateData.subtitles});
    if (path.startsWith('/chunks/') && request.method === 'GET') {
      if (!['queued','running'].includes(job.status)) return reply({error:'Input is no longer available.'},410);
      const value=await readLarge(this.storage,'audio'+Number(path.slice(8))); if (!value) return reply({error:'Audio chunk not found.'},404);
      await this.storage.put('job',{...job,status:'running',message:'Connected to NVIDIA. Processing your recording…'});
      return new Response(Uint8Array.from(atob(value),c=>c.charCodeAt(0)),{headers:{'Content-Type':'audio/wav'}});
    }
    if (path === '/quota') return this.env.AI_JOBS.get(this.env.AI_JOBS.idFromName('quota')).fetch('https://ai.internal/reserve',{method:'POST',body:'{}'});
    if (path === '/progress') {
      if (!['queued','running'].includes(job.status)) return reply({error:'Job has finished.'},409);
      const value=await request.json(); if (!Number.isFinite(value.progress) || value.progress<0 || value.progress>1) return reply({error:'Invalid progress.'},400);
      await this.storage.put('job',{...job,status:'running',progress:value.progress,message:String(value.message || 'Processing your recording…').slice(0,160)}); return reply({ok:true});
    }
    if (path === '/result') {
      if (!['queued','running'].includes(job.status)) return reply({error:'Job has finished.'},409);
      const result=await request.json();
      if (result.error) {
        const messages={source_unavailable:'This video could not be downloaded. Check that it is public and accessible; private, login-required or region-blocked videos may be unavailable.',source_limit:'The linked video exceeds the 20-minute or 512 MB limit. Use a shorter video.',processing:'Processing could not finish. Check your media, language and model access, then try again.'};
        await this.storage.put('job',{...job,status:'error',message:messages[result.error_code] || messages.processing});
      }
      else {
        const valid=c=>c && typeof c.text==='string' && c.text.length<=10000 && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start>=0 && c.end>c.start && c.end<=1201;
        if (!Array.isArray(result.cues) || !result.cues.length || result.cues.length>10000 || !result.cues.every(valid) || !Array.isArray(result.translated_cues) || !result.translated_cues.every(valid) ||
          (result.translated_cues.length && (result.translated_cues.length!==result.cues.length || result.translated_cues.some((c,i)=>c.start!==result.cues[i].start || c.end!==result.cues[i].end))) ||
          !result.files || Object.entries(result.files).some(([key,value])=>!FILES.has(key) || typeof value!=='string' || value.length>1000000)) return reply({error:'Invalid recording result.'},400);
        if(result.video_url && result.video_url!==`https://github.com/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/releases/download/job-${job.job_id}/captioned.mp4`)return reply({error:'Invalid video download URL.'},400);
        await writeLarge(this.storage,'result',{cues:result.cues,translated_cues:result.translated_cues,files:result.files,timing_quality:result.timing_quality==='approximate'?'approximate':'word',...(result.video_url?{video_url:result.video_url}: {})});
        await this.storage.put('job',{...job,status:'done',progress:1,message:job.notification==='pending'?'Your files are ready. Sending your email…':'Your transcript and subtitles are ready.'});
      }
      await this.clearAudio(job); await this.storage.setAlarm(job.expires); return reply({ok:true});
    }
    if (path === '/notification') {
      const value=await request.json(); if (!['sent','failed','none'].includes(value.status) || !['done','error'].includes(job.status)) return reply({error:'Invalid notification state.'},400);
      await this.storage.put('job',{...job,notification:value.status,message:job.status==='error'?job.message:value.status==='sent'?'Your files are ready and the result email was sent.':value.status==='failed'?'Your files are ready, but email delivery failed. Download them here.':'Your transcript and subtitles are ready.'});
      await this.storage.put('private',{token:privateData.token,email:''}); return reply({ok:true});
    }
    return reply({error:'Not found.'},404);
  }
  async alarm() {
    const job=await this.storage.get('job'); if (!job || job.expires<=Date.now()) { await this.storage.deleteAll(); return; }
    if (['uploading','queued','running'].includes(job.status)) {
      await this.clearAudio(job); await this.storage.put('job',{...job,status:'error',notification:job.notification==='pending'?'failed':'none',message:'The recording job timed out or its upload was interrupted. Please retry.'}); await this.storage.delete('private');
    }
    await this.storage.setAlarm(job.expires);
  }
}
