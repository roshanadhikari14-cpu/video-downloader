FROM python:3.13-slim

# ffmpeg merges video + audio and converts to MP3; deno lets yt-dlp solve YouTube's JavaScript checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PUBLIC_MODE=1 \
    DOWNLOAD_DIR=/tmp/downloads \
    PORT=10000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 10000
# One worker so all visitors share the same in-memory download list; threads handle concurrency.
CMD gunicorn -w 1 --threads 16 --timeout 0 -b 0.0.0.0:${PORT} server:app
