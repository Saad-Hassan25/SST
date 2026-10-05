# Prompter AI Tools (NVIDIA free endpoints) - Intern Integration Guide

Static HTML/CSS/JS. No build step. Drop the folder into the Prompter site (or link it as /tools/) and it runs.
Styling matches Prompter's live dark theme (bg #080b14, accent #8b7cff / #67e8f9).

## Quick start
1. Serve the folder (any static host / existing Prompter hosting). Open index.html.
2. In **Settings**, paste an NVIDIA `nvapi-` key (free: build.nvidia.com -> any model -> Generate API Key).
   The key is stored ONLY in the visitor's browser localStorage. For production, use the Worker proxy (below) so visitors never need a key.
3. Click **Run self-test** - it checks /models, chat, and embeddings against the live free tier.

## Production (recommended): hide the key
- Deploy `worker/prompter-nvidia-proxy.js` as a Cloudflare Worker (Prompter already uses a Worker relay).
  `wrangler secret put NVIDIA_API_KEY`, then set `proxyUrl` in `js/config.js` to the Worker URL + `/v1`.
- Add your own rate limit / Turnstile in the Worker TODO before public launch (free tier is ~40 RPM and shared).

## Tools and models (verified 2026-10-04, 38 Free Endpoint models of 97)
LIVE from browser (OpenAI-compatible, https://integrate.api.nvidia.com/v1):
- Summary+Chapters, Repurposer, Notes, Clip Finder: nvidia/nemotron-3-super-120b-a12b (+ fallbacks z-ai/glm-5.3-flash, openai/gpt-oss-20b, google/gemma-4-31b-it); clips use nemotron-3.5-lightning-30b-a3b
- Translator + Video Subtitle Translator: nvidia/riva-translate-4b-instruct-v2 (37 languages). Never v1.1 (deprecation-flagged).
- Chat with Video: nvidia/nemotron-3-embed-1b embeddings (query/passage) + chat model for answers.
- Image Describer: meta/llama-3.2-11b-vision-instruct. Video Describer: meta/llama-3.2-90b-vision-instruct (samples 4 frames in-browser).
  Alternative all-in-one (document/image/video/audio, OCR label): nvidia/nemotron-3-nano-omni-30b-a3b-reasoning - swap in js/config.js.
- Safety Check: nvidia/llama-3.1-nemotron-safety-guard-8b-v3 (or nvidia/nemotron-3.5-content-safety).

NEEDS ACTION before they work (built as gated panels on purpose):
- Translated Dubbing: Magpie TTS (nvidia/magpie-tts-zeroshot) - "Apply for Access" on its page. After approval, call its NIM TTS endpoint server-side (not the chat endpoint).
- AI-Video Detector: nvidia/ai-synthetic-video-detector - "Apply for Access".
- Live Voice Assistant: nvidia/nemotron-voicechat - "Apply for Early Access".
- Audio Cleanup (BNR / Studio Voice) and 3D Body Pose: NIM/NVCF services, not browser APIs. Pose uses gRPC (grpc.nvcf.nvidia.com:443, Python client, mp4 H.264 <=50MB) - run it as a GitHub Actions job like Prompter's transcription jobs.

## Video Subtitle Translator (new feature)
Flow: Prompter "Create transcript" on the video (e.g. Arabic speech -> Arabic SRT with timestamps) ->
this tool: load video file/URL + paste SRT -> pick From/To -> subtitles render on the video (CC), download SRT/VTT.
Burned-in version: `ffmpeg -i video.mp4 -vf subtitles=subtitles-translated.srt out.mp4` (or use Prompter's publish-ready subtitles roadmap item).
Plain transcript (no timestamps) also works - cues are auto-generated at ~12 words/4s; timing is approximate.

## Honest limits
- No free NVIDIA ASR: NVIDIA does not replace Prompter's transcription engine; these tools layer on top of transcripts.
- No standalone free OCR/image-generation endpoints; image text extraction here is vision-model based.
- NVIDIA may record inputs/outputs on the trial service; free models can be renamed/deprecated without notice (app auto-falls back across 4 chat models). Re-verify ids on build.nvidia.com before launch.
- Do NOT commit any API key. js/config.js intentionally contains none.

## Tests
- `node tests/local-test.js` - SRT/VTT logic (9 checks).
- Settings -> Run self-test - live key/models test in the browser.
- TEST_REPORT.md - what was verified in this build, including the live-API result for the key used during development.
