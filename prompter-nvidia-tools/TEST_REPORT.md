# TEST REPORT - Prompter NVIDIA Tools (2026-10-04)

## Static / local tests: PASS
- node --check on all 5 JS files: OK.
- node tests/local-test.js: 9 passed, 0 failed (SRT parse, timestamp round-trip, VTT header, Arabic SRT fixture, text-to-cues timing).
- Local http server smoke test: index.html + all CSS/JS/worker assets returned 200.
- Secret scan: no development API key appears anywhere in this package (verified by grep). Keys are never bundled; see README.

## Live NVIDIA API tests: PASS (with a correctly-minted key)
Tested directly against https://integrate.api.nvidia.com/v1 (transient use only; keys stored nowhere).
- GET /models: 200 - 81 models listed.
- Chat nvidia/nemotron-3-super-120b-a12b: 200 - "9.8 is larger than 9.11." (user's own example). NOTE: reasoning models
  return empty content if max_tokens is small (reasoning consumed 46 tokens in that call). App defaults (>=1024) and
  self-test use 1024; nvidia.js also falls through to the next fallback model on empty replies.
- Embeddings nvidia/nemotron-3-embed-1b: 200 - 2048 dims. RAG logic verified: cosine(query "what tip helps beginners
  bake bread?", baking transcript)=0.482 vs (stocks text)=0.031 - relevant passage ranks first.
- Translation nvidia/riva-translate-4b-instruct-v2 Arabic->English: 200 - correct translations, including the
  subtitle-cue batch format ([0]/[1] markers preserved) used by the Video Subtitle Translator.
- Vision meta/llama-3.2-90b-vision-instruct: 200 - answered about a test image.
- Safety nvidia/llama-3.1-nemotron-safety-guard-8b-v3: 200 - {"User Safety": "safe"} for a benign prompt.
- Tool-level: Summary+Chapters on a sample transcript returned a proper summary (200, ~8s).

## Key lesson (important for the owner)
Two earlier keys returned 403 "Authorization failed" on every inference call while GET /models worked (200) -
they could list the catalog but had no inference entitlement. A key generated from a model page's Build tab
(like the working one) succeeds. If a key 403s: regenerate it from the model page, confirm account/phone
verification, apply for gated models (Magpie TTS, Synthetic Video Detector, VoiceChat), or contact
help@build.nvidia.com. The frontend explains this exact 403 to users (js/nvidia.js).

## Full model board (2026-10-04, working key) - every model the code can call
PASS (200, sensible reply): nvidia/nemotron-3-super-120b-a12b, nvidia/nemotron-3-ultra-550b-a55b,
nvidia/nemotron-3.5-lightning-30b-a3b, z-ai/glm-5.3-flash, z-ai/glm-5.3, openai/gpt-oss-20b, moonshotai/kimi-k3,
nvidia/nemotron-3-embed-1b, nvidia/riva-translate-4b-instruct-v2, meta/llama-3.2-90b-vision-instruct,
meta/llama-3.2-11b-vision-instruct, nvidia/llama-3.1-nemotron-safety-guard-8b-v3, nvidia/nemotron-3.5-content-safety.
PARTIAL: google/diffusiongemma-26b-a4b-it returned 200 with empty content (not used as a primary anywhere).
FAIL (do not rely on): google/gemma-4-31b-it (connection closed after 270s - REMOVED from fallback chain),
deepseek-ai/deepseek-v4.1-flash (same 270s closure), meta/llama-guard-4-12b (same), meta/muse-glimmer-30b (500),
poolside/laguna-xs-2.1 + nvidia/nemotron-3-nano-omni-30b-a3b-reasoning (503 ResourceExhausted - capacity, retry later),
nvidia/riva-translate-4b-instruct (base, 404 for this account - code correctly uses v2 only).
Fallback chain is now: nemotron-3-super -> glm-5.3-flash -> gpt-oss-20b -> kimi-k3 -> nemotron-3-ultra (all PASS).
- Gated/server models (Magpie TTS, VoiceChat, AI Video Detector, BNR/Studio Voice, 3D Body Pose): no browser
  endpoint exists until access is approved / a NIM is deployed, by NVIDIA's design. Their panels are
  intentionally gated in the UI with apply links and deployment notes (README).
- Browser CORS from the live Prompter domain was not tested here; the Worker proxy in /worker is the
  production path and removes that variable.
