#!/usr/bin/env python3
"""Burn validated SRT into downloaded media. No shell or caller-supplied ffmpeg flags."""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

STYLES = {
    "classic": "FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=24",
    "bold": "FontName=DejaVu Sans,FontSize=26,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,MarginV=30",
    "minimal": "FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=3,Shadow=0,MarginV=24",
}
TIMING = re.compile(r"^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$")


def validate_srt(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 40000:
        raise ValueError("Caption subtitles must be SRT, up to 40 KB.")
    blocks = re.split(r"\n\s*\n", text.strip().replace("\r", ""))
    result = []
    last_start = -1
    for index, block in enumerate(blocks, 1):
        lines = block.splitlines()
        if len(lines) < 3 or not lines[0].isdigit():
            raise ValueError("Invalid SRT cue. Each cue needs an index, timing and text.")
        match = TIMING.fullmatch(lines[1].strip())
        if not match:
            raise ValueError("Invalid caption timestamps.")
        values = list(map(int, match.groups()))
        start = values[0] * 3600000 + values[1] * 60000 + values[2] * 1000 + values[3]
        end = values[4] * 3600000 + values[5] * 60000 + values[6] * 1000 + values[7]
        if end <= start or start < last_start:
            raise ValueError("Caption timings must be ordered and end after they start.")
        last_start = start
        # Caption content is plain text; strip subtitle/ASS styling commands so
        # the selected preset controls the renderer. Paths and filter args are fixed.
        caption = re.sub(r"<[^>]*>|\{[^}]*\}", "", "\n".join(lines[2:])).replace("\\", "")
        caption = "".join(c for c in caption if c in "\n\t" or ord(c) >= 32).strip()
        if not caption:
            raise ValueError("A caption cue contains no readable text.")
        result.append(f"{index}\n{lines[1].strip()}\n{caption}\n")
    if not result:
        raise ValueError("No timed captions found.")
    return "\n".join(result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    try:
        style = STYLES.get(os.environ.get("CAPTION_STYLE", "classic"))
        if not style:
            raise ValueError("Unknown caption style.")
        subtitles = validate_srt(os.environ.get("SUBTITLES", ""))
        source_dir = Path(args.input_dir).resolve()
        videos = [p for p in source_dir.iterdir() if p.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"}]
        if not videos:
            raise ValueError("No downloaded video was found to caption.")
        output_dir = Path(args.out_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "captions.srt").write_text(subtitles, encoding="utf-8")
        # Run inside the output directory, so the filter path is a constant without
        # Windows drive colons, apostrophes, or titles interpolated into ffmpeg syntax.
        command = ["ffmpeg", "-nostdin", "-y", "-i", str(videos[0]),
                   "-vf", f"subtitles=captions.srt:force_style='{style}'",
                   "-c:v", "libx264", "-preset", "fast", "-crf", "22",
                   "-c:a", "aac", "-movflags", "+faststart", "captioned.mp4"]
        subprocess.run(command, cwd=output_dir, check=True, timeout=18000)
    except subprocess.TimeoutExpired:
        report_error("Caption rendering exceeded the five-hour limit. Try a shorter video.")
    except subprocess.CalledProcessError:
        report_error("Caption rendering failed. Try a different video or subtitle file.")
    except (OSError, ValueError) as error:
        report_error(str(error))


def report_error(message):
    if os.environ.get("JOB_ERROR_FILE"):
        Path(os.environ["JOB_ERROR_FILE"]).write_text(message + "\n", encoding="utf-8")
    print(message, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
