# Deploy to Cloudflare Pages + R2

```
GitHub repo (F:\chord\)         Cloudflare R2  (chord-images)
   ├ src/                          70k WebP files (~2.5 GB)
   ├ public/songs.bin (~1.4 MB)
   ├ functions/images/[[path]].ts  ← Pages Function: proxies R2 same-origin
   ├ scripts/
   └ ...
        │                                │
        ▼                                ▼
   Cloudflare Pages          (no public bucket URL needed)
   chord.you.com                    │
        │                            │
        └──── <img src="/images/{name}.webp"> ──→ Pages Function ──→ R2 ──┘
```

Images are proxied through the Pages Function `functions/images/[[path]].ts`
so the browser sees them as same-origin. That avoids cross-origin opaque
responses (and Chrome's 1-7 MB-per-entry "side-channel padding" tax that
would make the 70k offline cache balloon from ~3 GB to ~500 GB).

## Privacy reality check

`songs.bin` is an XOR+gzip-obfuscated copy of the song titles dataset.
It's downloaded by the browser to power search, so anyone who reverse-
engineers the bundle can decode it. The obfuscation only stops trivial
`curl | jq` scraping. Three levels, easy → hard:

1. **Public (default)** — anyone can curl `chord.you.com/songs.bin`.
2. **Hotlink protection** — Cloudflare WAF rule blocking requests whose
   Referer isn't your own domain. Stops bots + embeds. ~5 min to set up.
3. **Auth-gated Worker** — replace `songs.bin` with a Worker endpoint
   that verifies a Firebase ID token before responding.

Recommended: start with Public, add Hotlink protection if needed.

---

## Step 1 — Prepare the Git repo

The repo root is `F:\chord\`. Bulk data (`data/`, `images/`, `logs/`) is
gitignored — only the webapp + the obfuscated `public/songs.bin` is
committed.

```powershell
cd F:\chord
npm run data                 # build public/songs.bin from data/results.json
git init -b main
git add .
git commit -m "Initial commit: Chord webapp"

# Create a private repo on GitHub then:
git remote add origin git@github.com:<you>/chord.git
git push -u origin main
```

`.env.local` is gitignored — Firebase keys + R2 credentials never leave
your machine. You'll set them again as Pages env vars below.

---

## Step 2 — Connect Cloudflare Pages

1. **Workers & Pages → Create application → Pages → Connect to Git** → pick
   your repo.
2. Build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output:** `dist`
   - **Root directory:** blank
3. **Environment variables** (Production + Preview):
   ```
   VITE_FIREBASE_API_KEY        AIza...
   VITE_FIREBASE_AUTH_DOMAIN    chord-1a556.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID     chord-1a556
   VITE_FIREBASE_APP_ID         1:...
   VITE_FIREBASE_DB_URL         https://chord-1a556-default-rtdb.asia-southeast1.firebasedatabase.app
   ```
   **Do NOT set `VITE_IMAGE_BASE`** — leave it unset. `src/lib/imageUrl.ts`
   defaults to `/images`, which is the same-origin path served by the
   Pages Function. If you set a CDN URL here, the cross-origin opaque-
   padding tax comes back.
4. Save & deploy. First build takes 1–2 minutes.

The site is live at `https://<project>.pages.dev`. Bind a custom domain
under **Custom domains** when ready.

---

## Step 3 — Create the R2 bucket + Pages binding

1. **R2 → Create bucket** → name it `chord-images`.
2. **Pages project → Settings → Functions → R2 bucket bindings →
   Add binding**:
   - **Variable name:** `IMAGES`
   - **R2 bucket:** `chord-images`
3. (Optional, for dev only) R2 bucket → Settings → **Public Development
   URL** → enable. Copy that URL into `.env.local` as `VITE_IMAGE_BASE`
   so local dev hits R2 directly (no Pages Function locally).
   - The bucket's CORS Policy needs `AllowedOrigins: ["*"]` for the public
     dev URL to honour preflight on dev origins.

The Pages Function reads from the `IMAGES` binding directly (no HTTP
request to R2), so no R2 custom domain or public URL is needed for
production.

---

## Step 4 — Convert PNGs to WebP + upload to R2

The full data pipeline lives in `scripts/`. Each step is resumable —
Ctrl-C anytime, re-run, nothing is repeated.

### One-time setup

```powershell
pip install boto3                              # for upload_r2.py
# Download cwebp from https://developers.google.com/speed/webp/download
# Unzip, place cwebp.exe on PATH, OR set $env:CWEBP to its full path.
```

Add R2 credentials to `.env.local` (Python scripts auto-load it via
`scripts/_env.py`):

```
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
```

Get them from **R2 → Manage R2 API Tokens → Create API Token**
(Object Read & Write scoped to `chord-images`).

### Run the pipeline

```powershell
# Already have PNGs in F:\chord\images? Convert in place (deletes
# the source PNG after each successful encode):
py F:\chord\scripts\convert_to_webp.py

# Upload + rebuild songs.bin + git push in one shot:
F:\chord\scripts\pipeline.ps1
```

`pipeline.ps1` runs three steps:

1. `upload_r2.py F:\chord\images` — only uploads new files
2. `npm run data` — rebuilds `public/songs.bin`
3. `git add … && git commit && git push` — Cloudflare Pages auto-deploys
   within ~60 seconds

Flags: `-SkipUpload`, `-SkipBuild`, `-SkipPush`, `-DryRun`, `-Message`.

---

## Step 5 — Adding new songs later

```powershell
py F:\chord\scripts\scrape.py --start <X> --end <Y>   # new pages → results.json
py F:\chord\scripts\download.py                       # new PNGs into images/
py F:\chord\scripts\sync_names.py                     # rectify alt ↔ filename (PNG stage)
py F:\chord\scripts\convert_to_webp.py                # PNGs → WebPs in place, delete PNG
F:\chord\scripts\pipeline.ps1 -Message "data: add songs <X>..<Y>"
```

Each step skips work that's already done, so re-running after a Ctrl-C
just picks up where it left off.

---

## Audit / sanity scripts

| Script | Purpose |
|---|---|
| `scripts/scan_weird_chars.py` | Scan `data/results.json` for invisible control / format chars in titles. Run after a fresh scrape. |

---

## What lives where

| Item | Location | In Git? | Notes |
|---|---|---|---|
| Webapp source | `src/` | yes | |
| Pages Function (R2 proxy) | `functions/images/[[path]].ts` | yes | Reads R2 via `IMAGES` binding |
| Songs payload | `public/songs.bin` | yes | XOR+gzip, ~1.4 MB; rebuild with `npm run data` |
| Raw scraped JSON | `data/results.json` | **no** | source of truth, stays local |
| Image files | `images/` | **no** | WebP, uploaded to R2 separately |
| Python scripts | `scripts/` | yes | committed alongside webapp |
| Shared helpers | `scripts/_env.py`, `scripts/_r2.py` | yes | env loader + R2 client factory |
| Credentials | `.env.local` | **no** | R2 + Firebase, re-enter as Pages env vars |
