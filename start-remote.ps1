# Runs the downloader on this PC and gives it a public, password-protected link
# through a free Cloudflare quick tunnel. Keep this window open while you use it.
# -NoPrompt: keep running until the tunnel exits instead of waiting for Enter.
param([switch]$NoPrompt)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 5057

# Password: stored next to this script (never uploaded to GitHub).
$pwFile = Join-Path $here 'remote-password.txt'
if (-not (Test-Path $pwFile)) {
    $chars = 'abcdefghjkmnpqrstuvwxyz23456789'.ToCharArray()
    $bytes = [byte[]]::new(12)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    $pw = $pw.Substring(0, 4) + '-' + $pw.Substring(4, 4) + '-' + $pw.Substring(8, 4)
    Set-Content -Path $pwFile -Value $pw -NoNewline
}
$password = (Get-Content $pwFile -Raw).Trim()

$py = Join-Path $env:USERPROFILE '.venvs\yt-dlp\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
if (-not (Test-Path $cf)) { throw 'cloudflared is not installed. Run: winget install Cloudflare.cloudflared' }

$env:PUBLIC_MODE = '1'
$env:HOST = '127.0.0.1'
$env:PORT = "$port"
$env:APP_PASSWORD = $password
$env:DOWNLOAD_DIR = Join-Path $here 'downloads-remote'
$env:MAX_FILESIZE_MB = '4096'
$env:MAX_ACTIVE_PER_VISITOR = '4'

# Logs live next to this script ($env:TEMP can be a short "MYPC~1" path that PowerShell 7 rejects).
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverLog = Join-Path $logDir 'server.log'
$tunnelLog = Join-Path $logDir 'tunnel.log'
if (Test-Path -LiteralPath $tunnelLog) { Remove-Item -LiteralPath $tunnelLog -Force }

Write-Host 'Starting the downloader...' -ForegroundColor Cyan
$server = Start-Process $py -ArgumentList 'server.py' -WorkingDirectory $here -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
Write-Host 'Opening the Cloudflare tunnel...' -ForegroundColor Cyan
$tunnel = Start-Process $cf -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$port" `
    -WindowStyle Hidden -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"

try {
    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep -Milliseconds 500
        if ($tunnel.HasExited) { throw "The tunnel stopped. See $tunnelLog" }
        if (Test-Path $tunnelLog) {
            $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value }
        }
    }
    if (-not $url) { throw "No public link after 30 seconds. See $tunnelLog" }
    try { Set-Clipboard -Value $url } catch {}

    Write-Host ''
    Write-Host '  Your downloader is online:' -ForegroundColor Green
    Write-Host "    $url" -ForegroundColor White
    Write-Host '  (copied to your clipboard)'
    Write-Host ''
    Write-Host "  Password: $password   (any username works)" -ForegroundColor Yellow
    Write-Host "  Change it any time by editing remote-password.txt"
    Write-Host ''
    Write-Host '  The link changes each time you start this. Keep this window open;'
    Write-Host '  press Enter here to stop.'
    if ($NoPrompt) { $tunnel.WaitForExit() } else { Read-Host | Out-Null }
}
finally {
    foreach ($p in $tunnel, $server) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    Write-Host 'Stopped.'
}
