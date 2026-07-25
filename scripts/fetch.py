#!/usr/bin/env python3
"""Download a video (at a quality preset) or its audio, using yt-dlp.

Prints ONLY the final file path to stdout; all human-readable logs go to stderr.
The path on stdout is for local/manual runs. Do NOT capture it in the workflow with
`AUDIO=$(python fetch.py ...)` — long video titles overflowed the shell argument
limit ("Argument list too long"). The pipeline hands off through a folder instead:
`fetch.py --out-dir work` then `transcribe.py --input-dir work`.

Optional environment variables (all no-ops if unset) let the workflow get past
datacenter-IP bot checks without changing this file:
  COOKIES_FILE         path to a Netscape cookies.txt (YouTube "not a bot" fix)
  YTDLP_PROXY          proxy URL, e.g. http://user:pass@host:port
  YTDLP_PLAYER_CLIENT  comma-separated YouTube player clients to try, e.g. "tv,ios"
"""
import argparse
import os
import re
import sys
from pathlib import Path

import yt_dlp

# Fixed quality presets (v1). yt-dlp picks the best stream at or below each
# height and merges video+audio into mp4.
QUALITY_PRESETS = {
    "best":  "bestvideo*+bestaudio/best",
    "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "720p":  "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
    "480p":  "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
    "360p":  "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def is_http_url(u: str) -> bool:
    return isinstance(u, str) and re.match(r"^https?://", u) is not None


def apply_env_hardening(opts: dict) -> dict:
    """Add cookies / proxy / player-client from env. Each is optional."""
    cookies = os.environ.get("COOKIES_FILE")
    if cookies and Path(cookies).exists():
        opts["cookiefile"] = cookies
        log(f"Using cookies file: {cookies}")

    proxy = os.environ.get("YTDLP_PROXY")
    if proxy:
        opts["proxy"] = proxy
        log("Using proxy")

    client = os.environ.get("YTDLP_PLAYER_CLIENT")
    if client:
        clients = [c.strip() for c in client.split(",") if c.strip()]
        opts["extractor_args"] = {"youtube": {"player_client": clients}}
        log(f"YouTube player client(s): {clients}")

    return opts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--mode", choices=["video", "audio"], required=True)
    ap.add_argument("--quality", default="best")
    ap.add_argument("--out-dir", default="output")
    args = ap.parse_args()

    # Defense in depth: the Worker already validates, but never trust input.
    if not is_http_url(args.url):
        log("ERROR: invalid URL")
        sys.exit(2)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    outtmpl = str(out / "%(title)s [%(id)s].%(ext)s")

    if args.mode == "video":
        opts = {
            "format": QUALITY_PRESETS.get(args.quality, QUALITY_PRESETS["best"]),
            "outtmpl": outtmpl,
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
        }
    else:  # audio-only — smaller/faster; all the transcriber needs
        opts = {
            "format": "bestaudio/best",
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}],
        }

    opts = apply_env_hardening(opts)

    log(f"Downloading ({args.mode}, quality={args.quality}) ...")
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(args.url, download=True)

    dls = info.get("requested_downloads")
    path = dls[0]["filepath"] if dls else ydl.prepare_filename(info)
    log(f"Saved: {path}")
    print(path)  # stdout: the path only


if __name__ == "__main__":
    main()