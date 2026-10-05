"""Opt-in smoke against wrangler dev; exercises real Durable Object alarms and NVIDIA."""
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
import requests

BASE = "http://127.0.0.1:8787"
CASES = [
    ("chat", {"model": "nvidia/nemotron-3-super-120b-a12b", "messages": [{"role": "user", "content": "Summarize: The meeting agreed to launch on Friday."}], "max_tokens": 2048}),
    ("embed", {"model": "nvidia/nemotron-3-embed-1b", "input": ["Launch Friday", "Prepare slides"], "input_type": "passage"}),
    ("chat", {"model": "nvidia/riva-translate-4b-instruct-v2", "messages": [{"role": "system", "content": "ar-en"}, {"role": "user", "content": "[0] مرحبا بالعالم [1] هذا اختبار"}], "max_tokens": 2048, "temperature": 0}),
    ("chat", {"model": "nvidia/nemotron-3.5-lightning-30b-a3b", "messages": [{"role": "system", "content": "Return only a JSON array of {id,text}. Preserve all words; insert readable caption line breaks."}, {"role": "user", "content": '[{"id":0,"text":"Speaker 1: We should launch on Friday."}]'}], "max_tokens": 4096, "temperature": 0}),
]


def check(case):
    kind, payload = case
    started = time.monotonic()
    response = requests.post(BASE + "/ai/jobs", json={"request_id": str(uuid.uuid4()), "kind": kind, "payload": payload}, timeout=20)
    response.raise_for_status()
    job_id = response.json()["job_id"]
    while time.monotonic() - started < 300:
        result = requests.get(BASE + "/ai/jobs/" + job_id, timeout=20).json()
        if result.get("status") in {"done", "error"}:
            print(payload["model"], result["status"], "seconds", round(time.monotonic() - started, 1), flush=True)
            if result["status"] == "done":
                data = result["result"]
                print("result:", "vectors=" + str(len(data["data"])) if kind == "embed" else repr(data["choices"][0]["message"]["content"][:300]), flush=True)
            else:
                print(result.get("message"), flush=True)
            return result["status"] == "done"
        time.sleep(2)
    print(payload["model"], "timed out waiting for local alarm", flush=True)
    return False


with ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(check, CASES))
raise SystemExit(0 if all(results) else 1)
