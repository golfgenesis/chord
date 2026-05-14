# One-command pipeline that takes locally-prepared WebP chord images all the
# way to production. Each step is independently resumable — Ctrl-C any time
# and re-run; nothing is repeated.
#
#   1. Upload F:\chord\images\ (WebP) to R2 (skip files already in the bucket)
#   2. Rebuild public/songs.bin from data/results.json
#   3. Commit + push so Cloudflare Pages redeploys
#
# R2 credentials are read from <project_root>/.env.local by the Python
# scripts (scripts/_env.py auto-loads it). No `$env:` setup needed here.
#
# Usage (PowerShell):
#
#     .\scripts\pipeline.ps1                                  # full run, default commit msg
#     .\scripts\pipeline.ps1 -Message "add 500 songs"
#     .\scripts\pipeline.ps1 -SkipUpload                      # only build + push
#     .\scripts\pipeline.ps1 -SkipPush                        # local only — upload + build
#     .\scripts\pipeline.ps1 -DryRun                          # show what would happen, run nothing

[CmdletBinding()]
param(
    [string]$Message = "data: refresh dataset",
    [switch]$SkipUpload,
    [switch]$SkipBuild,
    [switch]$SkipPush,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ImagesDir   = Join-Path $ProjectRoot "images"

function Write-Header($text) {
    Write-Host ""
    Write-Host ("==== {0} ====" -f $text) -ForegroundColor Cyan
}
function Write-Step($i, $total, $text) {
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}" -f $i, $total, $text) -ForegroundColor Yellow
}
function Write-Ok($text)   { Write-Host ("  OK  {0}" -f $text) -ForegroundColor Green }
function Write-Note($text) { Write-Host ("  --  {0}" -f $text) -ForegroundColor DarkGray }
function Write-Fail($text) { Write-Host ("  !!  {0}" -f $text) -ForegroundColor Red; exit 1 }

Write-Header "Chord pipeline"
if ($DryRun) { Write-Note "DRY RUN - nothing will actually change" }

# 1. Preflight ----------------------------------------------------------------
if (-not (Test-Path $ImagesDir)) {
    Write-Fail ("Source images folder not found: {0}" -f $ImagesDir)
}

# ── Step 1: Upload to R2 ------------------------------------------------------
if ($SkipUpload) {
    Write-Step 1 3 "Upload images -> R2"
    Write-Note "skipped (-SkipUpload)"
} else {
    Write-Step 1 3 "Upload images -> R2"
    # upload_r2.py auto-loads R2_ACCESS_KEY / R2_SECRET_KEY from .env.local
    # via scripts/_env.py — no need to re-export them here.
    # Use `py` (Windows Python launcher) which ships with every Python
    # install; `python` is only on PATH if the user explicitly checked
    # "Add Python to PATH" during install and isn't guaranteed.
    $pythonCmd = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } else { "py" }
    if ($DryRun) {
        Write-Note ("would run: {0} scripts/upload_r2.py {1}" -f $pythonCmd, $ImagesDir)
    } else {
        & $pythonCmd (Join-Path $PSScriptRoot "upload_r2.py") $ImagesDir
        if ($LASTEXITCODE -ne 0) { Write-Fail "upload_r2.py failed" }
        Write-Ok "images synced to R2 bucket chord-images"
    }
}

# ── Step 2: Rebuild songs.bin -------------------------------------------------
if ($SkipBuild) {
    Write-Step 2 3 "Rebuild songs.bin"
    Write-Note "skipped (-SkipBuild)"
} else {
    Write-Step 2 3 "Rebuild songs.bin"
    if ($DryRun) {
        Write-Note ("would run: npm run data  (in {0})" -f $ProjectRoot)
    } else {
        Push-Location $ProjectRoot
        try {
            & npm run data
            if ($LASTEXITCODE -ne 0) { Write-Fail "npm run data failed" }
            Write-Ok "public/songs.bin rebuilt"
        } finally { Pop-Location }
    }
}

# ── Step 3: Git commit + push -------------------------------------------------
if ($SkipPush) {
    Write-Step 3 3 "Git commit + push"
    Write-Note "skipped (-SkipPush)"
} else {
    Write-Step 3 3 "Git commit + push"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Fail "git not on PATH"
    }
    Push-Location $ProjectRoot
    try {
        if ($DryRun) {
            git status --short
            Write-Note ("would: git add public/songs.bin; git commit -m '{0}'; git push" -f $Message)
        } else {
            git add public/songs.bin
            git diff --cached --quiet
            if ($LASTEXITCODE -eq 0) {
                Write-Note "no changes to commit (songs.bin unchanged)"
            } else {
                git commit -m $Message
                if ($LASTEXITCODE -ne 0) { Write-Fail "git commit failed" }
                git push
                if ($LASTEXITCODE -ne 0) { Write-Fail "git push failed" }
                Write-Ok ("pushed: {0}" -f $Message)
            }
        }
    } finally { Pop-Location }
}

Write-Header "Pipeline done"
if (-not $SkipPush -and -not $DryRun) {
    Write-Note "Cloudflare Pages will redeploy in ~60s."
}
