"""Local Prompter website, NVIDIA proxy and SAM Audio adapter. No public binding."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SAM_ROOT = Path(os.environ.get('SAM_AUDIO_ROOT', r'S:\Work\Sam Audio 3D')).resolve()
WHISPER_PYTHON = ROOT / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
sys.path.insert(0, str(SAM_ROOT))
DATA = ROOT / 'work' / 'studio'
ID = re.compile(r'^[0-9a-f]{32}$')
CHAT_MODELS = {'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b',
               'nvidia/riva-translate-4b-instruct-v2', 'deepseek-ai/deepseek-v4.1-flash'}
ASR_URL = 'https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions'
JOBS = {}
LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=1)
PIPELINE = None


def load_secrets():
    path = ROOT / 'worker' / '.dev.vars'
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


def media_path(media_id):
    if not isinstance(media_id, str) or not ID.fullmatch(media_id):
        raise ValueError('Choose a local media file first.')
    paths = list((DATA / media_id).glob('input.*'))
    if not paths:
        raise ValueError('This media file is no longer available. Upload it again.')
    return paths[0]


def update(job_id, **values):
    with LOCK:
        JOBS[job_id].update(values)


def process_job(job_id, kind, body):
    global PIPELINE
    directory = DATA / job_id
    directory.mkdir(parents=True, exist_ok=True)
    update(job_id, status='running', message='Preparing your media…', progress=0.01)
    try:
        from sam_audio_studio.runtime import configure_native_libraries
        configure_native_libraries()
        from sam_audio_studio.media import binary, run
        source = media_path(body.get('media_id'))
        if kind == 'sam':
            from sam_audio_studio.config import SeparationOptions, parse_anchors, MODELS
            from sam_audio_studio.pipeline import Pipeline
            model = body.get('model', 'facebook/sam-audio-large')
            if model not in MODELS:
                raise ValueError('Choose an official SAM Audio checkpoint.')
            options = SeparationOptions(
                description=body.get('description', ''), anchors=parse_anchors(body.get('spans', '')),
                model_id=model, precision='auto', candidates=1, steps=int(body.get('steps', 32)),
                chunk_seconds=float(body.get('chunk_seconds', 10)), overlap_seconds=1,
                bbox=tuple(body['bbox']) if body.get('bbox') else None,
                mask_path=str(media_path(body['mask_id'])) if body.get('mask_id') else None,
            )
            if PIPELINE is None:
                PIPELINE = Pipeline(DATA)
            result = PIPELINE.process(source, options, lambda p, msg: update(job_id, progress=p, message=msg))
            files = [result.target, result.residual, result.target_video, result.residual_video, result.archive]
            artifacts = [{'name': p.name, 'url': '/api/files/' + p.relative_to(DATA).as_posix()} for p in files if p]
            update(job_id, files=artifacts)
        elif kind == 'captions':
            from caption import STYLES, validate_srt
            from sam_audio_studio.media import probe
            if not probe(source).has_video:
                raise ValueError('Captioned MP4 export needs a video input.')
            style = body.get('style', 'classic')
            if style not in STYLES:
                raise ValueError('Choose a caption style.')
            (directory / 'captions.srt').write_text(validate_srt(body.get('subtitles', '')), encoding='utf-8')
            update(job_id, message='Rendering subtitles onto your video…', progress=0.2)
            args = [binary('ffmpeg'), '-v', 'error', '-nostdin', '-y', '-i', str(source),
                    '-vf', f"subtitles=captions.srt:force_style='{STYLES[style]}'", '-c:v', 'libx264',
                    '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-movflags', '+faststart', 'captioned.mp4']
            result = subprocess.run(args, cwd=directory, capture_output=True, timeout=18000)
            if result.returncode:
                raise ValueError('Caption rendering failed. Check that your FFmpeg build includes the subtitles filter.')
            update(job_id, files=[{'name': 'captioned.mp4', 'url': f'/api/files/{job_id}/captioned.mp4'}])
        else:
            # ffmpeg extraction stays local; only mono audio is sent to NVIDIA.
            import wave
            audio = directory / 'audio.wav'
            run([binary('ffmpeg'), '-v', 'error', '-nostdin', '-y', '-i', str(source), '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(audio)])
            language = body.get('language', 'en')
            speech_model = body.get('speech_model', 'auto')
            if speech_model not in {'auto', 'parakeet', 'whisper'}:
                raise ValueError('Choose Parakeet, Whisper or Auto.')
            if speech_model == 'parakeet' and language != 'en':
                raise ValueError('Parakeet supports English here. Choose Whisper for this language.')
            use_whisper = speech_model == 'whisper' or language != 'en'
            words, text, segments = [], [], []
            chunk_seconds = 8 if use_whisper else 60
            with wave.open(str(audio), 'rb') as stream:
                duration = stream.getnframes() / 16000
                for index in range(max(1, int((duration + chunk_seconds - 0.001) // chunk_seconds))):
                    offset = index * chunk_seconds
                    frames = stream.readframes(chunk_seconds * 16000)
                    if not frames:
                        break
                    update(job_id, message=f'Transcribing {offset:.0f}–{min(duration, offset + chunk_seconds):.0f}s…', progress=offset / max(duration, 1))
                    if use_whisper:
                        chunk = whisper_chunk(frames, language)
                    else:
                        import io
                        buf = io.BytesIO()
                        with wave.open(buf, 'wb') as wav:
                            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(frames)
                        chunk = asr_chunk(buf.getvalue())
                    text.append(chunk['text'])
                    words.extend({**w, 'start': w['start'] + offset, 'end': w['end'] + offset} for w in chunk['words'])
                    if use_whisper and chunk['text'].strip() and not chunk['words']:
                        segments.append({'start': offset, 'end': min(duration, offset + chunk_seconds), 'text': chunk['text'].strip()})
            update(job_id, text=' '.join(text), words=words, segments=segments, timing_quality='approximate' if segments else 'word')
        update(job_id, status='done', message='Complete.', progress=1)
    except Exception as exc:
        traceback.print_exc()
        # Avoid dumping request bodies or credentials into logs or responses.
        message = str(exc) if isinstance(exc, (ValueError, RuntimeError, ImportError)) else 'The local job failed. Check your media and server terminal.'
        update(job_id, status='error', message=message[:1200])


def nvidia_request(url, data, content_type='application/json', timeout_seconds=240):
    key = os.environ.get('NVIDIA_API_KEY')
    if not key:
        raise ValueError('Set NVIDIA_API_KEY in worker/.dev.vars or your environment, then restart.')
    request = urllib.request.Request(url, data=data, headers={'Authorization': 'Bearer ' + key, 'Content-Type': content_type})
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            with urllib.request.urlopen(request, timeout=max(1, deadline - time.monotonic())) as response:
                value = json.load(response)
                if response.status != 202:
                    return value
                request_id = response.headers.get('nvcf-reqid') or value.get('reqId')
            try:
                uuid.UUID(request_id)
            except (ValueError, TypeError, AttributeError):
                raise ValueError('NVIDIA did not return a valid job ID. Please retry.') from None
            if time.monotonic() + 3 >= deadline:
                raise ValueError('NVIDIA did not finish before the request timed out. Try a shorter input.')
            time.sleep(3)
            request = urllib.request.Request('https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/' + request_id, headers={'Authorization': 'Bearer ' + key})
    except urllib.error.HTTPError as exc:
        raise ValueError(f'NVIDIA returned HTTP {exc.code}. Check model access, quota, and API credentials.') from None
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        raise ValueError('The connection to NVIDIA was interrupted or timed out. Your edits are safe; retry when the service is available.') from None


def asr_chunk(wav):
    boundary = 'Prompter' + uuid.uuid4().hex
    data = (f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen-US\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="word_time_offsets"\r\n\r\nTrue\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + wav + f'\r\n--{boundary}--\r\n'.encode()
    result = nvidia_request(ASR_URL, data, f'multipart/form-data; boundary={boundary}')
    return {'text': result.get('text', ''), 'words': [{'text': w['word'], 'start': w['start'] / 1000, 'end': w['end'] / 1000} for w in result.get('words', [])]}


def whisper_chunk(frames, language):
    if not WHISPER_PYTHON.is_file():
        raise ValueError('Set up the isolated NVIDIA speech client using the README instructions.')
    try:
        result = subprocess.run([str(WHISPER_PYTHON), str(ROOT / 'scripts/whisper.py'), language],
                                input=frames, capture_output=True, timeout=180)
        value = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, ValueError):
        raise ValueError('NVIDIA multilingual speech timed out or returned no result. Try a shorter clip.') from None
    if result.returncode or value.get('error'):
        raise ValueError(value.get('error', 'The NVIDIA speech client could not start.'))
    return value


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'docs'), **kwargs)

    def log_message(self, format, *args):
        # Log paths only, never user query strings or payloads.
        print(f'{self.command} {urllib.parse.urlsplit(self.path).path}', flush=True)

    def trusted(self):
        # The local backend is reachable only from its own served UI.
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        return host == f'127.0.0.1:{self.server.server_port}' and (not origin or origin == f'http://{host}')

    def json(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def speech_proxy(self):
        path = urllib.parse.urlsplit(self.path).path.removeprefix('/api')
        if not re.fullmatch(r'/speech/jobs(?:/[a-f0-9-]{36}(?:/(?:start|chunks/\d+|files/[a-z.]+))?)?', path):
            return self.json({'error': 'Unknown speech route.'}, 404)
        length = int(self.headers.get('Content-Length', 0))
        if length > 2000000:
            return self.json({'error': 'Audio chunk is too large.'}, 413)
        headers = {'Origin': 'https://prompter.neuralforge.tech', 'User-Agent': 'Prompter-Local-Studio/1.0',
                   'Content-Type': self.headers.get('Content-Type', 'application/json')}
        if self.headers.get('Authorization'):
            headers['Authorization'] = self.headers['Authorization']
        request = urllib.request.Request('https://yt-actions-relay.yt-actions-relay.workers.dev' + path,
            data=self.rfile.read(length) if self.command == 'POST' else None, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(); status = response.status; content_type = response.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as error:
            data = error.read(); status = error.code; content_type = 'application/json'
        except (OSError, TimeoutError):
            return self.json({'error': 'Could not connect to the background processor. Retry when your connection is available.'}, 502)
        self.send_response(status); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.trusted():
            return self.json({'error': 'Open the local app using its 127.0.0.1 URL.'}, 403)
        if path.startswith('/api/speech/jobs'):
            return self.speech_proxy()
        if path == '/api/config':
            return self.json({'local': True, 'sam': importlib.util.find_spec('sam_audio') is not None,
                'nvidia': bool(os.environ.get('NVIDIA_API_KEY')), 'multilingual': WHISPER_PYTHON.is_file()})
        if path.startswith('/api/jobs/'):
            with LOCK:
                job = dict(JOBS.get(path.split('/')[-1], {}))
            return self.json(job or {'error': 'Job not found. The server may have restarted.'}, 200 if job else 404)
        if path.startswith('/api/files/'):
            relative = urllib.parse.unquote(path.removeprefix('/api/files/'))
            target = (DATA / relative).resolve()
            if not target.is_relative_to(DATA.resolve()) or not target.is_file():
                return self.json({'error': 'File not found.'}, 404)
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(target)))
            self.send_header('Content-Disposition', 'attachment; filename="' + target.name + '"')
            self.send_header('Content-Length', str(target.stat().st_size))
            self.end_headers()
            with target.open('rb') as stream:
                self.copyfile(stream, self.wfile)
            return
        return super().do_GET()

    def do_POST(self):
        if not self.trusted():
            return self.json({'error': 'Origin not allowed.'}, 403)
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path.startswith('/api/speech/jobs'):
                return self.speech_proxy()
            length = int(self.headers.get('Content-Length', 0))
            if path == '/api/uploads':
                suffix = Path(urllib.parse.unquote(self.headers.get('X-Filename', 'media.mp4'))).suffix.lower()
                if suffix not in {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.png', '.jpg', '.jpeg'}:
                    raise ValueError('Choose a supported video, audio or mask file.')
                if length <= 0 or length > 1024**3:
                    return self.json({'error': 'Choose a media file under 1 GB.'}, 413)
                media_id = uuid.uuid4().hex
                directory = DATA / media_id; directory.mkdir(parents=True)
                with (directory / ('input' + suffix)).open('wb') as stream:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024**2, remaining))
                        if not chunk:
                            raise ValueError('The upload was interrupted. Please try again.')
                        stream.write(chunk); remaining -= len(chunk)
                return self.json({'media_id': media_id})
            if length <= 0 or length > 1000000:
                return self.json({'error': 'Request is empty or too large.'}, 413)
            body = json.loads(self.rfile.read(length))
            if path == '/api/audio':
                from sam_audio_studio.runtime import configure_native_libraries
                configure_native_libraries()
                from sam_audio_studio.media import binary, probe, run
                source = media_path(body.get('media_id'))
                info = probe(source)
                if not info.has_audio or info.duration > 1200:
                    raise ValueError('Choose a recording with audio and a duration of up to 20 minutes.')
                destination = source.parent / 'speech16k.wav'
                run([binary('ffmpeg'), '-v', 'error', '-nostdin', '-y', '-i', str(source), '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(destination)])
                self.send_response(200); self.send_header('Content-Type', 'audio/wav'); self.send_header('Content-Length', str(destination.stat().st_size)); self.end_headers()
                with destination.open('rb') as stream:
                    self.copyfile(stream, self.wfile)
                return
            if path == '/api/chat':
                if body.get('model') not in CHAT_MODELS:
                    raise ValueError('Unsupported model.')
                messages = body.get('messages')
                if not isinstance(messages, list) or not 1 <= len(messages) <= 12 or any(not isinstance(m, dict) or m.get('role') not in {'user', 'system', 'assistant'} or not isinstance(m.get('content'), str) for m in messages):
                    raise ValueError('Invalid messages.')
                payload = {'model': body['model'], 'messages': messages, 'stream': False,
                           'temperature': 0, 'max_tokens': 4096}
                if body['model'].startswith('nvidia/nemotron-3'):
                    payload['chat_template_kwargs'] = {'enable_thinking': False}
                elif body['model']=='deepseek-ai/deepseek-v4.1-flash':
                    payload['chat_template_kwargs'] = {'thinking': False}
                timeout=60 if body['model']=='nvidia/riva-translate-4b-instruct-v2' else 120 if body['model']=='deepseek-ai/deepseek-v4.1-flash' else 240
                return self.json(nvidia_request('https://integrate.api.nvidia.com/v1/chat/completions', json.dumps(payload).encode(), timeout_seconds=timeout))
            if path == '/api/jobs' and body.get('kind') in {'sam', 'captions', 'transcribe'}:
                media_path(body.get('media_id'))
                job_id = uuid.uuid4().hex
                with LOCK:
                    if sum(job['status'] in {'queued', 'running'} for job in JOBS.values()) >= 4:
                        return self.json({'error': 'Four jobs are already queued. Wait for one to finish.'}, 429)
                    JOBS[job_id] = {'job_id': job_id, 'status': 'queued', 'message': 'Waiting for the local processor…', 'progress': 0}
                EXECUTOR.submit(process_job, job_id, body['kind'], body)
                return self.json({'job_id': job_id}, 202)
            return self.json({'error': 'Not found.'}, 404)
        except (ValueError, OSError) as exc:
            return self.json({'error': str(exc)}, 400)
        except Exception:
            return self.json({'error': 'The local request failed. Check NVIDIA access and try again.'}, 502)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    load_secrets(); DATA.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Prompter studio: http://127.0.0.1:{args.port}\nSAM Audio: {SAM_ROOT}\nPress Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
