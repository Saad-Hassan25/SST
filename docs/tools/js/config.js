/* Public model IDs and relay URL. NVIDIA credentials live only in Worker secrets. */
window.PROMPTER_CONFIG = {
  turnstileSiteKey: "0x4AAAAAAD9cl1oEoCuNjr3Y", // Keep in sync with docs/index.html if enabling bot verification.
  proxyUrl: "https://yt-actions-relay.yt-actions-relay.workers.dev/ai",
  models: {
    chat: "nvidia/nemotron-3-super-120b-a12b",
    chatFast: "nvidia/nemotron-3.5-lightning-30b-a3b",
    chatFallbacks: ["z-ai/glm-5.3-flash", "openai/gpt-oss-20b", "moonshotai/kimi-k3", "nvidia/nemotron-3-ultra-550b-a55b"], // gemma-4-31b-it removed: live test timed out (270s, connection closed)
    embed: "nvidia/nemotron-3-embed-1b",
    translate: "nvidia/riva-translate-4b-instruct-v2",
    vision: "meta/llama-3.2-90b-vision-instruct",
    visionFast: "meta/llama-3.2-11b-vision-instruct",
    safety: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
    // Gated / non-chat models (see README) - not callable from this static frontend until approved/deployed:
    tts: "nvidia/magpie-tts-zeroshot",          // Apply for Access
    voicechat: "nvidia/nemotron-voicechat",     // Apply for Early Access
    aiVideoDetector: "nvidia/ai-synthetic-video-detector", // Apply for Access
    bnr: "Background Noise Removal (NIM/NVCF)", // server-side NIM, not integrate chat API
    studioVoice: "Studio Voice (NIM/NVCF)",
    bodyPose: "3D Body Pose (gRPC NVCF)"        // grpc.nvcf.nvidia.com:443, Python client
  },
  // Riva Translate 4B Instruct v2: 37 languages per NVIDIA model card (verify on model page).
  languages: [
    ["auto","Auto-detect"],["en","English"],["ar","Arabic"],["ur","Urdu"],["hi","Hindi"],
    ["es","Spanish (Spain)"],["es-us","Spanish (Latin America)"],["fr","French"],["de","German"],["it","Italian"],["pt","Portuguese (Portugal)"],["pt-br","Portuguese (Brazil)"],
    ["ru","Russian"],["zh","Chinese (Simplified)"],["zh-tw","Chinese (Traditional)"],["ja","Japanese"],["ko","Korean"],
    ["nl","Dutch"],["sv","Swedish"],["da","Danish"],["fi","Finnish"],["no","Norwegian"],
    ["pl","Polish"],["tr","Turkish"],["vi","Vietnamese"],["th","Thai"],["id","Indonesian"],
    ["ms","Malay"],["cs","Czech"],["ro","Romanian"],["uk","Ukrainian"],["el","Greek"],
    ["hu","Hungarian"],["bg","Bulgarian"],["hr","Croatian"],["sk","Slovak"],["sl","Slovenian"],
    ["et","Estonian"],["lv","Latvian"],["lt","Lithuanian"],["fa","Persian"]
  ]
};
