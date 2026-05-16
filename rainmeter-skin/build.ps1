# Builds HyperXBattery.rmskin package from source files.
#
# An .rmskin file is a 7-Zip archive followed by a 20-byte footer:
#   8 bytes  uint64  size of the 7z portion (little-endian)
#   4 bytes  uint32  flags (little-endian, 0)
#   8 bytes  char[]  magic "RMSKIN\0\0"
# Rainmeter's Skin Installer validates this footer; a plain ZIP is rejected.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path $here -Parent

$sevenZip = @(
    "${env:ProgramFiles}\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sevenZip) { throw "7-Zip not found. Install from https://www.7-zip.org/" }

# 1. Build CLI exe
Write-Host "[1/4] Building CLI exe..." -ForegroundColor Cyan
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

# 3. Build 7z archive
Write-Host "[2/4] Creating 7z archive..." -ForegroundColor Cyan
$dist = Join-Path $here 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$staging = Join-Path $env:TEMP "rmskin-staging-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$archive = Join-Path $env:TEMP "rmskin-$([guid]::NewGuid()).7z"
try {
    Copy-Item (Join-Path $here 'RMSKIN.ini') (Join-Path $staging 'RMSKIN.ini')
    Copy-Item (Join-Path $here 'Skins') (Join-Path $staging 'Skins') -Recurse

    Push-Location $staging
    try {
        & $sevenZip a -t7z -mx=9 -ms=on $archive '*' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "7z packaging failed" }
    } finally { Pop-Location }

    # 4. Append RMSKIN footer
    Write-Host "[3/4] Appending RMSKIN footer..." -ForegroundColor Cyan
    $out = Join-Path $dist 'HyperXBattery.rmskin'
    Copy-Item $archive $out -Force

    $size = (Get-Item $out).Length
    $footer = [byte[]]::new(20)
    [BitConverter]::GetBytes([uint64]$size).CopyTo($footer, 0)
    [BitConverter]::GetBytes([uint32]0).CopyTo($footer, 8)
    $magic = [byte[]](0x52,0x4D,0x53,0x4B,0x49,0x4E,0x00,0x00)
    [System.Array]::Copy($magic, 0, $footer, 12, 8)

    $fs = [System.IO.File]::Open($out, [System.IO.FileMode]::Append)
    try { $fs.Write($footer, 0, 20) } finally { $fs.Close() }

    $bytes = (Get-Item $out).Length
    Write-Host "[4/4] Built $out ($bytes bytes)" -ForegroundColor Green
} finally {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    if (Test-Path $archive) { Remove-Item $archive -Force }
}
