/* Browser regression checks with a deterministic relay, plus optional --live alarm check. */
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../docs');
const srt = '1\n00:00:01,000 --> 00:00:04,000\nSpeaker 1: مرحبا بالعالم\n\n2\n00:00:05,000 --> 00:00:08,000\nSpeaker 2: هذا اختبار\n';
const ID = '12345678-1234-4123-8123-123456789abc';
const completion = text => ({ choices: [{ message: { content: text } }] });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime }); res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(8765, '127.0.0.1', resolve));
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.route('https://fonts.**/**', route => route.abort());
    // Exercise the real app's verification wiring without contacting Turnstile.
    // Blocking api.js makes exports fail as soon as a production site key is set.
    const verificationToken = 'browser-test-turnstile-token';
    await context.route('https://challenges.cloudflare.com/**', route => {
      const onload = new URL(route.request().url()).searchParams.get('onload');
      return route.fulfill({ contentType: 'text/javascript', body: `
        (() => {
          const widgets = new Map();
          const state = window.__testTurnstile = { rendered: [], executions: 0, resets: 0, failNext: false };
          window.turnstile = {
            render(container, options) {
              if (!document.querySelector(container)) throw new Error('Missing Turnstile container');
              const id = 'test-widget-' + widgets.size;
              widgets.set(id, options);
              state.rendered.push({ container, sitekey: options.sitekey });
              return id;
            },
            execute(id) {
              const options = widgets.get(id);
              if (!options) throw new Error('Unknown Turnstile widget');
              state.executions++;
              queueMicrotask(() => {
                if (state.failNext) { state.failNext = false; options['error-callback'](); }
                else options.callback(${JSON.stringify(verificationToken)});
              });
            },
            reset(id) {
              if (!widgets.has(id)) throw new Error('Unknown Turnstile widget reset');
              state.resets++;
            }
          };
          const initialize = () => window[${JSON.stringify(onload)}]?.();
          if (typeof window[${JSON.stringify(onload)}] === 'function') initialize();
          else window.addEventListener('load', initialize, { once: true });
        })();
      ` });
    });
    const jobs = new Map(), submissions = []; let hold = false, omitCue = false, lastTrigger;
    const resultFor = ({ kind, payload }) => {
      if (kind === 'embed') return { data: payload.input.map((_t, i) => ({ index: i, embedding: [1, 0.5] })) };
      const prompt = typeof payload.messages[0].content === 'string' ? payload.messages[0].content : '';
      const last = payload.messages.at(-1).content;
      if (payload.model.includes('riva-translate') || prompt.startsWith('Translate ')) {
        const matches = [...last.matchAll(/\[(\d+)\]/g)];
        return completion(matches.length ? matches.filter((_v, i) => !omitCue || i === 0).map(m => `[${m[1]}] ${m[1] === '0' ? 'Hello world' : 'This is a test'}`).join(' ') : 'Translated text');
      }
      if (prompt.startsWith('Re-segment')) return completion(JSON.stringify(JSON.parse(last)));
      if (prompt.includes('Return valid JSON')) return completion('{"decisions":["Launch Friday"],"action_items":[],"open_questions":[],"quotes":[]}');
      if (payload.model.includes('safety')) return completion('{"User Safety":"safe"}');
      if (payload.model.includes('vision')) return completion('A colorful scene with text. Frame at 00:00:00.100.');
      if (prompt.startsWith('Answer only')) return completion('They explained pricing [Passage 1] at 00:00:01.000.');
      if (prompt.startsWith('Rank five')) return completion('Candidate at 00:00:01.000: A strong hook.');
      return completion('Summary: Launch Friday. <img src=x onerror=alert(1)>');
    };
    await context.route('https://yt-actions-relay.yt-actions-relay.workers.dev/**', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.ok(!request.headers().authorization, 'browser must never supply NVIDIA credentials');
      if (url.pathname === '/ai/config') return route.fulfill({ json: { available: true } });
      if (url.pathname === '/ai/jobs' && request.method() === 'POST') {
        const body = request.postDataJSON(); jobs.set(body.request_id, body); submissions.push(body);
        return route.fulfill({ status: 202, json: { job_id: body.request_id, status: 'queued' } });
      }
      if (url.pathname.startsWith('/ai/jobs/')) {
        const id = url.pathname.split('/').at(-1), job = jobs.get(id);
        return route.fulfill({ json: { job_id: id, status: hold ? 'running' : 'done', message: hold ? 'Model is still working.' : 'Result ready.', ...(hold ? {} : { result: resultFor(job) }) } });
      }
      if (url.pathname === '/status') return route.fulfill({ json: { status: 'done', mode: 'transcribe', transcript: 'Speaker 1: Hello world', subtitles: srt,
        files: [{ name: 'video.diarized.txt', url: 'https://asset.test/text', size: 40 }, { name: 'video.diarized.srt', url: 'https://asset.test/srt', size: 100 }] } });
      if (url.pathname === '/trigger') { lastTrigger = request.postDataJSON(); return route.fulfill({ json: { job_id: ID, mode: lastTrigger.mode } }); }
      throw new Error('Unexpected relay request: ' + url.pathname);
    });
    await page.goto('http://127.0.0.1:8765/');
    await expect(page.locator('#submit')).toHaveText('Download video');
    await page.locator('#mode-transcribe').click();
    await expect(page.locator('#submit')).toHaveText('Get transcript');
    await page.locator('#diarize').check(); await expect(page.locator('#speakers-field')).toBeVisible();
    console.log('PASS existing download/transcription controls');
    await page.goto('http://127.0.0.1:8765/?job=' + ID);
    await expect(page.getByText('Speaker-labelled transcript ready')).toBeVisible();
    await page.getByRole('link', { name: 'Use transcript in AI Tools' }).click();
    await expect(page.locator('#sum-input')).toHaveValue(srt);
    await expect(page.locator('#api-key')).toHaveCount(0);
    console.log('PASS completed transcript handoff and server-only credentials');
    await page.locator('#summary .submit').click(); await expect(page.locator('#sum-output')).toContainText('Launch Friday');
    await expect(page.locator('#sum-output img')).toHaveCount(0);
    console.log('PASS summaries and safe model-output rendering');
    await page.locator('#tr-from').selectOption('ar'); await page.locator('#translate .submit').click();
    await expect(page.locator('#tr-output')).toContainText('Speaker 2: This is a test');
    await expect(page.locator('#tr-output')).toContainText('00:00:05,000 --> 00:00:08,000');
    const downloaded = page.waitForEvent('download'); await page.locator('#tr-output + .output-actions').getByRole('button', { name: 'Download text' }).click();
    assert.ok((await downloaded).suggestedFilename().endsWith('.srt'));
    console.log('PASS translated timings, speaker labels and SRT export');
    omitCue = true; await page.locator('#vs-from').selectOption('ar');
    await page.locator('#video-subtitles .submit').click();
    await expect(page.locator('#video-subtitles .job-status')).toContainText('omitted a cue');
    await expect(page.locator('#vs-downloads')).toBeHidden(); omitCue = false;
    await page.locator('#video-subtitles .submit').click(); await expect(page.locator('#vs-output')).toContainText('2 cues translated');
    assert.equal(submissions.at(-1).refresh, true, 'invalid cached translations need a fresh model result');
    await expect(page.locator('#vs-video track')).toHaveCount(1);
    console.log('PASS subtitle translation completeness checks and video caption track');
    await page.locator('#chat .submit').click(); await expect(page.locator('#chat-q-row')).toBeVisible();
    await page.locator('#chat-q').fill('What about pricing?'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('#chat-output')).toContainText('[Passage 1]');
    await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(page.locator('#chat-output')).toContainText('similarity');
    console.log('PASS semantic indexing, chat citations and retrieval');
    await page.locator('#repurpose .submit').click(); await expect(page.locator('#rep-output')).toContainText('Launch Friday');
    await page.locator('#notes .submit').click(); await expect(page.locator('#notes-output')).toContainText('action_items');
    await page.locator('#smart-subtitles .submit').click(); await expect(page.locator('#ss-output')).toContainText('Cue boundaries preserved');
    await expect(page.locator('#ss-downloads')).toBeVisible();
    await page.locator('#clips .submit').click(); await expect(page.locator('#clips-output')).toContainText('Candidate');
    await page.locator('#safety .submit').click(); await expect(page.locator('#safe-output')).toContainText('safe');
    console.log('PASS repurposing, structured notes, smart subtitles, clips and safety');
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1600; c.getContext('2d').fillRect(0, 0, 1600, 1600); return c.toDataURL().split(',')[1]; });
    await page.locator('#img-file').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.locator('#image-describer .submit').click(); await expect(page.locator('#img-output')).toContainText('colorful');
    assert.ok(submissions.at(-1).payload.messages[0].content[1].image_url.url.length < 1500000);
    await page.locator('#vid-file').setInputFiles(path.resolve('.wrangler/test-media/sample.mp4'));
    await page.locator('#video-describer .submit').click(); await expect(page.locator('#vid-output')).toContainText('Frame');
    assert.equal(submissions.at(-1).payload.messages[0].content.filter(p => p.type === 'image_url').length, 4);
    console.log('PASS resized image descriptions and bounded four-frame video sampling');
    await page.locator('#burn-url').fill('https://media.test/video.mp4');
    const verificationEnabled = await page.evaluate(() => !!window.PROMPTER_CONFIG.turnstileSiteKey);
    if (verificationEnabled) {
      await expect.poll(() => page.evaluate(() => window.__testTurnstile?.rendered.some(w => w.container === '#caption-ts'))).toBe(true);
      await page.evaluate(() => { window.__testTurnstile.failNext = true; });
      await page.locator('#burn-in .submit').click();
      await expect(page.locator('#burn-in .job-status')).toContainText('Verification failed');
      assert.equal(lastTrigger, undefined, 'failed verification must not dispatch a caption job');
      await expect(page.locator('#burn-in .submit')).toBeEnabled();
      assert.equal(await page.evaluate(() => window.__testTurnstile.executions), 1);
      console.log('PASS failed caption verification prevents job dispatch and allows retry');
    }
    await page.locator('#burn-in .submit').click();
    await expect(page.getByRole('link', { name: 'Open video export' })).toBeVisible();
    assert.equal(lastTrigger.mode, 'captions'); assert.equal(lastTrigger.caption_style, 'classic');
    assert.equal(lastTrigger.turnstileToken, verificationEnabled ? verificationToken : '');
    if (verificationEnabled) {
      assert.equal(await page.evaluate(() => window.__testTurnstile.executions), 2);
      assert.equal(await page.evaluate(() => window.__testTurnstile.resets), 1, 'used verification token must be reset after dispatch');
    }
    console.log('PASS styled caption export dispatch');
    await page.locator('#sum-input').fill('A new meeting launches on Monday.'); hold = true;
    await page.locator('#summary .submit').click(); await expect(page.locator('#summary .job-status')).toContainText('still working');
    const count = submissions.length;
    await page.reload(); hold = false; await expect(page.locator('#resume-row')).toBeVisible();
    await page.locator('#resume-operation').click(); await expect(page.locator('#sum-output')).toContainText('Launch Friday');
    assert.equal(submissions.length, count, 'refresh must resume the same model job');
    console.log('PASS slow-job refresh recovery without duplicate submissions');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/tools-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('http://127.0.0.1:8765/tools/');
    await page.screenshot({ path: 'test-results/tools-desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS desktop/mobile layout and zero browser script errors');
    if (process.argv.includes('--live')) {
      await context.unroute('https://yt-actions-relay.yt-actions-relay.workers.dev/**');
      await context.route('https://yt-actions-relay.yt-actions-relay.workers.dev/**', async route => {
        const response = await route.fetch({ url: route.request().url().replace('https://yt-actions-relay.yt-actions-relay.workers.dev', 'http://127.0.0.1:8787') });
        await route.fulfill({ response });
      });
      await page.goto('http://127.0.0.1:8765/tools/');
      await page.locator('#sum-input').fill('Speaker 1: We agreed to launch Friday. Speaker 2: I will prepare the slides.');
      await page.locator('#summary .submit').click(); await expect(page.locator('#sum-output')).not.toBeEmpty({ timeout: 300000 });
      await expect(page.locator('#summary .job-status')).not.toContainText('error');
      console.log('PASS real browser → Worker → durable alarm → NVIDIA → browser');
      await page.locator('#ss-input').fill('1\n00:00:00,000 --> 00:00:04,000\nSpeaker 1: We should launch on Friday.');
      await page.locator('#smart-subtitles .submit').click();
      await expect(page.locator('#smart-subtitles .submit')).toBeEnabled({ timeout: 300000 });
      assert.ok((await page.locator('#ss-output').textContent()).includes('Cue boundaries preserved'), await page.locator('#smart-subtitles .job-status').textContent());
      await expect(page.locator('#ss-downloads')).toBeVisible();
      console.log('PASS real AI subtitle re-segmentation with original words and timing');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
