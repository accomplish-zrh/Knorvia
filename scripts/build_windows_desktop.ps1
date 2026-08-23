param(
    # Optional pre-release label for ARTIFACT naming only, e.g. "rc.1".
    # The application version itself always comes from knorvia/__version__.py,
    # so a release candidate is `Knorvia-1.7.0-rc.1-setup.exe` while the app
    # reports 1.7.0. Leave empty for the final release.
    [string]$Prerelease = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# ── version: single source of truth ──────────────────────────────────────
$VersionFile = Join-Path $ProjectRoot "knorvia\__version__.py"
if (-not (Test-Path $VersionFile)) {
    throw "Version file not found: $VersionFile"
}
$VersionLine = Select-String -Path $VersionFile -Pattern '__version__\s*=\s*"([^"]+)"'
if (-not $VersionLine) {
    throw "Could not read __version__ from $VersionFile"
}
$Version = $VersionLine.Matches[0].Groups[1].Value
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Unexpected version format: $Version"
}
if ($Prerelease -and $Prerelease -notmatch '^[A-Za-z0-9.-]+$') {
    throw "Invalid pre-release label: $Prerelease"
}
$VersionLabel = if ($Prerelease) { "$Version-$Prerelease" } else { $Version }
Write-Host "Knorvia version: $Version (artifact label: $VersionLabel)"

# electron-builder derives artifact names from desktop/package.json, while the
# rename/verification steps below derive them from knorvia/__version__.py.
# A drift would make this script look for an installer that was never created,
# so fail fast instead of surfacing as a confusing error after a full build.
$DesktopPackageJson = Join-Path $ProjectRoot "desktop\package.json"
if (-not (Test-Path $DesktopPackageJson)) {
    throw "Desktop package manifest not found: $DesktopPackageJson"
}
$DesktopVersion = (Get-Content -LiteralPath $DesktopPackageJson -Raw | ConvertFrom-Json).version
if ($DesktopVersion -ne $Version) {
    throw (
        "Version drift detected: knorvia/__version__.py is $Version but " +
        "desktop/package.json is $DesktopVersion. Keep them in sync before packaging."
    )
}

$WebRoot = Join-Path $ProjectRoot "web"
$PortableRoot = Join-Path $ProjectRoot "dist\Knorvia-$Version-portable"
$RuntimeRoot = Join-Path $PortableRoot "runtime"
$PythonRoot = Join-Path $RuntimeRoot "python"

Write-Host "[1/6] Building the production interface..."
Push-Location $WebRoot
try {
    npm ci --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    $env:KNORVIA_NEXT_DIST_DIR = ".next-knorvia"
    $env:NEXT_PUBLIC_API_BASE = "__NEXT_PUBLIC_API_BASE_PLACEHOLDER__"
    $env:NEXT_PUBLIC_AUTH_ENABLED = "__NEXT_PUBLIC_AUTH_ENABLED_PLACEHOLDER__"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Write-Host "[2/6] Embedding the interface in the Python package..."
$BuildPython = (uv python find --system 3.12).Trim()
if (-not $BuildPython) { throw "uv python find --system 3.12 returned nothing (is uv installed?)" }
& $BuildPython (Join-Path $PSScriptRoot "prepare_web_package.py") --skip-build --dist-dir .next-knorvia
if ($LASTEXITCODE -ne 0) { throw "Web package preparation failed with exit code $LASTEXITCODE" }

Write-Host "[3/6] Building the application wheel..."
Push-Location $ProjectRoot
try {
    # Setuptools reuses build/lib and would otherwise carry renamed packages
    # from an earlier brand into the new wheel. Only remove its known cache
    # directories; project assets under build/ are left untouched.
    $BuildRoot = (Join-Path $ProjectRoot "build")
    foreach ($CacheDir in @((Join-Path $BuildRoot "lib"), (Join-Path $BuildRoot "bdist.win-amd64"))) {
        if (Test-Path -LiteralPath $CacheDir) {
            $ResolvedBuild = (Resolve-Path $BuildRoot).Path
            $ResolvedCache = (Resolve-Path $CacheDir).Path
            if ((Split-Path -Parent $ResolvedCache) -ne $ResolvedBuild) {
                throw "Refusing to remove unexpected build cache: $ResolvedCache"
            }
            Remove-Item -LiteralPath $ResolvedCache -Recurse -Force
        }
    }
    uv --quiet build --wheel --out-dir dist
    if ($LASTEXITCODE -ne 0) { throw "Wheel build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Write-Host "[4/6] Preparing the private runtime..."
$PythonExePath = Join-Path $PythonRoot "python.exe"
$NeedsPythonRuntime = ((-not (Test-Path $PythonExePath)) -or (Test-Path (Join-Path $PythonRoot "pyvenv.cfg")))
if (-not $NeedsPythonRuntime) {
    $ResolvedPythonRoot = (Resolve-Path $PythonRoot).Path
    $InterpreterPrefix = (& $PythonExePath -c "import sys; print(sys.prefix)").Trim()
    $NeedsPythonRuntime = ([IO.Path]::GetFullPath($InterpreterPrefix) -ne $ResolvedPythonRoot)
}
if ($NeedsPythonRuntime) {
    if (Test-Path $PythonRoot) {
        $ResolvedRuntime = (Resolve-Path $RuntimeRoot).Path
        $ResolvedPython = (Resolve-Path $PythonRoot).Path
        if ((Split-Path -Parent $ResolvedPython) -ne $ResolvedRuntime) {
            throw "Refusing to replace unexpected Python runtime: $ResolvedPython"
        }
        Remove-Item -LiteralPath $ResolvedPython -Recurse -Force
    }
    # --system prevents uv from selecting the project's .venv, whose copied
    # executable would still resolve back to the developer environment.
    $PythonExe = (uv python find --system 3.12).Trim()
    if (-not $PythonExe) { throw "uv python find --system 3.12 returned nothing" }
    New-Item -ItemType Directory -Force -Path $PythonRoot | Out-Null
    Copy-Item -Path (Join-Path (Split-Path -Parent $PythonExe) "*") -Destination $PythonRoot -Recurse -Force
}
Remove-Item -LiteralPath (Join-Path $PythonRoot "Lib\EXTERNALLY-MANAGED") -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeRoot "node") | Out-Null
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $RuntimeRoot "node\node.exe") -Force
$Wheel = Get-ChildItem (Join-Path $ProjectRoot "dist\knorvia-$Version-*.whl") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Wheel) { throw "No wheel found for version $Version under dist\" }
# The published wheel intentionally defaults to the lightweight core.  The
# desktop application needs the complete browser/server runtime, so request the
# app extra from this exact local wheel instead of resolving another Knorvia
# distribution from the package index.
$WheelWithApp = "$($Wheel.FullName)[app]"
uv pip install --system --python (Join-Path $PythonRoot "python.exe") --link-mode copy --upgrade $WheelWithApp
if ($LASTEXITCODE -ne 0) { throw "Desktop runtime install failed with exit code $LASTEXITCODE" }

Write-Host "[5/6] Installing desktop packager dependencies..."
Push-Location (Join-Path $ProjectRoot "desktop")
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "Desktop dependency install failed with exit code $LASTEXITCODE" }
    node --check main.js
    if ($LASTEXITCODE -ne 0) { throw "Desktop main-process syntax check failed" }
    node --check protocol-stream.js
    if ($LASTEXITCODE -ne 0) { throw "Desktop stream-bridge syntax check failed" }
    foreach ($JsFile in @("preload.js", "frontend-host.js")) {
        node --check $JsFile
        if ($LASTEXITCODE -ne 0) { throw "Desktop $JsFile syntax check failed" }
    }
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Desktop transport tests failed with exit code $LASTEXITCODE" }
    Write-Host "[6/6] Creating portable folder and installer..."
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "Desktop packaging failed with exit code $LASTEXITCODE" }
    $AppAsar = Join-Path (Join-Path $ProjectRoot "release\win-unpacked\resources") "app.asar"
    node -e "const asar=require('@electron/asar'); const files=asar.listPackage(process.argv[1]); if(!files.some(p=>p.replaceAll('\\','/').endsWith('/protocol-stream.js'))){throw new Error('protocol-stream.js missing from app.asar')}" $AppAsar
    if ($LASTEXITCODE -ne 0) { throw "Desktop stream bridge is missing from the packaged app" }
    if ($Prerelease) {
        # electron-builder names the installer from package.json's
        # ``artifactName`` (Knorvia-${version}-setup.exe) and silently ignores
        # CLI overrides; rename the produced files to the pre-release label
        # instead.
        $DefaultInstaller = Join-Path (Join-Path $ProjectRoot "release") "Knorvia-$Version-setup.exe"
        $RcInstaller = Join-Path (Join-Path $ProjectRoot "release") "Knorvia-$VersionLabel-setup.exe"
        if (-not (Test-Path $DefaultInstaller)) {
            throw "Installer not found at $DefaultInstaller"
        }
        Rename-Item -LiteralPath $DefaultInstaller -NewName "Knorvia-$VersionLabel-setup.exe"
        $DefaultBlockmap = "$DefaultInstaller.blockmap"
        if (Test-Path $DefaultBlockmap) {
            Rename-Item -LiteralPath $DefaultBlockmap -NewName "Knorvia-$VersionLabel-setup.exe.blockmap"
        }
        Write-Host "Renamed installer to $RcInstaller"
    }
} finally { Pop-Location }

$ReleaseRoot = Join-Path $ProjectRoot "release"
$UnpackedRoot = Join-Path $ReleaseRoot "win-unpacked"
$DesktopPortableRoot = Join-Path $ReleaseRoot "Knorvia-$VersionLabel-portable"
if (-not (Test-Path (Join-Path $UnpackedRoot "Knorvia.exe"))) {
    throw "Desktop packager did not create $UnpackedRoot\Knorvia.exe"
}
if (Test-Path $DesktopPortableRoot) {
    $ResolvedRelease = (Resolve-Path $ReleaseRoot).Path
    $ResolvedTarget = (Resolve-Path $DesktopPortableRoot).Path
    if ((Split-Path -Parent $ResolvedTarget) -ne $ResolvedRelease) {
        throw "Refusing to replace unexpected portable target: $ResolvedTarget"
    }
    try {
        Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force -ErrorAction Stop
    } catch {
        # A running portable copy may still be writing Next.js cache files. Keep
        # that copy recoverable and let the newly packaged folder take its place.
        $BackupName = "Knorvia-$VersionLabel-portable.previous-$(Get-Date -Format 'yyyyMMddHHmmss')"
        $BackupPath = Join-Path $ResolvedRelease $BackupName
        Move-Item -LiteralPath $ResolvedTarget -Destination $BackupPath
        Write-Warning "The previous portable copy was in use and was retained at $BackupPath"
    }
}
Move-Item -LiteralPath $UnpackedRoot -Destination $DesktopPortableRoot
Set-Content -LiteralPath (Join-Path $DesktopPortableRoot "portable.marker") -Value "Knorvia portable data stays beside this folder." -Encoding utf8

$InstallerName = "Knorvia-$VersionLabel-setup.exe"
$InstallerPath = Join-Path $ReleaseRoot $InstallerName
$PortableZipName = "Knorvia-$VersionLabel-portable.zip"
$PortableZipPath = Join-Path $ReleaseRoot $PortableZipName
if (Test-Path -LiteralPath $PortableZipPath) {
    Remove-Item -LiteralPath $PortableZipPath -Force
}
Write-Host "Creating portable archive: $PortableZipPath"
Compress-Archive -LiteralPath $DesktopPortableRoot -DestinationPath $PortableZipPath -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $PortableZipPath)) {
    throw "Portable archive was not created: $PortableZipPath"
}

$ChecksumName = "Knorvia-$VersionLabel-SHA256SUMS.txt"
$ChecksumPath = Join-Path $ReleaseRoot $ChecksumName
$ChecksumLines = @(
    "$(Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath | Select-Object -ExpandProperty Hash)  $InstallerName",
    "$(Get-FileHash -Algorithm SHA256 -LiteralPath $PortableZipPath | Select-Object -ExpandProperty Hash)  $PortableZipName"
)
Set-Content -LiteralPath $ChecksumPath -Value $ChecksumLines -Encoding ascii

& $PythonExePath (Join-Path $PSScriptRoot "release\check_package.py") $ReleaseRoot $VersionLabel
if ($LASTEXITCODE -ne 0) { throw "Packaged runtime acceptance failed with exit code $LASTEXITCODE" }

Write-Host "Done. Portable folder: $DesktopPortableRoot"
Write-Host "Installer: $ReleaseRoot\$InstallerName"
Write-Host "Portable zip: $PortableZipPath"
Write-Host "SHA-256 manifest: $ChecksumPath"
