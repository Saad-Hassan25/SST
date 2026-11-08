/* Static Pages workflow with real browser audio decoding and FFmpeg MP4 export. */
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../docs');
const base = 'http://127.0.0.1:8768';
const server = http.createServer(async (req, res) => {
  let file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, base).pathname));
  if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime }); res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(8768, '127.0.0.1', resolve));
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const jobs = new Map();let background=false,recording,uploads=[],sealed=false,finished=false,holdUpload;
    await context.route('https://fonts.**/**', route => route.abort());
    await context.route('https://yt-actions-relay.yt-actions-relay.workers.dev/**', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.ok(!request.headers().authorization || request.headers().authorization==='Bearer test-upload-token', 'Browser credentials are limited to its own upload token');
      if (url.pathname === '/speech/config') return route.fulfill({ json: { available: true, whisper: true, background } });
      if (url.pathname === '/speech/jobs' && request.method()==='POST') {recording=request.postDataJSON();return route.fulfill({json:{job_id:'23456789-1234-4123-8123-123456789abc',upload_token:'test-upload-token',status:'uploading'}});}
      if (/\/speech\/jobs\/[^/]+\/chunks\/\d+$/.test(url.pathname)) {if(url.pathname.endsWith('/0'))await new Promise(resolve=>{holdUpload=resolve;});uploads.push(Number(url.pathname.split('/').at(-1)));return route.fulfill({json:{ok:true}});}
      if (/\/speech\/jobs\/[^/]+\/start$/.test(url.pathname)) {assert.equal(uploads.length,recording.chunk_count);sealed=true;return route.fulfill({json:{status:'queued'}});}
      if (/\/speech\/jobs\/[^/]+$/.test(url.pathname)) return route.fulfill({json:{job_id:'23456789-1234-4123-8123-123456789abc',status:finished?'done':'queued',notification:finished?'sent':'pending',message:finished?'Your result email was sent.':'Processing continues in the background.',translate_to:'ar',progress:finished?1:0,...(finished?{result:{cues:[{start:0,end:1,text:'Background recording'}],translated_cues:[{start:0,end:1,text:'Translated recording'}],files:{'transcript.txt':'Background recording','translated.srt':'1\n00:00:00,000 --> 00:00:01,000\nTranslated recording'},timing_quality:'word',...(recording?.render_video?{video_url:'https://github.com/Saad-Hassan25/SST/releases/download/job-23456789-1234-4123-8123-123456789abc/captioned.mp4'}:{})}}:{})}});
      if (url.pathname === '/speech/whisper') return route.fulfill({ json: { job_id: '12345678-1234-4123-8123-123456789abc', status: 'queued' } });
      if (url.pathname.startsWith('/speech/whisper/')) return route.fulfill({ json: { status: 'done', text: 'Hello from Whisper.', words: [], segments: [{ start: 0, end: 4, text: 'Hello from Whisper.' }], timing_quality: 'approximate' } });
      if (url.pathname === '/speech/transcribe') {
        assert.equal(request.postDataBuffer().subarray(0, 4).toString(), 'RIFF');
        return route.fulfill({ json: { text: 'Hello everyone. Welcome to Prompter.', words: [{ text: 'Hello', start: 0.16, end: 0.48 }, { text: 'everyone.', start: 0.64, end: 0.96 }, { text: 'Welcome', start: 2, end: 2.2 }, { text: 'to', start: 2.3, end: 2.4 }, { text: 'Prompter.', start: 2.5, end: 3 }] } });
      }
      if (url.pathname === '/ai/jobs' && request.method() === 'POST') { const body = request.postDataJSON(); jobs.set(body.request_id, body); return route.fulfill({ json: { job_id: body.request_id, status: 'done' } }); }
      if (url.pathname.startsWith('/ai/jobs/')) {
        const job = jobs.get(url.pathname.split('/').at(-1));
        assert.equal(job.payload.model, 'nvidia/riva-translate-4b-instruct-v2');
        return route.fulfill({ json: { status: 'done', result: { choices: [{ message: { content: '[0] مرحباً بالجميع. [1] أهلاً بكم في برومبتر.' } }] } } });
      }
      throw new Error('Unexpected network request: ' + url.pathname);
    });
    await page.route('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/**', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      await route.fulfill({ path: path.resolve(__dirname, '../node_modules/@ffmpeg/core/dist/umd', name), contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
    });
    await page.goto(base);
    await expect(page.locator('#transcribe')).toBeEnabled();
    await page.screenshot({ path: '.wrangler/studio-desktop.png', fullPage: true });
    await page.locator('#tab-sam').click(); await expect(page.locator('#sam-unavailable')).toBeVisible(); await expect(page.locator('#separate')).toBeDisabled();
    await page.locator('#tab-transcript').click();
    await page.locator('#media-file').setInputFiles('.wrangler/test-media/studio.mp4');
    await page.locator('#transcribe').click();
    await expect(page.locator('#transcript')).toHaveValue(/00:00:00,160.*\nHello everyone\./s, { timeout: 30000 });
    await expect(page.locator('#cue-count')).toHaveText('2 timed cues');
    await page.locator('#view-cues').click(); await expect(page.locator('.cue-row')).toHaveCount(2);
    await page.locator('.cue-row').nth(1).click(); assert.ok(await page.locator('#preview').evaluate(video => video.currentTime >= 2));
    await page.locator('#preview').evaluate(video => video.pause());
    await page.locator('#tab-translation').click(); await page.locator('#translate-from').selectOption('en'); await page.locator('#translate-to').selectOption('ar');
    await page.locator('#translate').click(); await expect(page.locator('#translated')).toHaveValue(/مرحباً/, { timeout: 15000 });
    await page.locator('#tab-subtitles').click(); await expect(page.locator('#subtitle-track')).toHaveValue('translated');
    await page.locator('#preview').evaluate(video => { video.currentTime = 0.5; }); await expect(page.locator('#caption-overlay')).toContainText('مرحباً');
    await page.locator('#export-srt').click();
    await page.locator('#export-video').click();
    await expect(page.locator('#export-results a')).toBeVisible({ timeout: 180000 });
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export-results a').click();
    const download = await downloadPromise; await download.saveAs('.wrangler/test-media/browser-captioned.mp4');
    assert.ok((await fs.stat('.wrangler/test-media/browser-captioned.mp4')).size > 1000);
    // Whisper is selectable on the static website, including automatic language detection.
    await page.locator('#tab-transcript').click();
    await page.locator('#speech-model').selectOption('whisper'); await page.locator('#source-language').selectOption('auto');
    await page.locator('#transcribe').click(); await expect(page.locator('#transcript')).toHaveValue(/Hello from Whisper/);
    await expect(page.locator('#timing-note')).toContainText('approximate');
    // Changing the source invalidates the stale translated track.
    await page.locator('#tab-transcript').click(); await page.locator('#view-text').click();
    await page.locator('#transcript').fill('1\n00:00:00,000 --> 00:00:01,000\nChanged source');
    await page.locator('#tab-subtitles').click(); await expect(page.locator('#subtitle-track')).toHaveValue('original'); await expect(page.locator('#subtitle-warning')).toContainText('original has changed');
    await page.reload(); await expect(page.locator('#transcript')).toHaveValue(/Changed source/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.wrangler/studio-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page should not overflow');
    assert.deepEqual(errors, []);
    console.log('PASS static studio: audio decode, transcription, timed translation, browser FFmpeg export, draft restore, SAM disabled, mobile layout');
    // Even a static localhost page needs a successful capability response for SAM.
    await page.route('**/api/config', route => route.fulfill({ json: { local: true, sam: true, nvidia: true, multilingual: true } }));
    await page.reload(); await expect(page.locator('#environment')).toContainText('Local studio');
    await page.locator('#tab-sam').click(); await expect(page.locator('#separate')).toBeEnabled();
    await page.route('**/api/uploads', route => route.fulfill({ json: { media_id: 'local-test-source' } }));
    await page.route('**/api/jobs', route => route.fulfill({ json: { job_id: 'local-test-job' } }));
    await page.route('**/api/jobs/local-test-job', route => route.fulfill({ json: { status: 'done', files: [{ name: 'target.mp4', url: '/api/files/test/target.mp4' }] } }));
    await page.route('**/api/files/test/target.mp4', route => route.fulfill({ path: '.wrangler/test-media/studio.mp4', contentType: 'video/mp4' }));
    await page.locator('#media-file').setInputFiles('.wrangler/test-media/studio.mp4');
    await page.locator('#separate').click();
    await page.getByRole('button', { name: 'Use isolated media for transcription' }).click();
    await expect(page.locator('#filename')).toHaveText('target.mp4');
    await expect(page.locator('#tab-transcript')).toHaveAttribute('aria-selected', 'true');
    console.log('PASS local SAM is gated by backend capabilities');
    // Every chunk is acknowledged before email mode says it is safe to close.
    await page.unroute('**/api/config');background=true;await page.goto(base);await expect(page.locator('#transcribe')).toBeEnabled();
    await page.locator('#media-file').setInputFiles('.wrangler/test-media/studio.mp4');
    await page.evaluate(()=>{StudioMedia.audioSamples=async()=>new Float32Array(61*16000);});
    await page.locator('#delivery-email').check();await page.locator('#result-email').fill('invalid');await page.locator('#transcribe').click();
    await expect(page.locator('#activity-message')).toContainText('valid recipient');assert.equal(recording,undefined);
    await page.locator('#result-email').fill('test-recipient@example.com');await page.locator('#job-translate').check();await page.locator('#job-translate-to').selectOption('ar');
    await page.locator('#transcribe').click();await expect(page.locator('#transcribe')).toHaveAttribute('aria-busy','true');
    await expect(page.locator('#recording-job-safe')).toBeHidden();assert.equal(sealed,false);
    await expect.poll(()=>typeof holdUpload).toBe('function');holdUpload();
    await expect(page.locator('#recording-job-safe')).toBeVisible();await expect(page.locator('#transcribe')).toBeEnabled();assert.deepEqual(uploads,[0,1]);assert.equal(recording.email,'test-recipient@example.com');assert.equal(recording.translate_to,'ar');
    const resultURL=await page.locator('#recording-job-link').getAttribute('href');await page.close();finished=true;
    const restored=await context.newPage();await restored.goto(resultURL);await expect(restored.locator('#transcript')).toHaveValue(/Background recording/);await expect(restored.locator('#translated')).toHaveValue(/Translated recording/);await expect(restored.locator('#recording-job-message')).toContainText('email was sent');await expect(restored.locator('#recording-job-files button')).toHaveCount(2);
    console.log('PASS multi-chunk email queue, safe-close gating, invalid email validation, and result recovery after closing the tab');
    // Website video pages are queued server-side; edited captions are sent unchanged.
    recording=undefined;uploads=[];sealed=false;
    await restored.goto(base+'/?source=link');await expect(restored.locator('#transcribe')).toBeEnabled();
    await expect(restored.locator('#video-link-input')).toBeVisible();await expect(restored.locator('#upload-card')).toBeHidden();
    await restored.locator('#video-url').fill('https://youtu.be/blocked');await restored.locator('#transcribe').click();
    await expect(restored.locator('#activity-message')).toContainText('YouTube is unavailable');assert.equal(recording,undefined);
    await restored.locator('#video-url').fill('https://www.facebook.com/watch/?v=123456789');
    await restored.locator('#source-language').selectOption('en');await restored.getByRole('button',{name:'Choose caption style'}).click();await restored.locator('#caption-style').selectOption('bold');await restored.locator('#tab-transcript').click();
    await restored.locator('#transcribe').click();await expect(restored.locator('#transcribe')).toBeEnabled();
    assert.equal(recording.source_url,'https://www.facebook.com/watch/?v=123456789');assert.equal(recording.chunk_count,0);assert.equal(recording.render_video,true);assert.equal(recording.caption_style,'bold');assert.ok(sealed);assert.deepEqual(uploads,[]);
    await expect(restored.locator('#recording-job-files a')).toHaveText(/Download captioned MP4/);
    await expect(restored.locator('#transcript')).toHaveValue(/Background recording/);
    const edited='1\n00:00:00,160 --> 00:00:01,000\nMy edited captions';
    await restored.locator('#transcript').fill(edited);await restored.locator('#tab-subtitles').click();await restored.locator('#subtitle-track').selectOption('original');
    await restored.locator('#export-video').click();await expect(restored.locator('#export-video')).toBeEnabled();
    assert.equal(recording.subtitles.trim(),edited);await expect(restored.locator('#transcript')).toHaveValue(edited);
    await restored.setViewportSize({width:390,height:844});await restored.screenshot({path:'.wrangler/link-source-mobile.png',fullPage:true});assert.ok(await restored.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log('PASS Facebook-style page link input, server-rendered video download, no browser upload, edited subtitle export, and mobile layout');
    await restored.goto(base+'/all-tools.html');await expect(restored.locator('.tool-card')).toHaveCount(18);await restored.locator('#tool-search').fill('email');await expect(restored.locator('.tool-card:not(.hidden)')).toHaveCount(2);
    await restored.locator('#tool-search').fill('');await restored.locator('[data-filter=local]').click();await expect(restored.locator('.tool-card:not(.hidden)')).toHaveCount(1);await expect(restored.locator('.tool-card:not(.hidden)')).toContainText('LOCAL ONLY');
    await restored.locator('[data-filter=all]').click();await restored.setViewportSize({width:390,height:844});await restored.screenshot({path:'.wrangler/catalog-mobile.png',fullPage:true});assert.ok(await restored.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log('PASS searchable tools directory and mobile navigation');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
