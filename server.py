"""Web app for downloading videos and audio with yt-dlp.

Local use:   python server.py            (opens http://127.0.0.1:5055)
Hosted use:  PUBLIC_MODE=1 gunicorn -w 1 --threads 8 -b 0.0.0.0:$PORT server:app

In public mode every visitor only sees their own downloads, files are sent to
the visitor's browser, and finished files are deleted after FILE_TTL_MINUTES.
"""
import hmac
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

import yt_dlp

BASE = Path(__file__).resolve().parent
DOWNLOADS = Path(os.environ.get('DOWNLOAD_DIR', BASE / 'downloads'))
DOWNLOADS.mkdir(parents=True, exist_ok=True)

PUBLIC = os.environ.get('PUBLIC_MODE', '').lower() in ('1', 'true', 'yes')
PORT = int(os.environ.get('PORT', 5055))
HOST = os.environ.get('HOST', '0.0.0.0' if PUBLIC else '127.0.0.1')
APP_PASSWORD = os.environ.get('APP_PASSWORD', '')
FILE_TTL = int(os.environ.get('FILE_TTL_MINUTES', 60)) * 60
MAX_FILESIZE_MB = int(os.environ.get('MAX_FILESIZE_MB', 1024 if PUBLIC else 0))
MAX_ACTIVE_PER_VISITOR = int(os.environ.get('MAX_ACTIVE_PER_VISITOR', 2 if PUBLIC else 20))
MAX_ACTIVE_TOTAL = int(os.environ.get('MAX_ACTIVE_TOTAL', 6 if PUBLIC else 50))

ANSI = re.compile(r'\x1b\[[0-9;]*m')
VISITOR_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')


def refresh_path():
    """Pick up tools (deno, ffmpeg) installed after this shell was opened."""
    if os.name != 'nt':
        return
    import winreg
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'),
        (winreg.HKEY_CURRENT_USER, 'Environment'),
    ]
    parts = [os.environ.get('PATH', '')]
    for root, key in keys:
        try:
            with winreg.OpenKey(root, key) as k:
                parts.append(os.path.expandvars(winreg.QueryValueEx(k, 'Path')[0]))
        except OSError:
            pass
    os.environ['PATH'] = os.pathsep.join(parts)


refresh_path()

app = Flask(__name__, static_folder='static', static_url_path='/static')
jobs = {}
lock = threading.Lock()


@app.before_request
def require_password():
    """When APP_PASSWORD is set, ask the browser for it (any username works)."""
    if not APP_PASSWORD:
        return None
    auth = request.authorization
    if auth and auth.password and hmac.compare_digest(auth.password.encode(), APP_PASSWORD.encode()):
        return None
    return Response('Password required.', 401, {'WWW-Authenticate': 'Basic realm="Downloader", charset="UTF-8"'})


def clean_error(err):
    msg = ANSI.sub('', str(err)).strip()
    msg = re.sub(r'^ERROR:\s*', '', msg)
    msg = re.sub(r'^\[[^\]]+\]\s*[\w-]+:\s*', '', msg)  # drop "[youtube] abc123: "
    if 'confirm you' in msg and 'bot' in msg:
        msg = 'YouTube is blocking this server right now. Try again later, or run the app on your own computer.'
    return msg or 'Something went wrong.'


def visitor_id():
    vid = request.headers.get('X-Visitor') or request.args.get('v', '')
    return vid if VISITOR_RE.match(vid) else 'anonymous'


def update(job_id, **fields):
    with lock:
        if job_id in jobs:
            jobs[job_id].update(fields)


def public_job(job):
    return {k: v for k, v in job.items() if k not in ('path', 'visitor', 'dir')}


@app.get('/')
def index():
    return send_from_directory(BASE / 'static', 'index.html')


@app.get('/api/config')
def config():
    return jsonify(public=PUBLIC, file_ttl_minutes=FILE_TTL // 60, max_filesize_mb=MAX_FILESIZE_MB)


@app.post('/api/info')
def info():
    url = ((request.get_json(silent=True) or {}).get('url') or '').strip()
    if not url:
        return jsonify(error='Paste a link first.'), 400
    if not re.match(r'^https?://', url, re.I):
        return jsonify(error='That does not look like a link. It should start with https://'), 400
    opts = {
        'quiet': True, 'no_warnings': True, 'noplaylist': True,
        'skip_download': True, 'extract_flat': 'in_playlist',
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify(error=clean_error(e)), 400

    if data.get('_type') == 'playlist':
        return jsonify(error='That link is a playlist. Paste a link to a single video.'), 400

    formats = data.get('formats') or []
    heights = sorted({
        f['height'] for f in formats
        if f.get('height') and f.get('vcodec') not in (None, 'none')
    }, reverse=True)
    return jsonify(
        title=data.get('title') or 'Untitled',
        thumbnail=data.get('thumbnail'),
        duration=data.get('duration'),
        uploader=data.get('uploader') or data.get('channel'),
        views=data.get('view_count'),
        site=data.get('extractor_key'),
        url=data.get('webpage_url') or url,
        heights=heights,
        has_video=bool(heights) or any(f.get('vcodec') not in (None, 'none') for f in formats),
    )


def run_job(job_id, url, mode, quality, out_dir):
    def on_progress(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            done = d.get('downloaded_bytes') or 0
            update(job_id, status='downloading', stage='Downloading',
                   percent=(done / total * 100) if total else None,
                   speed=d.get('speed'), eta=d.get('eta'),
                   downloaded=done, total=total)
        elif d['status'] == 'finished':
            update(job_id, percent=100, speed=None, eta=None)

    def on_postprocess(d):
        if d['status'] == 'started':
            name = d.get('postprocessor') or ''
            stage = {'Merger': 'Merging video & audio',
                     'ExtractAudio': 'Converting audio'}.get(name, 'Finishing up')
            update(job_id, status='processing', stage=stage)

    opts = {
        'outtmpl': str(out_dir / '%(title).150B [%(id)s].%(ext)s'),
        'windowsfilenames': True,
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [on_progress],
        'postprocessor_hooks': [on_postprocess],
    }
    if MAX_FILESIZE_MB:
        opts['max_filesize'] = MAX_FILESIZE_MB * 1024 * 1024
    if mode == 'audio':
        codec = quality if quality in ('mp3', 'm4a') else 'mp3'
        opts['format'] = 'ba/b'
        opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio', 'preferredcodec': codec, 'preferredquality': '0',
        }]
    else:
        cap = f'[height<={int(quality)}]' if str(quality).isdigit() else ''
        opts['format'] = f'bv*{cap}+ba/b{cap}/b'
        opts['format_sort'] = ['res', 'ext:mp4:m4a']
        opts['merge_output_format'] = 'mp4'

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            result = ydl.extract_info(url, download=True)
        files = result.get('requested_downloads') or [{}]
        path = files[0].get('filepath') or ydl.prepare_filename(result)
        if not path or not os.path.exists(path):
            raise RuntimeError(
                f'The file is larger than the {MAX_FILESIZE_MB} MB limit. Try a lower quality.'
                if MAX_FILESIZE_MB else 'The download did not produce a file.')
        update(job_id, status='done', stage='Done', percent=100, finished=time.time(),
               path=path, filename=os.path.basename(path), size=os.path.getsize(path))
    except Exception as e:
        update(job_id, status='error', stage='Failed', error=clean_error(e), finished=time.time())


@app.post('/api/download')
def download():
    body = request.get_json(silent=True) or {}
    url = (body.get('url') or '').strip()
    if not re.match(r'^https?://', url, re.I):
        return jsonify(error='Missing link.'), 400
    mode = 'audio' if body.get('mode') == 'audio' else 'video'
    quality = str(body.get('quality') or ('mp3' if mode == 'audio' else 'best'))
    visitor = visitor_id()

    with lock:
        active = [j for j in jobs.values() if j['status'] in ('queued', 'downloading', 'processing')]
        if sum(j['visitor'] == visitor for j in active) >= MAX_ACTIVE_PER_VISITOR:
            return jsonify(error=f'You can run {MAX_ACTIVE_PER_VISITOR} downloads at once. Wait for one to finish.'), 429
        if len(active) >= MAX_ACTIVE_TOTAL:
            return jsonify(error='The server is busy right now. Try again in a minute.'), 503
        job_id = uuid.uuid4().hex[:12]
        out_dir = DOWNLOADS / job_id if PUBLIC else DOWNLOADS
        out_dir.mkdir(parents=True, exist_ok=True)
        jobs[job_id] = {
            'id': job_id, 'url': url, 'mode': mode, 'quality': quality, 'visitor': visitor,
            'title': str(body.get('title') or url)[:300], 'thumbnail': body.get('thumbnail'),
            'status': 'queued', 'stage': 'Starting', 'percent': 0,
            'created': time.time(), 'dir': str(out_dir) if PUBLIC else None,
        }
    threading.Thread(target=run_job, args=(job_id, url, mode, quality, out_dir), daemon=True).start()
    return jsonify(id=job_id)


def own_job(job_id):
    with lock:
        job = jobs.get(job_id)
    if not job or (PUBLIC and job['visitor'] != visitor_id()):
        abort(404)
    return job


@app.get('/api/jobs')
def list_jobs():
    visitor = visitor_id()
    with lock:
        items = [j for j in jobs.values() if not PUBLIC or j['visitor'] == visitor]
        items.sort(key=lambda j: j['created'], reverse=True)
        return jsonify([public_job(j) for j in items])


@app.delete('/api/jobs/<job_id>')
def remove_job(job_id):
    job = own_job(job_id)
    if job['status'] in ('done', 'error'):
        with lock:
            jobs.pop(job_id, None)
        if PUBLIC and job.get('dir'):
            shutil.rmtree(job['dir'], ignore_errors=True)
    return jsonify(ok=True)


def job_path(job_id):
    job = own_job(job_id)
    if not job.get('path') or not os.path.exists(job['path']):
        abort(404)
    return job['path']


@app.get('/api/jobs/<job_id>/file')
def get_file(job_id):
    path = job_path(job_id)
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


# Local-only helpers: open files on the computer running the server.
def local_only():
    if PUBLIC:
        abort(404)


def open_path(path, reveal=False):
    if os.name == 'nt':
        if reveal:
            subprocess.Popen(['explorer', '/select,', path])
        else:
            os.startfile(path)
    else:
        target = os.path.dirname(path) if reveal else path
        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', target])


@app.post('/api/jobs/<job_id>/open')
def open_file(job_id):
    local_only()
    open_path(job_path(job_id))
    return jsonify(ok=True)


@app.post('/api/jobs/<job_id>/reveal')
def reveal_file(job_id):
    local_only()
    open_path(job_path(job_id), reveal=True)
    return jsonify(ok=True)


@app.post('/api/open-folder')
def open_folder():
    local_only()
    open_path(str(DOWNLOADS))
    return jsonify(ok=True)


def cleanup_loop():
    """In public mode, delete finished downloads after FILE_TTL seconds."""
    while True:
        time.sleep(60)
        now = time.time()
        with lock:
            expired = [j for j in jobs.values()
                       if j.get('finished') and now - j['finished'] > FILE_TTL]
            for j in expired:
                jobs.pop(j['id'], None)
        for j in expired:
            if j.get('dir'):
                shutil.rmtree(j['dir'], ignore_errors=True)


if PUBLIC:
    # Clear leftovers from a previous run, then start the cleaner.
    for child in DOWNLOADS.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()


if __name__ == '__main__':
    if not PUBLIC and '--no-browser' not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(f'http://127.0.0.1:{PORT}')).start()
    print(f'Downloader running at http://127.0.0.1:{PORT}  (Ctrl+C to stop)')
    app.run(host=HOST, port=PORT, threaded=True)
