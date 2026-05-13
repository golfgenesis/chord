# Publishes whatever is currently in F:\chord\ to production:
#   1) Rebuilds public/songs.json from data/results.json
#   2) Commits and pushes the repo (Cloudflare Pages auto-deploys)
#   3) Uploads new images to R2 (rclone copy - skips files already there)
#
# Usage:
#   .\publish.ps1                       # full publish, default commit message
#   .\publish.ps1 -Message "add 500 new songs"
#   .\publish.ps1 -SkipImages           # only update JSON and push
#   .\publish.ps1 -SkipPush             # only upload images
#   .\publish.ps1 -DryRun               # show what would happen, do nothing

[CmdletBinding()]
param(
    [string]$Message = "data: refresh dataset",
    [switch]$SkipImages,
    [switch]$SkipPush,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataFile    = Join-Path $ProjectRoot "data\results.json"
$ImagesDir   = Join-Path $ProjectRoot "images"
$SongsJson   = Join-Path $ProjectRoot "public\songs.json"
$R2_REMOTE   = "r2:chord-images"

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

Write-Header "Chord publish"
if ($DryRun) { Write-Note "DRY RUN - nothing will actually change" }

# preflight
if (-not (Test-Path $DataFile))  { Write-Fail ("Missing {0}" -f $DataFile) }
if (-not $SkipImages -and -not (Test-Path $ImagesDir)) {
    Write-Fail ("Missing {0} (use -SkipImages to skip image upload)" -f $ImagesDir)
}
if (-not $SkipImages -and -not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Write-Note "rclone not installed - skipping image upload."
    Write-Note "Upload images manually via Cyberduck (drag F:\chord\images to bucket)."
    $SkipImages = $true
}
if (-not $SkipPush -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "git not installed"
}

# 1. rebuild songs.json
Write-Step 1 3 "Rebuilding songs.json"
if ($DryRun) {
    Write-Note ("would run: npm run data  (in {0})" -f $ProjectRoot)
} else {
    Push-Location $ProjectRoot
    try {
        $beforeSize = if (Test-Path $SongsJson) { (Get-Item $SongsJson).Length } else { 0 }
        npm run data
        if ($LASTEXITCODE -ne 0) { Write-Fail "npm run data failed" }
        $afterSize = (Get-Item $SongsJson).Length
        $beforeMB = [math]::Round($beforeSize / 1MB, 2)
        $afterMB  = [math]::Round($afterSize / 1MB, 2)
        if ($beforeSize -eq $afterSize) {
            Write-Ok ("songs.json unchanged ({0} MB)" -f $afterMB)
        } else {
            Write-Ok ("songs.json: {0} MB -> {1} MB" -f $beforeMB, $afterMB)
        }
    } finally { Pop-Location }
}

# 2. git commit and push
Write-Step 2 3 "Git commit and push"
if ($SkipPush) {
    Write-Note "skipped (-SkipPush)"
} else {
    Push-Location $ProjectRoot
    try {
        if ($DryRun) {
            git status --short
            Write-Note ("would: git add public/songs.json; git commit -m '{0}'; git push" -f $Message)
        } else {
            git add public/songs.json
            git diff --cached --quiet
            if ($LASTEXITCODE -eq 0) {
                Write-Note "no changes to commit"
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

# 3. rclone upload to R2
Write-Step 3 3 ("Upload images to R2 ({0})" -f $R2_REMOTE)
if ($SkipImages) {
    Write-Note "skipped (-SkipImages)"
} else {
    $imageCount = (Get-ChildItem $ImagesDir -File).Count
    $imageBytes = (Get-ChildItem $ImagesDir -File | Measure-Object Length -Sum).Sum
    $imageGB    = [math]::Round($imageBytes / 1GB, 2)
    Write-Note ("local: {0} files, {1} GB" -f $imageCount, $imageGB)

    $rcloneArgs = @(
        "copy", $ImagesDir, $R2_REMOTE,
        "--transfers", "16",
        "--checkers", "32",
        "--progress",
        "--header-upload", "Cache-Control: public, max-age=31536000, immutable"
    )
    if ($DryRun) { $rcloneArgs += "--dry-run" }

    & rclone @rcloneArgs
    if ($LASTEXITCODE -ne 0) { Write-Fail "rclone upload failed" }
    Write-Ok "rclone done (only new/changed files were uploaded)"
}

Write-Header "All done"
if (-not $SkipPush -and -not $DryRun) {
    Write-Note "Cloudflare Pages will redeploy in ~60s."
}
