"""Opt-in live model checks using ignored local credentials. Never prints the key."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time
import requests

key = Path("worker/.dev.vars").read_text().split("=", 1)[1].strip().strip('"')
cases = [
    ("summary", "chat/completions", {"model": "nvidia/nemotron-3-super-120b-a12b", "messages": [{"role": "user", "content": "Summarize: Speaker 1: The launch is Friday. Speaker 2: I will prepare the slides."}], "max_tokens": 2048}),
    ("translation", "chat/completions", {"model": "nvidia/riva-translate-4b-instruct-v2", "messages": [{"role": "system", "content": "ar-en"}, {"role": "user", "content": "[0] مرحبا بالعالم [1] هذا اختبار"}], "max_tokens": 2048, "temperature": 0}),
    ("embeddings", "embeddings", {"model": "nvidia/nemotron-3-embed-1b", "input": ["The launch is Friday."], "input_type": "passage", "encoding_format": "float"}),
    ("safety", "chat/completions", {"model": "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "messages": [{"role": "user", "content": "The team is preparing slides for Friday."}], "max_tokens": 1024}),
]


def run(case):
    name, endpoint, payload = case
    started = time.monotonic()
    try:
        response = requests.post("https://integrate.api.nvidia.com/v1/" + endpoint,
                                 headers={"Authorization": "Bearer " + key}, json=payload, timeout=240)
        print(name, "HTTP", response.status_code, "seconds", round(time.monotonic() - started, 1), flush=True)
        if response.ok:
            value = response.json()
            if name == "embeddings":
                print("embeddings dimensions", len(value["data"][0]["embedding"]), flush=True)
            else:
                print(name, "reply:", repr(value["choices"][0]["message"]["content"][:400]), flush=True)
        return response.ok
    except requests.RequestException:
        print(name, "network/timeout failure", flush=True)
        return False


with ThreadPoolExecutor(max_workers=4) as executor:
    outcomes = list(executor.map(run, cases))
raise SystemExit(0 if all(outcomes) else 1)
