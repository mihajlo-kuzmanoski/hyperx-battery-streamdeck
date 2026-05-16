# Builds HyperXBattery.rmskin package from source files.
# Output: dist\HyperXBattery.rmskin (a ZIP archive Rainmeter accepts).

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path $here -Parent

# 1. Build CLI exe
Write-Host "[1/3] Building CLI exe..." -ForegroundColor Cyan
Push-Location (Join-Path $repo 'tray-app-csharp')
try {
    & cmd /c '.\build-cli.bat'
    if ($LASTEXITCODE -ne 0) { throw "CLI build failed" }
} finally { Pop-Location }

# 2. Copy CLI exe to @Resources
$src = Join-Path $repo 'tray-app-csharp\bin\HyperXBattery-cli.exe'
$dstDir = Join-Path $here 'Skins\HyperXBattery\@Resources'
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item $src (Join-Path $dstDir 'HyperXBattery-cli.exe') -Force

# 3. Package as .rmskin (zip)
Write-Host "[2/3] Packaging .rmskin..." -ForegroundColor Cyan
$dist = Join-Path $here 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$out = Join-Path $dist 'HyperXBattery.rmskin'
if (Test-Path $out) { Remove-Item $out -Force }

$staging = Join-Path $env:TEMP "rmskin-staging-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
    Copy-Item (Join-Path $here 'RMSKIN.ini') (Join-Path $staging 'RMSKIN.ini')
    Copy-Item (Join-Path $here 'Skins') (Join-Path $staging 'Skins') -Recurse
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $out -CompressionLevel Optimal
} finally {
    Remove-Item $staging -Recurse -Force
}

$bytes = (Get-Item $out).Length
Write-Host "[3/3] Built $out ($bytes bytes)" -ForegroundColor Green
