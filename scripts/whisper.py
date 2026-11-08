"""Isolated Riva client; keeps its protobuf version separate from SAM Audio."""
import json
import os
import sys

import riva.client

auth = riva.client.Auth(uri='grpc.nvcf.nvidia.com:443', use_ssl=True, metadata_args=[
    ['function-id', 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d'],
    ['authorization', 'Bearer ' + os.environ['NVIDIA_API_KEY']]])
config = riva.client.RecognitionConfig(
    encoding=riva.client.AudioEncoding.LINEAR_PCM, sample_rate_hertz=16000,
    language_code='multi' if sys.argv[1] == 'auto' else sys.argv[1].split('-')[0],
    max_alternatives=1, enable_word_time_offsets=True, enable_automatic_punctuation=True)
try:
    result = riva.client.ASRService(auth).offline_recognize(sys.stdin.buffer.read(), config)
    words, texts = [], []
    for item in result.results:
        if item.alternatives:
            alt = item.alternatives[0]
            texts.append(alt.transcript)
            words.extend({'text': w.word, 'start': w.start_time / 1000, 'end': w.end_time / 1000} for w in alt.words)
    print(json.dumps({'text': ' '.join(texts), 'words': words}))
except Exception:
    print(json.dumps({'error': 'NVIDIA Whisper could not process this audio. Check model access, language and API quota.'}))
    sys.exit(1)
