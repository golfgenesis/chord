# Deploy to Cloudflare Pages + R2

```
GitHub repo (F:\chord\)         Cloudflare R2  (chord-images)
   ├ src/                          70k WebP files (~2.5 GB)
   ├ public/songs.bin (~1.4 MB)         │   bound to custom domain
   ├ scripts/                            │   img.yourdomain.com
   └ ...                                 │   (Snippet adds CORS)
        │                                │
        ▼                                ▼
   Cloudflare Pages              R2 Custom Domain
   chord.you.com                 img.you.com
        │                            │
        └──── <img src="https://img.you.com/{name}.webp"> ──→ R2 edge ──┘
```

Images are served from the R2 Custom Domain directly. A Response
Header Transform Rule at that hostname adds
`Access-Control-Allow-Origin: *` so the browser treats responses as
"cors" (not opaque) — avoids Chrome's 1-7 MB-per-entry padding tax
that would balloon the offline cache from ~3 GB to ~500 GB. Traffic
hits R2 at the edge directly with no JS execution in the hot path.

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
   VITE_IMAGE_BASE              https://img.yourdomain.com
   ```
   `VITE_IMAGE_BASE` must point at the R2 Custom Domain you'll set up
   in Step 3. The Snippet attached at that hostname returns CORS
   headers so the browser can `cache.put()` non-opaque responses.
4. Save & deploy. First build takes 1–2 minutes.

The site is live at `https://<project>.pages.dev`. Bind a custom domain
under **Custom domains** when ready.

---

## Step 3 — Create the R2 bucket + Custom Domain + CORS Snippet

1. **R2 → Create bucket** → name it `chord-images`.

2. **R2 → chord-images → Settings → Custom Domains → Connect Domain**.
   Enter the subdomain you want to serve images from, e.g.
   `img.yourdomain.com`. Cloudflare auto-creates the CNAME and the
   bucket starts answering on that hostname.

3. **Add CORS headers.** Three options (any one is enough):

   **Option 0 — Bucket CORS Policy (simplest)**:
   R2 → bucket → Settings → CORS Policy → Edit. Paste a JSON array
   listing your dev + prod origins (R2 does NOT support wildcards
   here, so each origin must be listed):
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:5173", "https://yourdomain.com"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   The policy applies to both pub-URL and Custom Domain. Downside: you
   must maintain the origin list as you add deploys / domains.

   **Option A — Transform Rules (Free plan, wildcard `*`)**:
   Dashboard → zone → Rules → Transform Rules → **Modify Response
   Header** → Create rule.
   - Filter: `(http.host eq "img.yourdomain.com")`
   - Actions (Set static, four of them):
     | Header | Value |
     |---|---|
     | `Access-Control-Allow-Origin` | `*` |
     | `Access-Control-Expose-Headers` | `ETag, Content-Length, Content-Type` |
     | `Cross-Origin-Resource-Policy` | `cross-origin` |
     | `Vary` | `Origin` |

   **Option B — Snippets (Pro+ plans)**:
   Dashboard → zone → Rules → Snippets → Create Snippet
   `r2-images-cors`. Matcher: `http.host eq "img.yourdomain.com"`.
   ```js
   export default {
     async fetch(request) {
       if (request.method === "OPTIONS") {
         return new Response(null, {
           status: 204,
           headers: {
             "Access-Control-Allow-Origin": "*",
             "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
             "Access-Control-Allow-Headers": "*",
             "Access-Control-Max-Age": "86400",
           },
         });
       }
       const upstream = await fetch(request);
       const headers = new Headers(upstream.headers);
       headers.set("Access-Control-Allow-Origin", "*");
       headers.set("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type");
       headers.set("Cross-Origin-Resource-Policy", "cross-origin");
       headers.set("Vary", "Origin");
       return new Response(upstream.body, {
         status: upstream.status,
         statusText: upstream.statusText,
         headers,
       });
     },
   };
   ```
   Use the Snippet if you ever add credentialed/custom-header fetches —
   it can handle OPTIONS preflight; Transform Rules can't.

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
| Songs payload | `public/songs.bin` | yes | XOR+gzip, ~1.4 MB; rebuild with `npm run data` |
| Raw scraped JSON | `data/results.json` | **no** | source of truth, stays local |
| Image files | `images/` | **no** | WebP, uploaded to R2 separately |
| Python scripts | `scripts/` | yes | committed alongside webapp |
| Shared helpers | `scripts/_env.py`, `scripts/_r2.py` | yes | env loader + R2 client factory |
| Credentials | `.env.local` | **no** | R2 + Firebase, re-enter as Pages env vars |
