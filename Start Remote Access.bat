@echo off
title Downloader - Remote Access
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-remote.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-remote.ps1"
)
pause
