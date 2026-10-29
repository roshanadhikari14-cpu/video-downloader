@echo off
title Downloader
cd /d "%~dp0"
if exist "%USERPROFILE%\.venvs\yt-dlp\Scripts\python.exe" (
  "%USERPROFILE%\.venvs\yt-dlp\Scripts\python.exe" server.py
) else (
  python server.py
)
pause
