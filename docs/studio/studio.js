(async function () {
  const $ = id => document.getElementById(id), cfg = window.PROMPTER_CONFIG, relay = cfg.proxyUrl.replace(/\/ai$/, '');
  const params = new URLSearchParams(location.search);
  let local = false, busy = false, file, mediaURL, mediaID, trackURL, translationSource = '', activeCues = [], controller, timingQuality = 'word', backgroundAvailable = false, uploadingRecording = false, activeRecordingId, appliedRecordingId;
  const safeStorage = { get() { try { return JSON.parse(sessionStorage.getItem('prompter_studio') || 'null'); } catch { return null; } }, set(value) { try { sessionStorage.setItem('prompter_studio', JSON.stringify(value)); } catch {} } };
  function save() { safeStorage.set({ transcript: $('transcript').value, translated: $('translated').value, translationSource, timingQuality, speechModel: $('speech-model').value, sourceLanguage: $('source-language').value, from: $('translate-from').value, to: $('translate-to').value, track: $('subtitle-track').value, style: $('caption-style').value }); }
  function status(title, message, progress, error = false) {
    $('activity-title').textContent = title; $('activity-message').textContent = message;
    $('activity').classList.toggle('error', error);
    $('progress').classList.toggle('hidden', !busy || progress === undefined);
    if (progress !== undefined) $('progress').value = progress;
  }
  function tab(name, focus = false) {
    for (const node of document.querySelectorAll('[role=tab]')) { const selected = node.dataset.tab === name; node.setAttribute('aria-selected', selected); node.tabIndex = selected ? 0 : -1; if (selected && focus) node.focus(); }
    for (const node of document.querySelectorAll('[role=tabpanel]')) node.classList.toggle('hidden', node.id !== 'pane-' + name);
    document.querySelectorAll('.rail-step').forEach(node => node.classList.toggle('current', node.dataset.tab === name));
    if (name === 'subtitles') refreshSubtitles();
  }
  document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () => tab(node.dataset.tab)));
  $('tab-transcript').parentElement.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const tabs = [...document.querySelectorAll('[role=tab]')], index = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tab(tabs[next].dataset.tab, true);
  });
  for (const id of ['translate-from', 'translate-to']) for (const [code, name] of cfg.languages) {
    if (id === 'translate-to' && code === 'auto') continue;
    $(id).append(new Option(name, code, false, code === (id === 'translate-from' ? 'auto' : 'en')));
  }
  for (const [code,name] of cfg.languages) if (code !== 'auto') $('job-translate-to').append(new Option(name,code,false,code==='en'));
  function deliveryChanged() {
    $('recipient-field').classList.toggle('hidden',!$('delivery-email').checked);
    $('job-language-field').classList.toggle('hidden',!$('job-translate').checked);
    $('transcribe').textContent=$('delivery-email').checked?'Upload & email results':'Transcribe media';
  }
  for (const id of ['delivery-wait','delivery-email','job-translate']) $(id).addEventListener('change',deliveryChanged);
  if(params.get('delivery')==='email'){$('delivery-email').checked=true;deliveryChanged();}
  window.addEventListener('beforeunload',event=>{if(uploadingRecording){event.preventDefault();event.returnValue='';}});
  function cues(text) {
    if (!text.trim()) throw new Error('Create or import a transcript first.');
    if (!text.includes('-->')) throw new Error('This transcript has no timing. Transcribe your media or import SRT/VTT before exporting subtitles.');
    const result = SRT.parseSRT(text);
    if (!result.length) throw new Error('No valid timed subtitle cues found.');
    return result;
  }
  const selectedText = () => $('subtitle-track').value === 'translated' ? $('translated').value : $('transcript').value;
  function renderCues() {
    $('cue-list').replaceChildren();
    try {
      for (const cue of cues($('transcript').value)) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'cue-row'; row.dataset.start = cue.start; row.dataset.end = cue.end;
        const time = document.createElement('time'); time.textContent = SRT.secToTs(cue.start).slice(3, 8);
        const text = document.createElement('span'); text.textContent = cue.text; text.dir = 'auto'; row.append(time, text);
        row.addEventListener('click', () => { if (file) { $('preview').currentTime = cue.start; $('preview').play().catch(() => {}); } }); $('cue-list').append(row);
      }
    } catch (error) { $('cue-list').textContent = error.message; }
  }
  function refreshSubtitles() {
    const stale = !!$('translated').value && translationSource !== $('transcript').value;
    $('subtitle-track').options[1].disabled = !$('translated').value.trim() || stale;
    if ($('subtitle-track').value === 'translated' && $('subtitle-track').options[1].disabled) $('subtitle-track').value = 'original';
    $('subtitle-warning').textContent = stale ? 'The original has changed. Translate again before exporting the translated track.' : '';
    const style = $('caption-style').value;
    $('caption-sample').className = 'caption-sample ' + style; $('caption-overlay').className = 'caption-overlay ' + style;
    try { activeCues = cues(selectedText()); } catch { activeCues = []; }
    $('caption-sample').firstElementChild.textContent = activeCues[0]?.text || 'Every word deserves to be seen.';
    const player = $('preview'); player.querySelectorAll('track').forEach(track => track.remove());
    if (trackURL) URL.revokeObjectURL(trackURL);
    if (activeCues.length) {
      trackURL = URL.createObjectURL(new Blob([SRT.toVTT(activeCues)], { type: 'text/vtt' }));
      const track = document.createElement('track'); track.kind = 'subtitles'; track.label = $('subtitle-track').value === 'translated' ? $('translate-to').selectedOptions[0].textContent : 'Original transcript'; track.srclang = $('subtitle-track').value === 'translated' ? $('translate-to').value : $('source-language').value; track.src = trackURL; player.append(track);
    }
    updatePreview();
  }
  function transcriptChanged() {
    let count = 0;
    try { if ($('transcript').value.includes('-->')) count = SRT.parseSRT($('transcript').value).length; } catch {}
    $('cue-count').textContent = count ? `${count} timed cues` : $('transcript').value.trim() ? 'Text transcript' : 'No transcript yet';
    $('timing-note').textContent = count ? timingQuality === 'approximate' ? 'Whisper segment timing is approximate. Review it against the video before export.' : 'Timing is preserved. Edit words directly in the SRT.' : 'Import SRT/VTT or transcribe for accurate timing.';
    refreshSubtitles(); renderCues(); save();
  }
  function updatePreview() {
    const time = $('preview').currentTime, current = activeCues.find(c => time >= c.start && time < c.end);
    $('caption-overlay').textContent = $('show-captions').checked ? current?.text || '' : '';
    $('cue-list').querySelectorAll('.cue-row').forEach(row => row.classList.toggle('playing', time >= Number(row.dataset.start) && time < Number(row.dataset.end)));
  }
  $('preview').addEventListener('timeupdate', updatePreview);
  $('show-captions').addEventListener('change', updatePreview);
  $('transcript').addEventListener('input', transcriptChanged);
  $('translated').addEventListener('input', () => { translationSource = $('transcript').value; refreshSubtitles(); save(); });
  for (const id of ['subtitle-track', 'caption-style', 'translate-from', 'translate-to']) $(id).addEventListener('change', () => { refreshSubtitles(); save(); });
  for (const [id, timed] of [['view-text', false], ['view-cues', true]]) $(id).addEventListener('click', () => {
    $('transcript').classList.toggle('hidden', timed); $('cue-list').classList.toggle('hidden', !timed); $('view-text').classList.toggle('selected', !timed); $('view-cues').classList.toggle('selected', timed); if (timed) renderCues();
  });
  function setMedia(value) {
    if (busy) return;
    const valid = /\.(mp4|mkv|mov|webm|avi|m4v|mp3|wav|flac|ogg|m4a|aac)$/i.test(value.name);
    if (!valid && !/^(audio|video)\//.test(value.type)) return status('Choose a media file.', 'Use a video or audio format such as MP4, MP3 or WAV.', undefined, true);
    if (value.size > (local ? 1024 : 250) * 1024 * 1024) return status('This file is too large.', local ? 'Choose a file under 1 GB.' : 'Choose a file under 250 MB, or use the local launcher.', undefined, true);
    file = value; mediaID = null;
    if (mediaURL) URL.revokeObjectURL(mediaURL); mediaURL = URL.createObjectURL(file);
    $('preview').src = mediaURL; $('filename').textContent = file.name; $('file-meta').textContent = (file.size / 1024**2).toFixed(1) + ' MB';
    $('media-kind').textContent = value.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(value.name) ? 'Audio' : 'Video';
    $('dropzone').classList.add('hidden'); $('media-ready').classList.remove('hidden');
    status('Media ready.', 'Transcribe it, or import subtitles to start editing.'); refreshSubtitles();
  }
  $('media-file').addEventListener('change', event => { if (event.target.files[0]) setMedia(event.target.files[0]); });
  $('replace-media').addEventListener('click', () => $('media-file').click());
  for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('drag-over'); });
  for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); if (type === 'drop' && event.dataTransfer.files[0]) setMedia(event.dataTransfer.files[0]); });
  $('preview').addEventListener('loadedmetadata', () => { $('file-meta').textContent = `${(file.size / 1024**2).toFixed(1)} MB · ${SRT.secToTs($('preview').duration).slice(0, 8)}`; });
  $('preview').addEventListener('error', () => { if (file) status('Preview unavailable for this format.', 'The local processor may still read it. MP4 with H.264/AAC works in most browsers.'); });
  $('import-file').addEventListener('change', async event => {
    const input = event.target.files[0]; if (!input || busy) return;
    try {
      if (input.size > 1024**2) throw new Error('Choose a text or subtitle file under 1 MB.');
      const text = await input.text(); if (text.includes('-->')) cues(text);
      $('transcript').value = text; timingQuality = 'word'; transcriptChanged(); tab('transcript'); status('Transcript imported.', 'Review the text, translate it, or preview its subtitles.');
    } catch (error) { status('Could not import the transcript.', error.message, undefined, true); }
  });
  async function http(path, options = {}) {
    const response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
    let value; try { value = await response.json(); } catch { throw new Error('The service returned an unreadable response. Check the server is running.'); }
    if (!response.ok) throw new Error(value.error || 'The request could not be completed.'); return value;
  }
  async function upload(input = file) {
    if (!input) throw new Error('Choose a video or audio file first.');
    if (input === file && mediaID) return mediaID;
    status('Preparing local media…', 'Copying your file to the local processor.');
    const result = await http('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(input.name) }, body: input });
    if (input === file) mediaID = result.media_id; return result.media_id;
  }
  async function localJob(kind, body) {
    const media_id = await upload();
    const job = await http('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, media_id, kind }) });
    let failures = 0;
    while (true) {
      let result;
      try { result = await http('/api/jobs/' + job.job_id); failures = 0; }
      catch (error) { if (++failures >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
      status('Local processor', result.message, result.progress);
      if (result.status === 'done') return result;
      if (result.status === 'error') throw new Error(result.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const controls = ['transcribe', 'translate', 'export-video', 'separate', 'import-file', 'media-file', 'transcript', 'translated', 'speech-model', 'source-language', 'translate-from', 'translate-to', 'subtitle-track', 'caption-style', 'clear-draft','delivery-wait','delivery-email','result-email','job-translate','job-translate-to'];
  async function operation(title, action, cancellable = false) {
    if (busy) return;
    busy = true; controller = new AbortController(); const old = controls.map(id => $(id).disabled);
    const trigger=document.activeElement?.tagName==='BUTTON'?document.activeElement:null, originalButton=trigger?.innerHTML;
    if(trigger){trigger.setAttribute('aria-busy','true');const spinner=document.createElement('span');spinner.className='spinner';spinner.setAttribute('aria-hidden','true');trigger.replaceChildren(spinner,document.createTextNode(' Working…'));}
    controls.forEach(id => { $(id).disabled = true; }); $('activity').classList.add('busy'); $('cancel-operation').classList.toggle('hidden', !cancellable);
    $('activity').setAttribute('aria-busy','true');
    status(title, 'Preparing…', 0);
    NVIDIA.onProgress = job => status(title, job.message || 'Waiting for the model…');
    try { await action(controller.signal); }
    catch (error) {
      const queuedWhisper = !local && ($('speech-model').value === 'whisper' || $('source-language').value !== 'en');
      status(controller.signal.aborted ? 'Stopped waiting.' : 'Could not finish.', controller.signal.aborted ? queuedWhisper ? 'Queued Whisper work may continue. Retry the same media in this tab to reconnect; your edits are safe.' : 'Your transcript edits are still available.' : error.message, undefined, !controller.signal.aborted);
    }
    finally { busy = false; uploadingRecording=false; controls.forEach((id, i) => { $(id).disabled = old[i]; }); $('activity').classList.remove('busy'); $('activity').setAttribute('aria-busy','false'); if(trigger){trigger.innerHTML=originalButton;trigger.removeAttribute('aria-busy');} $('progress').classList.add('hidden'); $('cancel-operation').classList.add('hidden'); NVIDIA.onProgress = null; save(); }
  }
  $('cancel-operation').addEventListener('click', () => { controller?.abort(); StudioMedia.cancelRenderer(); });
  const speechBase=()=>local?'/api/speech':relay+'/speech';
  const validRecipient=value=>!!value && value.length<=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
  function renderRecordingJob(job) {
    $('recording-job').classList.remove('hidden');
    $('recording-job').classList.toggle('processing',['uploading','queued','running'].includes(job.status)||job.notification==='pending');
    $('recording-job').setAttribute('aria-busy',String(['uploading','queued','running'].includes(job.status)||job.notification==='pending'));
    $('recording-job-title').textContent=job.status==='done'?'Your recording is ready':job.status==='error'?'Recording needs attention':job.status==='uploading'?'Uploading your audio':'Processing in the background';
    $('recording-job-message').textContent=job.message || 'Preparing…'; $('recording-job-progress').value=job.progress || 0;
    $('recording-job-safe').classList.toggle('hidden',!['queued','running','done'].includes(job.status));
    const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('media_job',job.job_id);
    $('recording-job-link').href=url.href;
    $('recording-job-files').replaceChildren();
    if(job.result?.files) for(const name of Object.keys(job.result.files)) {
      const button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent='↓ '+name;
      button.addEventListener('click',()=>PrompterTools.download(job.result.files[name],name));$('recording-job-files').append(button);
    }
  }
  $('copy-recording-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('recording-job-link').href);$('copy-recording-link').textContent='Copied';}catch{$('copy-recording-link').textContent='Copy the saved result URL';}});
  function applyRecording(job) {
    const result=job.result;if(!result)return;
    $('transcript').value=SRT.toSRT(result.cues);timingQuality=result.timing_quality || 'word';
    if(result.translated_cues?.length){$('translated').value=SRT.toSRT(result.translated_cues);translationSource=$('transcript').value;$('translate-to').value=job.translate_to;$('subtitle-track').value='translated';}
    transcriptChanged();appliedRecordingId=job.job_id;
  }
  async function watchRecording(id,{signal,apply=false,sourceFile=file,sourceText=$('transcript').value}={}) {
    activeRecordingId=id; const started=Date.now();let failures=0;
    while(Date.now()-started<46*60000 && activeRecordingId===id){
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      let job;
      try{job=await http(speechBase()+'/jobs/'+id,signal?{signal}:{});failures=0;}
      catch(error){if(signal?.aborted||++failures>=5)throw error;await new Promise(resolve=>setTimeout(resolve,3000));continue;}
      renderRecordingJob(job);
      if(job.status==='done'){
        if(apply && appliedRecordingId!==id && (params.has('media_job') || (file===sourceFile && $('transcript').value===sourceText)))applyRecording(job);
        status('Your recording is ready.',job.message,1);
        if(job.notification!=='pending')return job;
      }
      if(job.status==='error'){status('Could not process the recording.',job.message,undefined,true);return job;}
      if(job.status==='uploading')return job;
      if(busy)status('Background processor',job.message,job.progress);
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
  }
  async function queueRecording(samples,language,speechModel,signal){
    const email=$('delivery-email').checked?$('result-email').value.trim():'';
    if($('delivery-email').checked && !validRecipient(email))throw new Error('Enter a valid recipient email address.');
    if(samples.length>20*60*16000)throw new Error('Background processing supports recordings up to 20 minutes. Split longer recordings into parts.');
    const count=Math.ceil(samples.length/(60*16000));if(!count)throw new Error('No audio was found.');
    const job=await http(speechBase()+'/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:speechModel,language,chunk_count:count,email,name:file.name,translate_to:$('job-translate').checked?$('job-translate-to').value:null}),signal});
    activeRecordingId=job.job_id;uploadingRecording=true;
    try{sessionStorage.setItem('prompter_media_job',job.job_id);}catch{}
    const auth={Authorization:'Bearer '+job.upload_token,'Content-Type':'audio/wav'};
    for(let index=0;index<count;index++){
      renderRecordingJob({...job,status:'uploading',message:`Uploading audio section ${index+1} of ${count}. Keep this tab open.`,progress:index/count});
      await http(speechBase()+'/jobs/'+job.job_id+'/chunks/'+index,{method:'POST',headers:auth,body:StudioMedia.wavBlob(samples.subarray(index*60*16000,(index+1)*60*16000)),signal});
    }
    await http(speechBase()+'/jobs/'+job.job_id+'/start',{method:'POST',headers:{Authorization:auth.Authorization,'Content-Type':'application/json'},body:'{}',signal});
    uploadingRecording=false;
    renderRecordingJob({...job,status:'queued',message:email?'Upload complete. Your transcript and subtitles will be emailed when ready.':'Upload complete. You can wait here or reopen the saved result link.',notification:email?'pending':'none'});
    const watchOptions={apply:true,sourceFile:file,sourceText:$('transcript').value};
    if(email){status('Upload complete. You can close this tab.', 'Processing continues in the background. Your transcript and subtitle files will be emailed when ready.');watchRecording(job.job_id,watchOptions).catch(()=>{$('recording-job-message').textContent='Connection interrupted. Processing continues; use your saved link or wait for the result email.';});}
    else await watchRecording(job.job_id,{...watchOptions,signal});
  }
  async function webWhisper(audio, language, signal) {
    const bytes = new Uint8Array(await audio.arrayBuffer()), lang = new TextEncoder().encode(language), input = new Uint8Array(bytes.length + lang.length);
    input.set(bytes); input.set(lang, bytes.length);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))].map(b => b.toString(16).padStart(2, '0')).join('');
    let saved = {}; try { saved = JSON.parse(sessionStorage.getItem('prompter_whisper_jobs') || '{}'); } catch {}
    for (const [key, value] of Object.entries(saved)) if (Date.now() - value.created > 55 * 60000) delete saved[key];
    const persist = () => { try { sessionStorage.setItem('prompter_whisper_jobs', JSON.stringify(saved)); } catch {} };
    if (!saved[digest]) {
      const result = await http(relay + '/speech/whisper?language=' + encodeURIComponent(language), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal });
      saved[digest] = { id: result.job_id, created: Date.now() }; persist();
    }
    const started = Date.now(); let failures = 0;
    while (Date.now() - started < 21 * 60000) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      let result;
      try { result = await http(relay + '/speech/whisper/' + saved[digest].id, { signal }); failures = 0; }
      catch (error) { if (signal.aborted || ++failures >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
      status('Transcribing with NVIDIA Whisper…', result.message || 'Waiting for the speech runner…');
      if (result.status === 'done') return result;
      if (result.status === 'error') { delete saved[digest]; persist(); throw new Error(result.message); }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error('Whisper is taking longer than expected. Retry with the same media to reconnect to this job.');
  }
  $('transcribe').addEventListener('click', () => operation('Creating your transcript…', async signal => {
    if (!file) throw new Error('Choose a video or audio file first.');
    const language = $('source-language').value, speechModel = $('speech-model').value;
    if (speechModel === 'parakeet' && language !== 'en') throw new Error('Parakeet supports English here. Choose Auto or Whisper for this language.');
    const useWhisper = speechModel === 'whisper' || language !== 'en';
    const emailDelivery=$('delivery-email').checked;
    if(emailDelivery && !validRecipient($('result-email').value.trim()))throw new Error('Enter a valid recipient email address.');
    if((!local && backgroundAvailable) || emailDelivery || $('job-translate').checked){
      if(!local && !backgroundAvailable)throw new Error('Background processing is not available yet. Please retry shortly.');
      if(Number.isFinite($('preview').duration) && $('preview').duration>1200)throw new Error('Background processing supports recordings up to 20 minutes. Split longer recordings into parts.');
      let audioFile=file;
      if(local){
        const id=await upload();status('Preparing your recording…','Extracting audio with local FFmpeg. Your video stays on this machine.');
        const response=await fetch('/api/audio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({media_id:id}),signal});
        if(!response.ok){const value=await response.json();throw new Error(value.error || 'Could not extract audio.');}
        audioFile=new File([await response.blob()],'speech.wav',{type:'audio/wav'});
      }
      const samples=await StudioMedia.audioSamples(audioFile,message=>status('Preparing your recording…',message),signal);
      await queueRecording(samples,language,speechModel,signal);return;
    }
    let result;
    if (local) result = await localJob('transcribe', { language, speech_model: speechModel });
    else {
      const samples = await StudioMedia.audioSamples(file, message => status('Preparing audio…', message), signal), words = [], texts = [], segments = [];
      for (let offset = 0; offset < samples.length; offset += 60 * 16000) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        status('Transcribing with NVIDIA…', `${Math.floor(offset / 16000)}–${Math.min(Math.ceil(samples.length / 16000), offset / 16000 + 60)} seconds. Only audio is sent.`, offset / samples.length);
        const audio = StudioMedia.wavBlob(samples.subarray(offset, offset + 60 * 16000));
        const chunk = useWhisper ? await webWhisper(audio, language, signal) : await http(relay + '/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal });
        texts.push(chunk.text); words.push(...chunk.words.map(word => ({ ...word, start: word.start + offset / 16000, end: word.end + offset / 16000 })));
        segments.push(...(chunk.segments || []).map(cue => ({ ...cue, start: cue.start + offset / 16000, end: cue.end + offset / 16000 })));
      }
      result = { text: texts.join(' '), words, segments, timing_quality: segments.length ? 'approximate' : 'word' };
    }
    if (!result.text?.trim()) throw new Error('No speech was found. Try a clip with clear spoken audio.');
    const timed = [...StudioMedia.wordsToCues(result.words || []), ...(result.segments || [])].sort((a, b) => a.start - b.start);
    timingQuality = result.timing_quality || 'word';
    $('transcript').value = timed.length ? SRT.toSRT(timed.map(c => ({ ...c, text: SRT.wrap(c.text) }))) : result.text;
    transcriptChanged(); status('Your transcript is ready.', timingQuality === 'approximate' ? 'Whisper returned text without word timestamps. Approximate 8-second segment timings are provided; review them before export.' : timed.length ? 'Review the words, then translate or add subtitles.' : 'The service returned text without timing. Import timed subtitles before caption export.');
  }, !local));
  $('translate').addEventListener('click', () => operation('Translating your transcript…', async () => {
    const text = $('transcript').value.trim(); if (!text) throw new Error('Create or import a transcript first.');
    if (text.length > 170000) throw new Error('Split transcripts longer than 170,000 characters into smaller files.');
    const from = $('translate-from').value, to = $('translate-to').value;
    let result;
    if (text.includes('-->')) result = SRT.toSRT(await PrompterTools.translateCues(cues(text), from, to, message => status('Translating…', message)));
    else {
      const pieces = [], translated = []; let remaining = text;
      while (remaining.length > 2000) {
        const space = remaining.lastIndexOf(' ', 2000), end = space > 1000 ? space : 2000;
        pieces.push(remaining.slice(0, end)); remaining = remaining.slice(end);
      }
      if (remaining) pieces.push(remaining);
      for (const piece of pieces) translated.push(await PrompterTools.translateText(piece, from, to));
      result = translated.join('\n');
    }
    $('translated').value = result; translationSource = $('transcript').value; $('subtitle-track').value = 'translated'; refreshSubtitles(); save();
    status('Translation ready.', 'The original remains available. Choose Subtitles to preview or export the translated track.');
  }));
  function exportName(suffix) { return (file?.name.replace(/\.[^.]+$/, '') || 'prompter') + ($('subtitle-track').value === 'translated' ? '-' + $('translate-to').value : '') + suffix; }
  for (const type of ['srt', 'vtt', 'txt']) $('export-' + type).addEventListener('click', () => {
    try {
      const text = selectedText(); if (!text.trim()) throw new Error('Create or import a transcript first.');
      const result = type === 'srt' ? SRT.toSRT(cues(text)) : type === 'vtt' ? SRT.toVTT(cues(text)) : text.includes('-->') ? cues(text).map(c => c.text).join('\n') : text;
      PrompterTools.download(result, exportName('.' + type)); status('Download ready.', 'Your ' + type.toUpperCase() + ' file has been saved.');
    } catch (error) { status('Export needs a transcript.', error.message, undefined, true); }
  });
  function links(id, files) {
    $(id).replaceChildren();
    for (const artifact of files) { const url = new URL(artifact.url, location.href); if (url.origin !== location.origin) continue; const a = document.createElement('a'); a.href = url.href; a.download = artifact.name; a.textContent = '↓ ' + artifact.name; $(id).append(a); }
  }
  let exportURL;
  $('export-video').addEventListener('click', () => operation('Exporting captioned video…', async signal => {
    if (!file || $('media-kind').textContent !== 'Video') throw new Error('Choose a video file before exporting a captioned MP4.');
    const subtitles = SRT.toSRT(cues(selectedText()));
    if (new TextEncoder().encode(subtitles).length > 40000) throw new Error('Caption export supports up to 40 KB of timed subtitles. Split longer projects into sections.');
    if (local) links('export-results', (await localJob('captions', { subtitles, style: $('caption-style').value })).files);
    else {
      const blob = await StudioMedia.burnVideo(file, subtitles, $('caption-style').value, $('subtitle-track').value === 'translated' ? $('translate-to').value : $('source-language').value, (message, progress) => status('Exporting video…', message, progress), signal);
      if (exportURL) URL.revokeObjectURL(exportURL); exportURL = URL.createObjectURL(blob);
      links('export-results', [{ name: exportName('-captioned.mp4'), url: exportURL }]);
    }
    status('Captioned video is ready.', 'Download your MP4 using the link above.');
  }, !local));
  $('sam-visual').addEventListener('change', () => { $('bbox-fields').classList.toggle('hidden', $('sam-visual').value !== 'box'); $('mask-field').classList.toggle('hidden', $('sam-visual').value !== 'mask'); });
  $('separate').addEventListener('click', () => operation('Separating your audio…', async () => {
    if (!local) throw new Error('SAM Audio is available only through the local launcher.');
    const visual = $('sam-visual').value;
    if (visual === 'mask' && !$('sam-mask').files[0]) throw new Error('Choose a mask image or synchronized mask video.');
    const result = await localJob('sam', { description: $('sam-prompt').value, model: $('sam-model').value, steps: Number($('sam-steps').value), chunk_seconds: Number($('sam-chunk').value), spans: $('sam-spans').value,
      ...(visual === 'box' ? { bbox: ['left', 'top', 'right', 'bottom'].map(side => Number($('box-' + side).value)) } : {}), ...(visual === 'mask' ? { mask_id: await upload($('sam-mask').files[0]) } : {}) });
    links('sam-results', result.files);
    const target = result.files.find(item => item.name === 'target.mp4') || result.files.find(item => item.name === 'target.wav');
    if (target) {
      const use = document.createElement('button'); use.type = 'button'; use.className = 'button secondary'; use.textContent = 'Use isolated media for transcription →';
      use.addEventListener('click', async () => {
        if (busy) return; use.disabled = true;
        try {
          const response = await fetch(target.url); if (!response.ok) throw new Error('Could not open the separated media.');
          const blob = await response.blob(); setMedia(new File([blob], target.name, { type: target.name.endsWith('.mp4') ? 'video/mp4' : 'audio/wav' })); tab('transcript');
          status('Isolated media is now your source.', 'Transcribe the separated audio, then translate or add subtitles.');
        } catch (error) { status('Could not use the isolated media.', error.message, undefined, true); }
        finally { use.disabled = false; }
      });
      $('sam-results').append(use);
    }
    status('Your separated sound is ready.', 'Target keeps the sound you described. Residual contains the remaining sounds.');
  }));
  $('clear-draft').addEventListener('click', () => { $('transcript').value = ''; $('translated').value = ''; translationSource = ''; transcriptChanged(); status('Saved draft cleared.', 'Your chosen media is still available.'); });
  const draft = safeStorage.get();
  if (draft) { $('transcript').value = draft.transcript || ''; $('translated').value = draft.translated || ''; translationSource = draft.translationSource || ''; timingQuality = draft.timingQuality || 'word'; $('translate-from').value = draft.from || 'auto'; $('translate-to').value = draft.to || 'en'; $('subtitle-track').value = draft.track || 'original'; $('caption-style').value = draft.style || 'classic'; if (draft.transcript) $('draft-note').textContent = 'Your text draft has been restored. Select the media file again to preview or export video.'; }
  transcriptChanged();
  // A hostname alone does not enable SAM. A same-origin backend capability check must succeed.
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    try {
      const state = await http('/api/config', { signal: AbortSignal.timeout(2500) });
      local = state.local === true; cfg.localBackend = local;
      if (local) {
        $('environment').lastChild.textContent = 'Local studio'; $('sam-controls').disabled = !state.sam; $('sam-unavailable').classList.toggle('hidden', state.sam); $('sam-badge').textContent = state.sam ? 'Ready' : 'Offline';
        $('privacy-note').textContent = 'Media is processed locally. Only transcription audio and translation text go to NVIDIA.';
        $('export-note').textContent = 'Video exports render with your local FFmpeg installation. Your video stays on this machine.';
        $('speech-note').textContent = state.nvidia ? 'English uses Parakeet word timing. Other languages use Whisper with approximate segment timing; review before export.' : 'NVIDIA_API_KEY is missing. Add it to worker/.dev.vars and restart.';
        $('transcribe').disabled = !state.nvidia;
        $('speech-model').options[2].disabled = !state.multilingual;
        if (state.multilingual) for (const [code, name] of cfg.languages) if (code !== 'en') $('source-language').append(new Option(name, code));
      }
    } catch { /* A static localhost preview has no SAM backend. */ }
  }
  if (!local) {
    $('speech-note').textContent = 'Checking NVIDIA speech options…';
    $('speech-model').options[2].disabled = true;
    try {
      const state = await http(relay + '/speech/config');backgroundAvailable=!!state.background;
      $('speech-note').textContent = state.background ? 'NVIDIA processes the complete recording after upload. Choose wait or email delivery below; results are saved for three days. Whisper timing is approximate.' : state.whisper ? 'English defaults to Parakeet word timing. Whisper runs on NVIDIA through a queued runner, with approximate segment timing. Audio is deleted after processing; results expire in one hour.' : 'Parakeet supports English. Import subtitles in any language to translate and export them.';
      $('transcribe').disabled=!state.available;
      if (state.whisper) { $('speech-model').options[2].disabled = false; for (const [code, name] of cfg.languages) if (code !== 'en') $('source-language').append(new Option(name, code)); }
      if (!state.available) { $('transcribe').disabled = true; $('speech-note').textContent = 'Speech service is not configured yet. Import subtitles or use a public media link in the downloader.'; }
    }
    catch { $('transcribe').disabled = true; $('speech-note').textContent = 'Upload transcription needs the updated relay. Import subtitles or use the media downloader in the meantime.'; }
  }
  const savedSpeechModel = [...$('speech-model').options].find(option => option.value === draft?.speechModel);
  if (savedSpeechModel && !savedSpeechModel.disabled) $('speech-model').value = savedSpeechModel.value;
  if (draft?.sourceLanguage && [...$('source-language').options].some(option => option.value === draft.sourceLanguage)) $('source-language').value = draft.sourceLanguage;
  for (const id of ['speech-model', 'source-language']) $(id).addEventListener('change', save);
  const mediaJob=params.get('media_job') || (()=>{try{return sessionStorage.getItem('prompter_media_job');}catch{return null;}})();
  if(mediaJob && /^[0-9a-f-]{36}$/i.test(mediaJob))watchRecording(mediaJob,{apply:params.has('media_job')}).catch(error=>{$('recording-job').classList.remove('hidden');$('recording-job-message').textContent=error.message;});
  // Completed legacy jobs can enter this workspace with timing intact.
  const sourceJob = params.get('source_job');
  if (sourceJob && /^[0-9a-f-]{36}$/i.test(sourceJob)) {
    try { const result = await http(relay + '/status?include_subtitles=1&job_id=' + encodeURIComponent(sourceJob)); if (result.status !== 'done') throw new Error('That job is not complete yet.'); $('transcript').value = result.subtitles || result.transcript || ''; transcriptChanged(); status('Completed transcript imported.', 'Choose a local video to preview these subtitles, or translate the transcript.'); }
    catch (error) { status('Could not load that transcript.', error.message, undefined, true); }
  }
  if (['transcript', 'translation', 'subtitles', 'sam'].includes(location.hash.slice(1))) tab(location.hash.slice(1));
})();
