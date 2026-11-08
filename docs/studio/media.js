/* Browser media processing. FFmpeg loads only when extraction/export needs it. */
(function () {
  function wordsToCues(words) {
    const cues = []; let current;
    for (const word of words) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || typeof word.text !== 'string') throw new Error('Speech service returned invalid word timing.');
      if (current && (current.text.length + word.text.length > 70 || word.end - current.start > 5 || word.start - current.end > 0.7)) { cues.push(current); current = null; }
      if (!current) current = { start: word.start, end: Math.max(word.end, word.start + 0.08), text: word.text };
      else { current.text += ' ' + word.text; current.end = Math.max(word.end, current.end); }
      if (/[.!?。؟]$/.test(word.text)) { cues.push(current); current = null; }
    }
    if (current) cues.push(current);
    return cues;
  }
  function wavBlob(samples) {
    const array = new ArrayBuffer(44 + samples.length * 2), view = new DataView(array);
    const string = (position, value) => { for (let i = 0; i < value.length; i++) view.setUint8(position + i, value.charCodeAt(i)); };
    string(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); string(8, 'WAVE'); string(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true); }
    return new Blob([array], { type: 'audio/wav' });
  }
  let ffmpeg, loading;
  async function renderer(onProgress, signal) {
    if (ffmpeg?.loaded) return ffmpeg;
    if (!loading) loading = (async () => {
      onProgress('Loading the browser renderer (~31 MB on first use)…');
      if (!window.FFmpegWASM) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = new URL('vendor/ffmpeg/ffmpeg.js', document.baseURI).href;
        script.onload = resolve; script.onerror = () => reject(new Error('Could not load the video renderer. Check your connection.')); document.head.appendChild(script);
      });
      const urls = [];
      try {
        const fetchBlob = async (url, type) => {
          const response = await fetch(url, { signal }); if (!response.ok) throw new Error('Browser renderer download failed.');
          const blob = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type })); urls.push(blob); return blob;
        };
        const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
        const coreURL = await fetchBlob(base + 'ffmpeg-core.js', 'text/javascript');
        const wasmURL = await fetchBlob(base + 'ffmpeg-core.wasm', 'application/wasm');
        ffmpeg = new window.FFmpegWASM.FFmpeg();
        await ffmpeg.load({ coreURL, wasmURL });
        return ffmpeg;
      } finally { urls.forEach(url => URL.revokeObjectURL(url)); }
    })().catch(error => { loading = null; ffmpeg?.terminate(); ffmpeg = null; throw error; });
    return loading;
  }
  function cancelRenderer() { ffmpeg?.terminate(); ffmpeg = null; loading = null; }
  async function audioSamples(file, onProgress, signal) {
    if (file.size > 250 * 1024 * 1024) throw new Error('For browser transcription choose a file under 250 MB, or use the local launcher for larger media.');
    onProgress('Reading the audio on your device…');
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      let decoded;
      try { decoded = await context.decodeAudioData(await file.arrayBuffer()); }
      catch {
        const ff = await renderer(onProgress, signal);
        const name = 'audio-source.' + (file.name.split('.').pop().replace(/[^a-z0-9]/gi, '') || 'mp4');
        try {
          await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
          const code = await ff.exec(['-i', name, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 'decoded.wav'], 300000);
          if (code !== 0) throw new Error('No readable audio track was found. Try an MP4, MP3 or WAV.');
          const data = await ff.readFile('decoded.wav'); decoded = await context.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        } finally { for (const path of [name, 'decoded.wav']) { try { await ff.deleteFile(path); } catch {} } }
      }
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally { await context.close(); }
  }
  // Noto fonts are OFL licensed. Extra scripts load only when a video export needs them.
  function fontPaths(language, text) {
    const base = 'https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/';
    const paths = [base + 'NotoSans/NotoSans-Regular.ttf'];
    if (/[\u0600-\u08ff]/.test(text)) paths.push(base + 'NotoSansArabic/NotoSansArabic-Regular.ttf');
    if (/[\u0900-\u097f]/.test(text)) paths.push(base + 'NotoSansDevanagari/NotoSansDevanagari-Regular.ttf');
    if (/[\u0980-\u09ff]/.test(text)) paths.push(base + 'NotoSansBengali/NotoSansBengali-Regular.ttf');
    if (/[\u0e00-\u0e7f]/.test(text)) paths.push(base + 'NotoSansThai/NotoSansThai-Regular.ttf');
    if (/[\u0590-\u05ff]/.test(text)) paths.push(base + 'NotoSansHebrew/NotoSansHebrew-Regular.ttf');
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) {
      const locale = language === 'ja' ? 'JP' : language === 'ko' ? 'KR' : language === 'zh-tw' ? 'TC' : 'SC';
      const folder = { JP: 'Japanese', KR: 'Korean', SC: 'SimplifiedChinese', TC: 'TraditionalChinese' }[locale];
      paths.push(`https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/${folder}/NotoSansCJK${locale}-Regular.otf`);
    }
    return paths;
  }
  async function burnVideo(file, subtitles, style, language, onProgress, signal) {
    if (file.size > 250 * 1024 * 1024) throw new Error('Browser video export supports files under 250 MB. Use the local launcher for larger videos.');
    const ff = await renderer(onProgress, signal), files = [], progress = ({ progress }) => onProgress('Rendering captions on your device…', Math.max(0, Math.min(0.99, progress)));
    ff.on('progress', progress);
    const abort = () => cancelRenderer(); signal?.addEventListener('abort', abort, { once: true });
    try {
      onProgress('Preparing subtitle fonts…');
      try { await ff.createDir('/fonts'); } catch {}
      for (const url of fontPaths(language, subtitles)) {
        const path = '/fonts/' + url.split('/').pop();
        const response = await fetch(url, { signal }); if (!response.ok) throw new Error('Could not load subtitle fonts. Check your connection and retry.');
        await ff.writeFile(path, new Uint8Array(await response.arrayBuffer())); files.push(path);
      }
      const input = 'source.' + (file.name.split('.').pop().replace(/[^a-z0-9]/gi, '') || 'mp4'); files.push(input, 'captions.srt', 'captioned.mp4');
      await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));
      // Strip styling controls so caption text cannot override the selected preset.
      const clean = subtitles.replace(/<[^>]*>|\{[^}]*\}/g, '').replace(/\\/g, '');
      await ff.writeFile('captions.srt', new TextEncoder().encode(clean));
      const styles = {
        classic: 'FontName=Noto Sans,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00102030,BorderStyle=1,Outline=2,Shadow=0,MarginV=26',
        bold: 'FontName=Noto Sans,FontSize=26,Bold=1,PrimaryColour=&H0092ABFF,OutlineColour=&H00102030,BorderStyle=1,Outline=3,Shadow=0,MarginV=30',
        minimal: 'FontName=Noto Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=3,Shadow=0,MarginV=24'
      };
      if (!styles[style]) throw new Error('Choose a caption style.');
      onProgress('Rendering subtitles into your video…', 0);
      const code = await ff.exec(['-i', input, '-vf', `subtitles=captions.srt:fontsdir=/fonts:force_style='${styles[style]}'`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-c:a', 'aac', '-movflags', '+faststart', 'captioned.mp4'], 1800000);
      if (code !== 0) throw new Error('Browser video export failed or exceeded 30 minutes. Try a shorter clip or use the local launcher.');
      const output = await ff.readFile('captioned.mp4');
      return new Blob([output], { type: 'video/mp4' });
    } finally {
      signal?.removeEventListener('abort', abort); ff.off('progress', progress);
      if (ff.loaded) for (const file of files) { try { await ff.deleteFile(file); } catch {} }
    }
  }
  const api = { wordsToCues, wavBlob, audioSamples, burnVideo, cancelRenderer };
  if (typeof window !== 'undefined') window.StudioMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
