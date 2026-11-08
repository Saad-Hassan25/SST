"""GitHub Actions gRPC bridge. Never writes audio or transcripts to public assets."""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path


def main():
    job = os.environ['WHISPER_JOB_ID']
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', job, re.I):
        raise ValueError('Invalid job ID.')
    # Fixed trusted destination: repository_dispatch cannot redirect a secret.
    base = 'https://yt-actions-relay.yt-actions-relay.workers.dev/speech/whisper/' + job
    headers = {'Authorization': 'Bearer ' + os.environ['WHISPER_BRIDGE_KEY']}

    def post(path, payload):
        request = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers={**headers, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    try:
        with urllib.request.urlopen(urllib.request.Request(base + '/input', headers=headers), timeout=30) as response:
            audio = response.read(2000001)
            language = response.headers.get('X-Speech-Language', 'auto')
        if len(audio) > 2000000 or not re.fullmatch(r'auto|[a-z]{2}(?:-[a-z]{2})?', language):
            raise ValueError('Invalid bridge audio or language.')
        text, words, segments = [], [], []
        with wave.open(io.BytesIO(audio), 'rb') as stream:
            if stream.getframerate() != 16000 or stream.getnchannels() != 1 or stream.getsampwidth() != 2:
                raise ValueError('Invalid audio format.')
            duration = stream.getnframes() / 16000
            if duration > 61:
                raise ValueError('Audio chunk exceeds 60 seconds.')
            for offset in range(0, max(1, int(duration + 0.999)), 8):
                frames = stream.readframes(8 * 16000)
                if not frames:
                    break
                while True:
                    wait = post('/quota', {}).get('wait', 0)
                    if not wait:
                        break
                    time.sleep(min(60, max(1, wait / 1000)))
                run = subprocess.run([sys.executable, str(Path(__file__).with_name('whisper.py')), language], input=frames, capture_output=True, timeout=180)
                value = json.loads(run.stdout)
                if run.returncode or value.get('error'):
                    raise ValueError('NVIDIA speech request failed.')
                chunk_text = value['text'].strip()
                if not chunk_text:
                    continue
                text.append(chunk_text)
                if value['words']:
                    words.extend({**w, 'start': w['start'] + offset, 'end': w['end'] + offset} for w in value['words'])
                else:
                    segments.append({'start': offset, 'end': min(duration, offset + 8), 'text': chunk_text})
        post('/result', {'text': ' '.join(text), 'words': words, 'segments': segments})
        print('Whisper job complete. Input audio removed from relay storage.')
    except Exception:
        try:
            post('/result', {'error': 'NVIDIA speech request failed.'})
        except Exception:
            pass
        print('Whisper job failed. Review NVIDIA model access and runner availability.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
