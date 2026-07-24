#!/usr/bin/env python3
"""Transcribe an audio/video file with NVIDIA Parakeet TDT (via onnx-asr) + Silero VAD.

Writes <name>.txt and <name>.srt into --out-dir. This mirrors the local test
notebook: convert to 16 kHz mono WAV, then VAD-segmented recognition.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def to_wav_16k_mono(src: str, dst: str) -> str:
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", "16000", "-ac", "1",
         "-c:a", "pcm_s16le", dst, "-loglevel", "error"],
        check=True,
    )
    return dst


def fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1_000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out-dir", default="output")
    ap.add_argument("--model", default="nemo-parakeet-tdt-0.6b-v3")
    args = ap.parse_args()

    # Imported here so --help stays instant and heavy imports only run for real work.
    import onnx_asr
    import soundfile as sf

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(args.input).stem

    wav = str(out / "_audio_16k.wav")
    log("Converting to 16 kHz mono WAV ...")
    to_wav_16k_mono(args.input, wav)

    info = sf.info(wav)
    dur = info.frames / info.samplerate if info.samplerate else 0.0
    log(f"Audio length: {dur / 60:.1f} min")

    log("Loading Parakeet + Silero VAD ...")
    vad = onnx_asr.load_vad("silero")
    model = onnx_asr.load_model(args.model).with_vad(vad)

    log("Transcribing ...")
    t0 = time.time()
    segments = [s for s in model.recognize(wav) if s.text.strip()]
    elapsed = time.time() - t0
    rtf = elapsed / dur if dur else float("nan")
    log(f"Done: {len(segments)} segments in {elapsed:.1f}s (RTF {rtf:.2f})")

    txt = out / f"{stem}.txt"
    txt.write_text(" ".join(s.text.strip() for s in segments), encoding="utf-8")

    srt = out / f"{stem}.srt"
    with open(srt, "w", encoding="utf-8") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{fmt_ts(s.start)} --> {fmt_ts(s.end)}\n{s.text.strip()}\n\n")

    # Remove the WAV so only .txt/.srt get uploaded to the release.
    Path(wav).unlink(missing_ok=True)
    log(f"Wrote: {txt}")
    log(f"Wrote: {srt}")


if __name__ == "__main__":
    main()
