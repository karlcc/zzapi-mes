# install.ps1 — install zzapi-mes hub on a Windows host
# Run from repo root:  powershell -File apps\hub\deploy\install.ps1
#
# Prerequisites:
#   - Node 20+ installed (C:\Program Files\nodejs\node.exe)
#   - pnpm installed globally
#   - VS Build Tools 2022 with C++ workload (for native modules)
#   - Admin PowerShell (for nssm service registration)
#
# What this does:
#   1. Builds the project if dist/ is missing
#   2. Creates data directory C:\var\zzapi-mes-hub
#   3. Runs DB migration
#   4. Installs nssm if not present
#   5. Creates env file from example if none exists
#   6. Registers and starts the Windows service

param(
    [string]$InstallDir = "C:\Users\karlchow\code\zzapi-mes",
    [string]$DataDir    = "C:\var\zzapi-mes-hub",
    [string]$EnvFile    = "C:\etc\zzapi-mes-hub.env",
    [int]$Port          = 8080
)

$ErrorActionPreference = "Stop"

$repoRoot = $InstallDir
$distDir  = Join-Path $repoRoot "apps\hub\dist"

# --- 1. Build if needed ---
if (-not (Test-Path $distDir)) {
    Write-Host "Building project..."
    Push-Location $repoRoot
    pnpm build
    Pop-Location
}

# --- 2. Data directory ---
Write-Host "Setting up data directory at $DataDir..."
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# --- 3. DB migration ---
Write-Host "Running DB migration..."
$env:HUB_DB_PATH = Join-Path $DataDir "hub.db"
node (Join-Path $distDir "scripts\migrate.js")

# --- 4. Install nssm if missing ---
$nssmPath = "C:\Windows\nssm.exe"
if (-not (Test-Path $nssmPath)) {
    Write-Host "Installing nssm..."
    $zipPath = Join-Path $env:TEMP "nssm.zip"
    $extractDir = Join-Path $env:TEMP "nssm"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    Copy-Item (Join-Path $extractDir "nssm-2.24\win64\nssm.exe") $nssmPath -Force
    Remove-Item $zipPath, $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "nssm installed."
}

# --- 5. Env file ---
if (-not (Test-Path $EnvFile)) {
    $exampleFile = Join-Path $repoRoot "apps\hub\deploy\zzapi-mes-hub.env.example"
    if (Test-Path $exampleFile) {
        $envDir = Split-Path $EnvFile
        if ($envDir) { New-Item -ItemType Directory -Path $envDir -Force | Out-Null }
        Copy-Item $exampleFile $EnvFile
        Write-Host "!! Edit $EnvFile with your values before starting the service !!"
    } else {
        Write-Host "Example env file not found at $exampleFile — skipping"
    }
} else {
    Write-Host "Env file $EnvFile already exists — not overwriting"
}

# --- 6. Register nssm service ---
$serviceName = "zzapi-mes-hub"
$nodeExe     = "C:\Program Files\nodejs\node.exe"
$entryPoint  = Join-Path $distDir "index.js"
$appDir      = Join-Path $repoRoot "apps\hub"
$dbPath      = Join-Path $DataDir "hub.db"
$stdoutLog   = Join-Path $DataDir "stdout.log"
$stderrLog   = Join-Path $DataDir "stderr.log"

# Remove existing service if present
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service..."
    & $nssmPath stop $serviceName 2>$null
    Start-Sleep -Seconds 2
    & $nssmPath remove $serviceName confirm 2>$null
    Start-Sleep -Seconds 1
}

Write-Host "Installing nssm service $serviceName..."
& $nssmPath install $serviceName $nodeExe $entryPoint
& $nssmPath set $serviceName AppDirectory $appDir
& $nssmPath set $serviceName AppStdout $stdoutLog
& $nssmPath set $serviceName AppStderr $stderrLog
& $nssmPath set $serviceName AppRotateFiles 1
& $nssmPath set $serviceName AppRotateBytes 1048576
& $nssmPath set $serviceName Start SERVICE_AUTO_START

# Set env vars from env file if it exists, otherwise prompt
if (Test-Path $EnvFile) {
    $envContent = Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#]' -and $_ -match '=' }
    $envPairs = $envContent | ForEach-Object { $_.Trim() }
    & $nssmPath set $serviceName AppEnvironmentExtra @envPairs
} else {
    Write-Host "No env file found. Set service env vars manually:"
    Write-Host "  nssm set $serviceName AppEnvironmentExtra HUB_PORT=$Port HUB_JWT_SECRET=<secret> HUB_DB_PATH=$dbPath SAP_HOST=... SAP_CLIENT=... SAP_USER=... SAP_PASS=..."
}

# --- 7. Start service ---
Write-Host "Starting service..."
& $nssmPath start $serviceName

Start-Sleep -Seconds 3
$status = & $nssmPath status $serviceName 2>&1
Write-Host "Service status: $status"

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. If env file was new, edit $EnvFile with your values, then restart:"
Write-Host "     nssm restart $serviceName"
Write-Host "  2. Create an API key:"
Write-Host "     node apps\hub\dist\admin\cli.js keys create --label first --scopes ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi"
Write-Host "  3. Verify:  Invoke-RestMethod http://localhost:$Port/healthz"
Write-Host ""
Write-Host "To view logs:"
Write-Host "  Get-Content $stdoutLog -Tail 50"
Write-Host "  Get-Content $stderrLog -Tail 50"
