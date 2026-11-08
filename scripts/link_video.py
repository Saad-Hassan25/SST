"""Download supported website videos and publish caption exports using fixed paths."""
import json
import math
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


class VideoSourceError(ValueError):
    def __init__(self, code):
        self.code=code
        super().__init__(code)


def download_link(url, directory):
    parsed=urlsplit(url)
    if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password:
        raise VideoSourceError('source_unavailable')
    host=parsed.hostname.lower()
    if any(host==domain or host.endswith('.'+domain) for domain in ['youtube.com','youtu.be','youtube-nocookie.com']):
        raise VideoSourceError('source_unavailable')
    import yt_dlp
    from fetch import QUALITY_PRESETS,apply_env_hardening
    directory=Path(directory).resolve();directory.mkdir(parents=True,exist_ok=True)
    def limit(info,*,incomplete=False):
        if info.get('duration') and info['duration']>1200:
            raise VideoSourceError('source_limit')
        if info.get('filesize') and info['filesize']>512*1024**2:
            raise VideoSourceError('source_limit')
    def progress(value):
        if value.get('downloaded_bytes',0)>512*1024**2:
            raise VideoSourceError('source_limit')
    class QuietLogger:
        def debug(self,*_):pass
        def warning(self,*_):pass
        def error(self,*_):pass
    options=apply_env_hardening({'format':QUALITY_PRESETS['720p'],'outtmpl':str(directory/'source.%(ext)s'),
        'merge_output_format':'mp4','noplaylist':True,'playlistend':1,'quiet':True,'no_warnings':True,'logger':QuietLogger(),
        'max_filesize':512*1024**2,'socket_timeout':30,'retries':2,'fragment_retries':2,
        'match_filter':limit,'progress_hooks':[progress]})
    stage='download'
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            downloader.extract_info(url,download=True)
        stage='locate'
        # Redirected downloads may have no recognized extension (unknown_video).
        # Inspect the actual media with ffprobe instead of requiring a filename suffix.
        candidates=[p for p in directory.glob('source.*') if p.is_file() and p.suffix.lower() not in {'.part','.ytdl','.temp'}]
        if not candidates:
            raise VideoSourceError('source_unavailable')
        source=max(candidates,key=lambda p:p.stat().st_size)
        if source.stat().st_size>512*1024**2:
            raise VideoSourceError('source_limit')
        stage='probe'
        probe=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(source)],capture_output=True,check=True,timeout=30)
        metadata=json.loads(probe.stdout);duration=float(metadata['format']['duration'])
        if not math.isfinite(duration) or duration<=0 or duration>1200:
            raise VideoSourceError('source_limit')
        if not any(stream.get('codec_type')=='audio' for stream in metadata['streams']):
            raise VideoSourceError('source_unavailable')
        audio=directory/'audio.wav'
        stage='extract audio'
        subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-i',str(source),'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',str(audio)],capture_output=True,check=True,timeout=300)
        return source,audio
    except VideoSourceError as error:
        print(f'Video source {stage}: {error.code}.',file=sys.stderr)
        raise
    except Exception as error:
        # Log only stage/type/status, never downloader messages containing source URLs.
        status=re.search(r'HTTP Error (\d{3})',str(error))
        print(f'Video source {stage} failed ({type(error).__name__})'+(' HTTP '+status[1] if status else '')+'.',file=sys.stderr)
        raise VideoSourceError('source_unavailable') from None


def publish_captioned(source,subtitles,style,directory,job_id):
    from caption import STYLES,validate_srt
    if style not in STYLES:
        raise ValueError('Unknown caption style.')
    directory=Path(directory).resolve();directory.mkdir(parents=True,exist_ok=True)
    (directory/'captions.srt').write_text(validate_srt(subtitles),encoding='utf-8')
    output=directory/'captioned.mp4'
    subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-i',str(source),'-vf',f"subtitles=captions.srt:force_style='{STYLES[style]}'",'-c:v','libx264','-preset','fast','-crf','22','-c:a','aac','-movflags','+faststart',str(output)],cwd=directory,capture_output=True,check=True,timeout=1800)
    # Repository is fixed; no caller-controlled upload destination or CLI flags.
    repository='Saad-Hassan25/SST';tag='job-'+job_id
    subprocess.run(['gh','release','create',tag,'--repo',repository,'--title','Captioned video '+job_id,'--notes','status: done\nmode: captions'],capture_output=True,check=True,timeout=30)
    subprocess.run(['gh','release','upload',tag,str(output),str(directory/'captions.srt'),'--repo',repository,'--clobber'],capture_output=True,check=True,timeout=300)
    return f'https://github.com/{repository}/releases/download/{tag}/captioned.mp4'


def subtitle_cues(text):
    from caption import validate_srt
    result=[]
    def seconds(value):
        hours,minutes,rest=value.split(':');secs,ms=rest.split(',')
        return int(hours)*3600+int(minutes)*60+int(secs)+int(ms)/1000
    for block in validate_srt(text).strip().split('\n\n'):
        lines=block.splitlines();start,end=lines[1].split(' --> ')
        result.append({'start':seconds(start),'end':seconds(end),'text':'\n'.join(lines[2:])})
    return result
