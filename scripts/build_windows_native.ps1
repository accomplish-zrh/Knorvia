param(
    [Parameter(Mandatory = $true)][string]$RuntimeSource,
    [switch]$SkipWebBuild,
    # Optional separate output root for night-shift/CI staging. When set, the
    # portable copy, checksums, and installer land under this directory instead
    # of the product release\ folder. All existing protections (version source
    # agreement, refuse-to-overwrite, safe staging) still apply inside it.
    [string]$OutputRoot = '',
    # Optional previously verified Electron distribution for isolated/offline builds.
    [string]$ElectronDist = '',
    # An explicit FFmpeg distribution keeps packaged media independent of PATH.
    [Parameter(Mandatory = $true)][string]$MediaToolsSource,
    # Locked, already installed HyperFrames runtime. Never runs npm at packaging time.
    [string]$HyperframesSource = ''
)

$ErrorActionPreference = 'Stop'
if ($ElectronDist -and -not $OutputRoot) { throw 'ElectronDist requires an isolated OutputRoot.' }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebRoot = Join-Path $ProjectRoot 'web'
$DesktopRoot = Join-Path $ProjectRoot 'desktop'
$Version = (Get-Content -LiteralPath (Join-Path $DesktopRoot 'package.json') -Raw | ConvertFrom-Json).version
$SourceVersion = [regex]::Match([IO.File]::ReadAllText((Join-Path $ProjectRoot 'knorvia\__version__.py')), '__version__\s*=\s*"([^"]+)"').Groups[1].Value
if ($Version -ne $SourceVersion) { throw 'Desktop and source versions must agree.' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'This builder requires a release version without a prerelease suffix.' }

$Source = (Resolve-Path -LiteralPath $RuntimeSource).Path
$MediaSource = (Resolve-Path -LiteralPath $MediaToolsSource).Path
foreach ($MediaFile in @('bin\ffmpeg.exe', 'bin\ffprobe.exe', 'LICENSE.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $MediaSource $MediaFile) -PathType Leaf)) { throw "Missing media dependency: $MediaFile" }
}
node (Join-Path $PSScriptRoot 'verify_desktop_package.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop package dependency validation failed.' }
$NativeBinaries = @('knorvia.exe', 'knorvia-daemon.exe', 'knorvia-pack-worker.exe', 'knorvia-kernel-appserver.exe')
foreach ($Binary in $NativeBinaries) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source "bin\$Binary"))) { throw "Missing native runtime component: $Binary" }
}

if (-not $SkipWebBuild) {
    Push-Location $WebRoot
    try {
        $env:KNORVIA_NEXT_DIST_DIR = '.next-knorvia'
        $env:NEXT_PUBLIC_API_BASE = '__NEXT_PUBLIC_API_BASE_PLACEHOLDER__'
        $env:NEXT_PUBLIC_AUTH_ENABLED = '__NEXT_PUBLIC_AUTH_ENABLED_PLACEHOLDER__'
        node scripts/build_en_overrides.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Locale generation failed.' }
        node node_modules/next/dist/bin/next build --webpack
        if ($LASTEXITCODE -ne 0) { throw 'Production interface build failed.' }
    } finally { Pop-Location }
}

$Standalone = Join-Path $WebRoot '.next-knorvia\standalone'
if (-not (Test-Path -LiteralPath (Join-Path $Standalone '.next-knorvia\required-server-files.json'))) { throw 'Build the standalone interface before packaging.' }
$Runtime = Join-Path $ProjectRoot "dist\Knorvia-$Version-portable\runtime"
if ($OutputRoot) {
    $BuildOutput = Join-Path $OutputRoot "windows-$Version"
    $ReleaseRoot = $OutputRoot
    $Runtime = Join-Path $OutputRoot 'runtime-staging'
} else {
    $BuildOutput = Join-Path $ProjectRoot "release-pack\windows-$Version"
    $ReleaseRoot = Join-Path $ProjectRoot 'release'
}
$Portable = Join-Path $ReleaseRoot "Knorvia-$Version-portable"
if (Test-Path -LiteralPath $Portable) { throw "A portable release already exists at $Portable. Keep that release safe and choose a fresh release directory." }

# Only the generated runtime staging directory is replaceable. Portable copies
# can contain user data and are never removed by this builder.
if (Test-Path -LiteralPath $Runtime) {
    if ($OutputRoot) { throw "Isolated runtime staging already exists at $Runtime. Choose a fresh output directory." }
    $Resolved = (Resolve-Path -LiteralPath $Runtime).Path
    $AllowedParent = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "dist\Knorvia-$Version-portable"))
    if ((Split-Path -Parent $Resolved) -ne $AllowedParent -or $Resolved -eq $Source) { throw "Unsafe staging target: $Resolved" }
    Remove-Item -LiteralPath $Resolved -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'bin'), (Join-Path $Runtime 'node'), $BuildOutput, $ReleaseRoot | Out-Null
foreach ($Binary in $NativeBinaries) { Copy-Item -LiteralPath (Join-Path $Source "bin\$Binary") -Destination (Join-Path $Runtime "bin\$Binary") }
$MediaBinaries = @(Get-ChildItem -LiteralPath (Join-Path $MediaSource 'bin') -File | Where-Object { $_.Extension -eq '.dll' -or $_.Name -in @('ffmpeg.exe', 'ffprobe.exe') })
foreach ($MediaBinary in $MediaBinaries) { Copy-Item -LiteralPath $MediaBinary.FullName -Destination (Join-Path $Runtime "bin\$($MediaBinary.Name)") }
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'licenses\ffmpeg') | Out-Null
Copy-Item -LiteralPath (Join-Path $MediaSource 'LICENSE.txt') -Destination (Join-Path $Runtime 'licenses\ffmpeg\LICENSE.txt')
foreach ($Notice in @('SOURCE.json', 'NOTICE.md')) {
    if (Test-Path -LiteralPath (Join-Path $MediaSource $Notice)) { Copy-Item -LiteralPath (Join-Path $MediaSource $Notice) -Destination (Join-Path $Runtime "licenses\ffmpeg\$Notice") }
}
Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $Runtime 'node\node.exe')
if ($HyperframesSource) {
    $HyperSource = (Resolve-Path -LiteralPath $HyperframesSource).Path
    $HyperModules = Join-Path $HyperSource 'node_modules'
    foreach ($RequiredHyperFile in @('package-lock.json', 'node_modules\hyperframes\bin\hyperframes.mjs', 'node_modules\gsap\dist\gsap.min.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $HyperSource $RequiredHyperFile) -PathType Leaf)) { throw "Missing HyperFrames dependency: $RequiredHyperFile" }
    }
    $HyperTarget = Join-Path $Runtime 'hyperframes'
    New-Item -ItemType Directory -Force -Path $HyperTarget | Out-Null
    Copy-Item -LiteralPath (Join-Path $HyperSource 'package.json'), (Join-Path $HyperSource 'package-lock.json') -Destination $HyperTarget
    if (Test-Path -LiteralPath (Join-Path $HyperSource 'licenses')) { Copy-Item -LiteralPath (Join-Path $HyperSource 'licenses') -Destination (Join-Path $HyperTarget 'licenses') -Recurse }
    $OmittedHyperDirs = @('darwin', 'linux', 'win32\arm64') | ForEach-Object { Join-Path $HyperModules "onnxruntime-node\bin\napi-v3\$_" }
    & robocopy $HyperModules (Join-Path $HyperTarget 'node_modules') /E /NFL /NDL /NJH /NJS /NP /XD @OmittedHyperDirs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'HyperFrames runtime copy failed.' }
}
Copy-Item -LiteralPath $Standalone -Destination (Join-Path $Runtime 'web') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'web\.next-knorvia\static'), (Join-Path $Runtime 'web\public') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $WebRoot '.next-knorvia\static') -Force | Copy-Item -Destination (Join-Path $Runtime 'web\.next-knorvia\static') -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $WebRoot 'public') -Force | Copy-Item -Destination (Join-Path $Runtime 'web\public') -Recurse -Force

$Checksums = [ordered]@{}
foreach ($Binary in $NativeBinaries) { $Checksums["bin/$Binary"] = (Get-FileHash -LiteralPath (Join-Path $Runtime "bin\$Binary") -Algorithm SHA256).Hash }
foreach ($MediaBinary in $MediaBinaries) { $Checksums["bin/$($MediaBinary.Name)"] = (Get-FileHash -LiteralPath (Join-Path $Runtime "bin\$($MediaBinary.Name)") -Algorithm SHA256).Hash }
$Manifest = [ordered]@{ product = 'Knorvia'; version = $Version; runtime = 'native'; renderer = 'web'; components = $Checksums }
[IO.File]::WriteAllText((Join-Path $Runtime 'manifest.json'), ($Manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

Push-Location $DesktopRoot
try {
    node prepare-terminal.js
    if ($LASTEXITCODE -ne 0) { throw 'Terminal dependency preparation failed.' }
    node --check main.js
    if ($LASTEXITCODE -ne 0) { throw 'Desktop syntax validation failed.' }
    # The native layout is still staged under the versioned extraResources path
    # from desktop/package.json. No source paths or provider keys are packaged.
    if ($OutputRoot) {
        $IsolatedConfig = (Get-Content -LiteralPath (Join-Path $DesktopRoot 'package.json') -Raw | ConvertFrom-Json).build
        $IsolatedConfig.directories.output = [IO.Path]::GetFullPath($BuildOutput)
        if ($ElectronDist) { $IsolatedConfig | Add-Member -NotePropertyName electronDist -NotePropertyValue (Resolve-Path -LiteralPath $ElectronDist).Path -Force }
        foreach ($Resource in $IsolatedConfig.extraResources) {
            if ($Resource.to -eq 'runtime') { $Resource.from = [IO.Path]::GetFullPath($Runtime) }
        }
        $IsolatedConfigPath = Join-Path $OutputRoot 'electron-builder.isolated.json'
        [IO.File]::WriteAllText($IsolatedConfigPath, ($IsolatedConfig | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        node node_modules/electron-builder/cli.js --win nsis --x64 "--config=$IsolatedConfigPath"
    } else {
        node node_modules/electron-builder/cli.js --win nsis --x64 "--config.directories.output=$BuildOutput"
    }
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer packaging failed.' }
} finally { Pop-Location }

$Unpacked = Join-Path $BuildOutput 'win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $Unpacked 'Knorvia.exe'))) { throw 'Packager did not produce Knorvia.exe.' }
Copy-Item -LiteralPath $Unpacked -Destination $Portable -Recurse
[IO.File]::WriteAllText((Join-Path $Portable 'portable.marker'), 'Knorvia portable data stays beside this folder.')
$InstallerName = "Knorvia-$Version-setup.exe"
Copy-Item -LiteralPath (Join-Path $BuildOutput $InstallerName) -Destination (Join-Path $ReleaseRoot $InstallerName)
$Blockmap = Join-Path $BuildOutput "$InstallerName.blockmap"
if (Test-Path -LiteralPath $Blockmap) { Copy-Item -LiteralPath $Blockmap -Destination $ReleaseRoot }
$ZipName = "Knorvia-$Version-portable.zip"
Compress-Archive -LiteralPath $Portable -DestinationPath (Join-Path $ReleaseRoot $ZipName) -CompressionLevel Optimal -Force
$DigestLines = @($InstallerName, $ZipName) | ForEach-Object { "$( (Get-FileHash -LiteralPath (Join-Path $ReleaseRoot $_) -Algorithm SHA256).Hash )  $_" }
Set-Content -LiteralPath (Join-Path $ReleaseRoot "Knorvia-$Version-SHA256SUMS.txt") -Value $DigestLines -Encoding ascii
Write-Host "Installer: $(Join-Path $ReleaseRoot $InstallerName)"
Write-Host "Portable: $(Join-Path $ReleaseRoot $ZipName)"
