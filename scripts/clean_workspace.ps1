[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$IncludeDependencies
)

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$targets = @(
    # release contains verified deliverables and evidence, not disposable cache.
    "build", "dist", "knorvia_web", "web/.next", "web/.next-knorvia",
    "web/dist", "web/playwright-report", "web/test-results", "pytest_py_tmp",
    ".pytest_cache", ".ruff_cache", ".coverage", "coverage.xml", "htmlcov",
    # setuptools wheel-build metadata and leftover pytest scratch output
    "knorvia.egg-info", ".pytest-tmp-out.txt", ".cleanup-elevated.log"
)
$targets += Get-ChildItem -LiteralPath $workspace -Force |
    Where-Object { $_.Name -match '^\.(final|fix-root|root|tmp|pytest-tmp)' } |
    ForEach-Object { $_.Name }

if ($IncludeDependencies) {
    $targets += @(".venv", "web/node_modules", "desktop/node_modules", "web/director-desk-src/node_modules")
}

# Robocopy mirror against an empty directory reliably clears trees whose
# paths exceed the legacy 260-char MAX_PATH limit, where PowerShell 5.1's
# Remove-Item fails with misleading errors ("path not found", "access denied").
function Remove-Tree([string]$Path) {
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        return $true
    }
    catch [IO.DirectoryNotFoundException], [IO.PathTooLongException], [UnauthorizedAccessException] {
        return (Remove-TreeRobocopy -Path $Path)
    }
    catch {
        # Long-path failures surface as generic IO errors too; always try the
        # fallback before giving up.
        return (Remove-TreeRobocopy -Path $Path)
    }
}

function Remove-TreeRobocopy([string]$Path) {
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("knorvia-clean-" + [guid]::NewGuid().ToString("N"))
    try {
        New-Item -ItemType Directory -Path $scratch | Out-Null
        # robocopy exit codes 0-7 mean success; >=8 means real failures.
        robocopy $scratch $Path /MIR /NFL /NDL /NJH /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -ge 8) { return $false }
        cmd /c "rmdir /s /q `"$Path`"" 2>$null
        return -not (Test-Path -LiteralPath $Path)
    }
    finally {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$failures = @()
foreach ($relative in $targets | Sort-Object -Unique) {
    $candidate = Join-Path $workspace $relative
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $prefix = $workspace.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside workspace: $resolved"
    }
    if ($PSCmdlet.ShouldProcess($resolved, "Remove generated workspace artifact")) {
        if (-not (Remove-Tree -Path $resolved)) {
            $failures += $resolved
            Write-Warning "Could not remove generated artifact '$resolved'"
        }
    }
}

if ($failures.Count -gt 0) {
    throw "Workspace cleanup was incomplete. Close processes holding these paths or run from an elevated shell: $($failures -join ', ')"
}
