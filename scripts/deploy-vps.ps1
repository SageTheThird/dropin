param(
  [string]$HostName = "",
  [string]$User = "root",
  [int]$SshPort = 22,
  [string]$RemoteDir = "/opt/dropin",
  [string]$ServiceName = "dropin",
  [int]$AppPort = 8787,
  [int]$NodeMajor = 20,
  [switch]$ConfigureCaddy,
  [string]$CaddyHost = ""
)

$ErrorActionPreference = "Stop"

if (-not $HostName) {
  throw "HostName is required. Pass -HostName <ip-or-ssh-alias>."
}

if ($ServiceName -notmatch '^[a-zA-Z0-9_.-]+$') {
  throw "ServiceName may only contain letters, numbers, dots, underscores, and dashes."
}

function Escape-ShellSingle([string]$Value) {
  return $Value.Replace("'", "'\''")
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Resolve-WindowsBinary([string]$Name) {
  $systemPath = Join-Path $env:WINDIR "System32\$Name"
  if (Test-Path $systemPath) { return $systemPath }
  $opensshPath = Join-Path $env:WINDIR "System32\OpenSSH\$Name"
  if (Test-Path $opensshPath) { return $opensshPath }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$ssh = Resolve-WindowsBinary "ssh.exe"
$scp = Resolve-WindowsBinary "scp.exe"
$tar = Resolve-WindowsBinary "tar.exe"

if (-not $ssh) { throw "ssh.exe was not found on PATH." }
if (-not $scp) { throw "scp.exe was not found on PATH." }
if (-not $tar) { throw "tar.exe was not found on PATH." }

$target = if ($User) { "${User}@${HostName}" } else { $HostName }
$resolvedCaddyHost = $CaddyHost
if ($ConfigureCaddy -and -not $resolvedCaddyHost) {
  if ($HostName -match '^\d{1,3}(\.\d{1,3}){3}$') {
    $resolvedCaddyHost = "dropin-$($HostName -replace '\.', '-').nip.io"
  } else {
    $resolvedCaddyHost = $HostName
  }
}

$configureCaddyText = if ($ConfigureCaddy) { "true" } else { "false" }
$caddyHostEscaped = Escape-ShellSingle $resolvedCaddyHost
$sshArgs = @()
$scpArgs = @()
if ($SshPort -ne 22) {
  $sshArgs += @("-p", "$SshPort")
  $scpArgs += @("-P", "$SshPort")
}

$tmp = Join-Path $root ".deploy-tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$archive = Join-Path $tmp "dropin.tar.gz"
$envFile = Join-Path $tmp "dropin.env"

if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
if (Test-Path $envFile) { Remove-Item -LiteralPath $envFile -Force }

$envMap = @{}
$localEnv = Join-Path $root ".env"
if (Test-Path $localEnv) {
  Get-Content -LiteralPath $localEnv | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $idx = $line.IndexOf("=")
      $key = $line.Substring(0, $idx).Trim()
      $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
      $envMap[$key] = $value
    }
  }
}

if (-not $envMap.ContainsKey("YOUTUBE_API_KEY") -or -not $envMap["YOUTUBE_API_KEY"]) {
  throw "YOUTUBE_API_KEY is missing from .env."
}

$allowedEnv = @("YOUTUBE_API_KEY", "SYNC_ROOM_PASSWORD")
$envLines = @("NODE_ENV=production", "PORT=$AppPort")
foreach ($key in $allowedEnv) {
  if ($envMap.ContainsKey($key) -and $envMap[$key]) {
    $escaped = $envMap[$key].Replace("\", "\\").Replace('"', '\"')
    $envLines += "$key=""$escaped"""
  }
}
Set-Content -LiteralPath $envFile -Value $envLines -Encoding utf8

Push-Location $root
try {
  & $tar `
    --exclude=".deploy-tmp" `
    --exclude=".env" `
    --exclude=".wrangler" `
    --exclude="node_modules" `
    --exclude="server*.log" `
    --exclude="tmp-*" `
    -czf $archive .
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path $archive)) { throw "Archive was not created at $archive" }

Write-Host "Creating remote directory $RemoteDir on $target..."
& $ssh @sshArgs $target "mkdir -p '$RemoteDir' && rm -f /tmp/dropin.tar.gz /tmp/dropin.env"

Write-Host "Uploading app archive and environment..."
& $scp @scpArgs $archive "${target}:/tmp/dropin.tar.gz"
& $scp @scpArgs $envFile "${target}:/tmp/dropin.env"

$remoteScript = @"
set -euo pipefail

REMOTE_DIR='$RemoteDir'
SERVICE_NAME='$ServiceName'
APP_PORT='$AppPort'
NODE_MAJOR='$NodeMajor'
CONFIGURE_CADDY='$configureCaddyText'
CADDY_HOST='$caddyHostEscaped'

if ! command -v node >/dev/null 2>&1 || [ "`$(node -v | sed 's/^v//' | cut -d. -f1)" -lt "`$NODE_MAJOR" ]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg tar gzip
  curl -fsSL "https://deb.nodesource.com/setup_`$NODE_MAJOR.x" | bash -
  apt-get install -y nodejs
fi

mkdir -p "`$REMOTE_DIR"
tar -xzf /tmp/dropin.tar.gz -C "`$REMOTE_DIR"
mv /tmp/dropin.env "`$REMOTE_DIR/.env"
chmod 600 "`$REMOTE_DIR/.env"

NODE_BIN="`$(command -v node)"
cat > "/etc/systemd/system/`$SERVICE_NAME.service" <<SERVICE
[Unit]
Description=DropIn room server
After=network.target

[Service]
Type=simple
WorkingDirectory=`$REMOTE_DIR
EnvironmentFile=`$REMOTE_DIR/.env
ExecStart=`$NODE_BIN server/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "`$SERVICE_NAME"
systemctl restart "`$SERVICE_NAME"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "`$APP_PORT/tcp" >/dev/null || true
fi

if [ "`$CONFIGURE_CADDY" = "true" ]; then
  if [ -z "`$CADDY_HOST" ]; then
    echo "CADDY_HOST is required when CONFIGURE_CADDY=true" >&2
    exit 1
  fi

  apt-get update
  apt-get install -y caddy

  cat > /etc/caddy/Caddyfile <<CADDY
`$CADDY_HOST {
  reverse_proxy 127.0.0.1:`$APP_PORT
}
CADDY

  systemctl enable caddy
  systemctl reload caddy || systemctl restart caddy

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null || true
    ufw allow 443/tcp >/dev/null || true
  fi
fi

systemctl --no-pager --full status "`$SERVICE_NAME" | head -n 12
if [ "`$CONFIGURE_CADDY" = "true" ]; then
  systemctl --no-pager --full status caddy | head -n 8
fi
"@
$remoteScript = $remoteScript -replace "`r", ""

Write-Host "Installing and restarting service..."
$remoteScript | & $ssh @sshArgs $target "tr -d '\r' | bash -s"

Write-Host ""
Write-Host "Deployed DropIn."
if ($ConfigureCaddy) {
  Write-Host "Open: https://$resolvedCaddyHost"
} else {
  Write-Host "Open: http://${HostName}:$AppPort"
}
