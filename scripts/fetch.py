#!/usr/bin/env python3
"""Download a video (at a quality preset) or its audio, using yt-dlp.

Prints ONLY the final file path to stdout; all human-readable logs go to stderr.
The path on stdout is for local/manual runs. Do NOT capture it in the workflow with
`AUDIO=$(python fetch.py ...)` — long video titles overflowed the shell argument
limit ("Argument list too long"). The pipeline hands off through a folder instead:
`fetch.py --out-dir work` then `transcribe.py --input-dir work`.

On failure, a short human-readable reason is written to the file named by the
JOB_ERROR_FILE env var (if set), so the workflow can surface it to the user instead of
a generic "job failed". See classify_error() for the mapping.

Optional environment variables (all no-ops if unset) let the workflow reach sites that
block datacenter IPs, WITHOUT editing this file:
  COOKIES_FILE         path to a Netscape cookies.txt (account-gated content on non-
                       YouTube sites; does NOT unblock YouTube — that's an IP problem)
  YTDLP_PROXY          proxy URL, e.g. http://user:pass@host:port
  YTDLP_PLAYER_CLIENT  comma-separated yt-dlp player clients to try, e.g. "tv,ios"
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

# Ordered most-specific first: the first pattern found in the error text wins, so a
# generic "unavailable" must not shadow "private" / "members-only" above it.
ERROR_SIGNS = [
    ("sign in to confirm you're not a bot", "This site is blocking automated downloads from this server."),
    ("this video is private",               "This video is private, so it can't be downloaded."),
    ("private video",                       "This video is private, so it can't be downloaded."),
    ("members-only",                        "This is members-only content and needs a subscribed account."),
    ("available to this channel's members", "This is members-only content and needs a subscribed account."),
    ("join this channel",                   "This is members-only content and needs a subscribed account."),
    ("confirm your age",                    "This video is age-restricted and needs a signed-in account."),
    ("age-restricted",                      "This video is age-restricted and needs a signed-in account."),
    ("inappropriate for some users",        "This video is age-restricted and needs a signed-in account."),
    ("requested format is not available",   "That quality isn't available for this video — try 'Best available'."),
    ("requested format not available",      "That quality isn't available for this video — try 'Best available'."),
    ("not available in your country",       "This video is blocked in the server's region."),
    ("geo restriction",                     "This video is blocked in the server's region."),
    ("geo-restricted",                      "This video is blocked in the server's region."),
    ("http error 404",                      "The video couldn't be found (404) — check the link."),
    ("http error 403",                      "The site refused access to this video (403)."),
    ("http error 401",                      "This video requires signing in."),
    ("login required",                      "This video requires signing in."),
    ("requires payment",                    "This video requires a purchase or subscription."),
    ("premium",                             "This video requires a premium account."),
    ("unsupported url",                     "This link isn't supported."),
    ("no video formats found",              "There's no downloadable video at that link."),
    ("unable to extract",                   "Couldn't read a video from that link — it may not be supported."),
    ("video unavailable",                   "This video is unavailable or has been removed."),
    ("this video is unavailable",           "This video is unavailable or has been removed."),
    ("is no longer available",              "This video is unavailable or has been removed."),
    ("timed out",                           "The download timed out — try again."),
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def classify_error(raw: str) -> str:
    """Map a raw yt-dlp error into one short, user-facing sentence."""
    low = raw.lower()
    for needle, message in ERROR_SIGNS:
        if needle in low:
            return message
    # Unknown error: hand back its first line, trimmed, rather than a traceback.
    first = raw.strip().splitlines()[0] if raw.strip() else "unknown error"
    first = re.sub(r"^\s*ERROR:\s*", "", first).strip()
    return f"The download failed: {first[:180]}"


def report_failure(message: str, code: int = 1):
    """Write a user-facing reason to JOB_ERROR_FILE (if set) and exit non-zero."""
    log("ERROR:", message)
    path = os.environ.get("JOB_ERROR_FILE")
    if path:
        try:
            Path(path).write_text(message.strip() + "\n", encoding="utf-8")
        except OSError:
            pass  # best-effort; the workflow falls back to a generic message
    sys.exit(code)


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
        report_failure("That doesn't look like a valid link.", code=2)

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
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(args.url, download=True)
    except yt_dlp.utils.DownloadError as e:
        report_failure(classify_error(str(e)))
    except Exception as e:  # noqa: BLE001 — any extractor failure becomes a clean reason
        report_failure(classify_error(str(e)))

    dls = info.get("requested_downloads")
    path = dls[0]["filepath"] if dls else ydl.prepare_filename(info)
    log(f"Saved: {path}")
    print(path)  # stdout: the path only


if __name__ == "__main__":
    main()
