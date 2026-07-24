#!/usr/bin/env python3
"""Transcribe an audio/video file with NVIDIA Parakeet TDT (via onnx-asr) + Silero VAD.

Writes <name>.txt and <name>.srt into --out-dir. Mirrors the local test notebook:
convert to 16 kHz mono WAV, then VAD-segmented recognition.

Pass EITHER --input (a specific file) OR --input-dir (a folder; the largest media
file in it is used). --input-dir is the robust choice for the pipeline: the
download step drops the file into a folder and this script picks it up, so no
path has to be passed through the shell.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

MEDIA_EXTS = {
    ".m4a", ".mp3", ".wav", ".opus", ".webm", ".aac", ".ogg", ".oga",
    ".flac", ".mp4", ".mkv", ".mov", ".3gp", ".m4b", ".wma",
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def find_media_file(directory: Path) -> Path:
    if not directory.is_dir():
        log(f"ERROR: not a directory: {directory}")
        sys.exit(2)
    candidates = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_EXTS]
    if not candidates:
        log(f"ERROR: no media file found in {directory}")
        sys.exit(2)
    # the real media is the largest file (ignore any small sidecars)
    return max(candidates, key=lambda p: p.stat().st_size)


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
    ap.add_argument("--input", help="path to a specific audio/video file")
    ap.add_argument("--input-dir", dest="input_dir", help="folder to find the media file in")
    ap.add_argument("--out-dir", default="output")
    ap.add_argument("--model", default="nemo-parakeet-tdt-0.6b-v3")
    args = ap.parse_args()

    if args.input:
        src = Path(args.input)
        if not src.is_file():
            log(f"ERROR: input file not found: {src}")
            sys.exit(2)
    elif args.input_dir:
        src = find_media_file(Path(args.input_dir))
    else:
        ap.error("provide --input or --input-dir")

    log(f"Input: {src}")

    # Heavy imports here so --help stays instant and import errors only surface on real work.
    import onnx_asr
    import soundfile as sf

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = src.stem

    wav = str(out / "_audio_16k.wav")
    log("Converting to 16 kHz mono WAV ...")
    to_wav_16k_mono(str(src), wav)

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