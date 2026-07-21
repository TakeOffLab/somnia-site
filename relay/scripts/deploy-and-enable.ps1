param(
  [string]$Distro = "Ubuntu",
  [string]$SomniaHome = "/home/grai/somnia",
  [string]$WorkersSubdomain = "somnia-ai"
)

$ErrorActionPreference = "Stop"

function Get-WranglerOAuthToken {
  $configPath = Join-Path $env:APPDATA "xdg.config\.wrangler\config\default.toml"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Wrangler credentials were not found. Run 'npx wrangler login' first."
  }

  $tokenLine = Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^\s*oauth_token\s*=' } | Select-Object -First 1
  if (-not $tokenLine -or $tokenLine -notmatch '^\s*oauth_token\s*=\s*"([^"]+)"') {
    throw "Wrangler OAuth credentials could not be read. Run 'npx wrangler login' again."
  }
  return $matches[1]
}

function Ensure-WorkersSubdomain {
  param([string]$RequestedSubdomain)

  $whoami = (& npx.cmd wrangler whoami 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "Wrangler authentication check failed:`n$whoami"
  }
  $accountMatch = [regex]::Match($whoami, "\b[a-f0-9]{32}\b")
  if (-not $accountMatch.Success) {
    throw "Cloudflare account ID was not found in Wrangler output."
  }

  $endpoint = "https://api.cloudflare.com/client/v4/accounts/$($accountMatch.Value)/workers/subdomain"
  $headers = @{ Authorization = "Bearer $(Get-WranglerOAuthToken)" }
  $current = $null
  try {
    $response = Invoke-RestMethod -Method Get -Uri $endpoint -Headers $headers
    if ($response.success) {
      $current = $response.result.subdomain
    }
  } catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    if ($statusCode -notin @(400, 404)) {
      throw
    }
  }

  if ($current) {
    Write-Output "WORKERS_SUBDOMAIN=$current"
    return
  }

  $body = @{ subdomain = $RequestedSubdomain } | ConvertTo-Json -Compress
  $created = Invoke-RestMethod -Method Put -Uri $endpoint -Headers $headers -ContentType "application/json" -Body $body
  if (-not $created.success) {
    throw "Cloudflare did not create the workers.dev subdomain."
  }
  Write-Output "WORKERS_SUBDOMAIN=$($created.result.subdomain)"
}

Ensure-WorkersSubdomain -RequestedSubdomain $WorkersSubdomain

$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$publishToken = -join ($bytes | ForEach-Object { $_.ToString("x2") })

$secretFile = Join-Path $env:TEMP ("somnia-relay-{0}.env" -f [Guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText(
    $secretFile,
    "PUBLISH_TOKEN=$publishToken",
    [System.Text.Encoding]::ASCII
  )

  $deployOutput = (& npx.cmd wrangler deploy --secrets-file $secretFile 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "wrangler deploy failed:`n$deployOutput"
  }
} finally {
  if (Test-Path -LiteralPath $secretFile) {
    Remove-Item -LiteralPath $secretFile -Force
  }
}

$urlMatch = [regex]::Match($deployOutput, "https://[a-zA-Z0-9.-]+\.workers\.dev")
if (-not $urlMatch.Success) {
  throw "Deployment URL was not found in Wrangler output:`n$deployOutput"
}
$baseUrl = $urlMatch.Value.TrimEnd("/")

$publisherEnv = @(
  "SOMNIA_FACE_RELAY_URL=$baseUrl/v1/publish"
  "SOMNIA_FACE_RELAY_TOKEN=$publishToken"
) -join "`n"
$publisherEnv += "`n"

$envPath = "/home/grai/.config/somnia/face-publisher.env"
$publisherFile = Join-Path $env:TEMP ("somnia-publisher-{0}.env" -f [Guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText(
    $publisherFile,
    $publisherEnv,
    (New-Object System.Text.UTF8Encoding($false))
  )
  $drive = $publisherFile.Substring(0, 1).ToLowerInvariant()
  $relativePath = $publisherFile.Substring(3).Replace("\", "/")
  $wslPublisherFile = "/mnt/$drive/$relativePath"
  $writeEnv = "set -eu; mkdir -p /home/grai/.config/somnia; install -m 600 '$wslPublisherFile' '$envPath'"
  & wsl.exe -d $Distro -e bash -lc $writeEnv
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to write the publisher relay credentials"
  }
} finally {
  if (Test-Path -LiteralPath $publisherFile) {
    Remove-Item -LiteralPath $publisherFile -Force
  }
}

$servicePath = "/home/grai/.config/systemd/user/somnia-face-publisher.service"
$bootstrap = @"
set -eu
dashboard_token=""
while IFS= read -r line; do
  case "`$line" in
    DASHBOARD_TOKEN=*) dashboard_token="`${line#DASHBOARD_TOKEN=}"; break ;;
  esac
done < "$SomniaHome/.env"
test -n "`$dashboard_token"
printf 'DASHBOARD_TOKEN=%s\n' "`$dashboard_token" >> "$envPath"
chmod 600 "$envPath"
mkdir -p /home/grai/.config/systemd/user
cp "$SomniaHome/deploy/somnia-face-publisher.service" "$servicePath"
systemctl --user daemon-reload
systemctl --user enable somnia-face-publisher.service
systemctl --user restart somnia-face-publisher.service
"@

$bootstrapBytes = [System.Text.Encoding]::UTF8.GetBytes($bootstrap.Replace("`r`n", "`n"))
$bootstrapBase64 = [Convert]::ToBase64String($bootstrapBytes)
& wsl.exe -d $Distro -e bash -lc "printf '%s' '$bootstrapBase64' | base64 --decode | bash"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to enable the Somnia face publisher"
}

Write-Output "DEPLOYED_URL=$baseUrl"
& wsl.exe -d $Distro -e bash -lc "printf 'ENV_MODE='; stat -c '%a' '$envPath'; printf 'SERVICE='; systemctl --user is-active somnia-face-publisher.service"
if ($LASTEXITCODE -ne 0) {
  throw "Publisher verification failed"
}
