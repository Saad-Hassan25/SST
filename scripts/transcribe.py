#!/usr/bin/env python3
"""Transcribe an audio/video file with NVIDIA Parakeet TDT (via onnx-asr) + Silero VAD,
optionally labelling each turn with a speaker (diarization via sherpa-onnx).

Always writes <name>.txt and <name>.srt into --out-dir. With --diarize it *additionally*
writes <name>.diarized.txt and <name>.diarized.srt - the plain transcript is never
replaced, so a diarization failure can't cost you the transcript.

Pass EITHER --input (a specific file) OR --input-dir (a folder; the largest media
file in it is used). --input-dir is the robust choice for the pipeline: the
download step drops the file into a folder and this script picks it up, so no
path has to be passed through the shell.

Diarization mirrors the diarize_test notebook: a pyannote segmentation model plus a
TitaNet speaker-embedding model, both pulled from sherpa-onnx's GitHub releases, so
there's no Hugging Face token and no PyTorch involved.
"""
import argparse
import os
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

MEDIA_EXTS = {
    ".m4a", ".mp3", ".wav", ".opus", ".webm", ".aac", ".ogg", ".oga",
    ".flac", ".mp4", ".mkv", ".mov", ".3gp", ".m4b", ".wma",
}

# sherpa-onnx diarization models. NOTE: "recongition" below is a real typo in the
# upstream release tag - do not "fix" it or the download 404s.
SEG_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMB_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/nemo_en_titanet_small.onnx"
)
SEG_REL = Path("sherpa-onnx-pyannote-segmentation-3-0") / "model.onnx"
EMB_REL = Path("nemo_en_titanet_small.onnx")

MAX_SPEAKERS = 20


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def report_failure(message: str, code: int = 1):
    """Write a user-facing reason to JOB_ERROR_FILE (if set) and exit non-zero, so the
    workflow can surface it instead of a generic 'job failed'."""
    import os
    log("ERROR:", message)
    path = os.environ.get("JOB_ERROR_FILE")
    if path:
        try:
            Path(path).write_text(message.strip() + "\n", encoding="utf-8")
        except OSError:
            pass
    sys.exit(code)


def find_media_file(directory: Path) -> Path:
    if not directory.is_dir():
        log(f"ERROR: not a directory: {directory}")
        sys.exit(2)
    candidates = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_EXTS]
    if not candidates:
        report_failure("No audio could be extracted from that link.", code=2)
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


def write_srt(path: Path, rows):
    """rows: iterable of (start, end, text)."""
    with open(path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(rows, 1):
            f.write(f"{i}\n{fmt_ts(start)} --> {fmt_ts(end)}\n{text}\n\n")


# ---------------------------------------------------------------- diarization

def ensure_diarization_models(models_dir: Path):
    """Download the segmentation + embedding models if absent. ~47 MB total, cached."""
    models_dir.mkdir(parents=True, exist_ok=True)
    seg, emb = models_dir / SEG_REL, models_dir / EMB_REL

    if not seg.exists():
        log("Downloading speaker-segmentation model ...")
        archive = models_dir / "seg.tar.bz2"
        urllib.request.urlretrieve(SEG_URL, archive)
        with tarfile.open(archive, "r:bz2") as t:
            # filter="data" refuses absolute paths and traversal; added in 3.12 and the
            # default from 3.14, so fall back for older local interpreters.
            try:
                t.extractall(models_dir, filter="data")
            except TypeError:
                t.extractall(models_dir)
        archive.unlink(missing_ok=True)

    if not emb.exists():
        log("Downloading speaker-embedding model ...")
        urllib.request.urlretrieve(EMB_URL, emb)

    for p in (seg, emb):
        if not p.exists():
            report_failure(
                "Couldn't fetch the speaker-labelling models. Try again, "
                "or run without 'Label speakers'.", code=3
            )
    return seg, emb


def diarize(wav: str, seg: Path, emb: Path, speakers: int, threads: int, threshold: float):
    """Return (segments sorted by start time, speaker count). speakers<=0 auto-detects."""
    import sherpa_onnx
    import soundfile as sf

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)),
            num_threads=threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=threads),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=(speakers if speakers > 0 else -1),
            threshold=threshold,   # only consulted when num_clusters is -1
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)

    # Loads the whole file into RAM: ~230 MB per hour of 16 kHz mono float32.
    samples, sr = sf.read(wav, dtype="float32")
    if samples.ndim > 1:
        samples = samples[:, 0]
    if sr != diarizer.sample_rate:
        log(f"ERROR: diarizer wants {diarizer.sample_rate} Hz, WAV is {sr} Hz")
        sys.exit(3)

    result = diarizer.process(samples)
    return result.sort_by_start_time(), result.num_speakers


def _overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def speaker_for(start, end, diar_segs):
    """The speaker whose diarized turn overlaps this transcript segment the most."""
    best, best_ov = None, 0.0
    for d in diar_segs:
        ov = _overlap(start, end, d.start, d.end)
        if ov > best_ov:
            best_ov, best = ov, d.speaker
    return best


def label(speaker):
    # Numbers are arbitrary and per-file: diarization says how many and when, not who.
    return f"Speaker {speaker + 1}" if speaker is not None else "Speaker ?"


def merge_turns(segments, diar_segs):
    """Label each transcript segment, then join consecutive same-speaker ones."""
    turns = []
    for s in segments:
        spk = speaker_for(s.start, s.end, diar_segs)
        text = s.text.strip()
        if turns and turns[-1]["spk"] == spk:
            turns[-1]["end"] = s.end
            turns[-1]["text"] = (turns[-1]["text"] + " " + text).strip()
        else:
            turns.append({"spk": spk, "start": s.start, "end": s.end, "text": text})
    return turns


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="path to a specific audio/video file")
    ap.add_argument("--input-dir", dest="input_dir", help="folder to find the media file in")
    ap.add_argument("--out-dir", default="output")
    ap.add_argument("--model", default="nemo-parakeet-tdt-0.6b-v3")
    ap.add_argument("--diarize", action="store_true", help="also label speakers")
    ap.add_argument("--speakers", type=int, default=0,
                    help=f"exact speaker count (1-{MAX_SPEAKERS}); 0 auto-detects")
    ap.add_argument("--models-dir", dest="models_dir", default="models",
                    help="where the diarization models are cached")
    ap.add_argument("--cluster-threshold", dest="cluster_threshold", type=float, default=0.5,
                    help="auto-detect sensitivity; higher merges more speakers")
    ap.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 2))
    args = ap.parse_args()

    if args.speakers < 0 or args.speakers > MAX_SPEAKERS:
        ap.error(f"--speakers must be between 0 and {MAX_SPEAKERS}")

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

    # Fetch the diarization models before the long transcription step, so a bad
    # download fails in seconds instead of an hour from now.
    seg = emb = None
    if args.diarize:
        seg, emb = ensure_diarization_models(Path(args.models_dir))

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

    # Plain transcript first, so it exists on disk before diarization can fail.
    txt = out / f"{stem}.txt"
    txt.write_text(" ".join(s.text.strip() for s in segments), encoding="utf-8")
    write_srt(out / f"{stem}.srt", ((s.start, s.end, s.text.strip()) for s in segments))
    log(f"Wrote: {txt}")
    log(f"Wrote: {out / f'{stem}.srt'}")

    if args.diarize:
        log(f"Diarizing ({args.speakers or 'auto'} speaker(s), {args.threads} threads) ...")
        t0 = time.time()
        diar_segs, found = diarize(
            wav, seg, emb, args.speakers, args.threads, args.cluster_threshold
        )
        log(f"Done: {found} speaker(s), {len(diar_segs)} segments in {time.time() - t0:.1f}s")

        turns = merge_turns(segments, diar_segs)
        log(f"Merged into {len(turns)} turn(s)")

        dtxt = out / f"{stem}.diarized.txt"
        dtxt.write_text(
            "".join(f"{label(t['spk'])}: {t['text']}\n\n" for t in turns), encoding="utf-8"
        )
        write_srt(
            out / f"{stem}.diarized.srt",
            ((t["start"], t["end"], f"{label(t['spk'])}: {t['text']}") for t in turns),
        )
        log(f"Wrote: {dtxt}")
        log(f"Wrote: {out / f'{stem}.diarized.srt'}")

    # Remove the WAV so only .txt/.srt get uploaded to the release.
    Path(wav).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise  # report_failure / argparse already set a reason + exit code
    except Exception as e:  # noqa: BLE001 - surface a clean reason, not a traceback
        first = str(e).strip().splitlines()[0] if str(e).strip() else e.__class__.__name__
        report_failure(f"Couldn't process the audio: {first[:180]}")
