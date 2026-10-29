# Video Downloader

A clean web app for saving videos and audio from YouTube and 1,000+ other sites. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).

- Paste a link and get a preview with the thumbnail, title, channel and length
- Download video (Best, 4K, 1080p, 720p…) as MP4, or audio only as MP3 / M4A
- Live progress with speed and time left
- Light and dark themes, works on phones

## Run it on your computer

You need Python 3.10+, [ffmpeg](https://ffmpeg.org/download.html) and [deno](https://deno.com/) (`winget install DenoLand.Deno` on Windows).

```bash
pip install -r requirements.txt
python server.py
```

It opens at http://127.0.0.1:5055 and saves files to the `downloads` folder. On Windows you can also double-click `Start Downloader.bat`.

## Put it online (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/roshanadhikari14-cpu/video-downloader)

1. Click the button above (or in Render: **New → Blueprint** and pick this repo).
2. Render reads `render.yaml`, builds the `Dockerfile` and gives you a public URL.

In public mode (`PUBLIC_MODE=1`, set automatically by the Dockerfile):

- Each visitor only sees their own downloads.
- Finished files download to the visitor's device and are deleted from the server after `FILE_TTL_MINUTES` (default 60).
- Limits: `MAX_FILESIZE_MB` (default 1024, 500 in `render.yaml`), `MAX_ACTIVE_PER_VISITOR` (2) and `MAX_ACTIVE_TOTAL` (6).

Railway, Fly.io or any host that runs Docker works the same way.

### Why not Vercel?

Vercel runs short serverless functions. This app needs long-running downloads, ffmpeg and temporary disk space, which Vercel doesn't provide.

## Things to know

- **YouTube may block servers.** YouTube often asks cloud servers to "sign in to confirm you're not a bot". When that happens, the app shows an error. Running it on your own computer is the most reliable option.
- **Free hosting sleeps.** On Render's free plan the app goes to sleep when idle, and the first visit after that takes about a minute.
- **Respect copyright.** Only download content you own or have permission to save, and follow each site's terms of service.

## Credits

Downloading is done by [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense). This project is not affiliated with yt-dlp, YouTube or Google.
