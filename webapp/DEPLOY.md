# Deploy to Cloudflare Pages + R2

This webapp lives in a Git repo; images live in R2; everything stitches together
via env vars at build time.

```
GitHub repo (webapp/)         Cloudflare R2 (chord-images/)
   ├ src/                        70,107 PNG files
   ├ public/songs.json (~10MB)
   └ ...
        │                                │
        ▼                                ▼
   Cloudflare Pages           images.you.com (custom domain)
   chord.you.com                    │
        │                            │
        └──── <img src="${VITE_IMAGE_BASE}/{file}.png"> ───┘
```

## Privacy reality check

`songs.json` is downloaded by the browser to power search, so it's accessible
to anyone who can open the site. Three levels of protection, from easy to hard:

1. **Public (default)** — anyone can curl `chord.you.com/songs.json`.
2. **Hotlink protection** — Cloudflare WAF rule blocks requests whose Referer
   isn't your own domain. Stops bot scrapers and embeds. ~5 minutes to set up.
3. **Auth-gated Worker** — replace `songs.json` with a Worker endpoint that
   verifies a Firebase ID token before responding. Tighter but adds complexity.

Recommended: start with **Public**, layer on **Hotlink protection** if needed.

---

## Step 1 — Prepare the Git repo

The repo should contain only `F:\chord\webapp\`. The parent `data/`, `images/`,
and `scripts/` (Python) stay on your machine.

```powershell
cd F:\chord\webapp

# Rebuild songs.json from the source data so the committed copy is fresh.
npm run data

# Initialize Git.
git init -b main
git add .
git commit -m "Initial commit: ChordRoom webapp"
```

Create a new private repo on GitHub, then:

```powershell
git remote add origin git@github.com:<you>/chord-webapp.git
git push -u origin main
```

**Reminder**: `.env.local` is gitignored — your Firebase keys never leave your
machine. You'll set them as Pages env vars in step 2.

---

## Step 2 — Connect Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages** → **Create application** → Pages →
   **Connect to Git** → pick your repo.
2. Build settings:
   - **Framework preset**: Vite
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: leave blank if repo is the webapp itself; or set to
     `webapp` if you pushed the parent folder.
3. Environment variables (Production + Preview):
   ```
   VITE_IMAGE_BASE              https://images.you.com   (set after step 4)
   VITE_FIREBASE_API_KEY        AIza...
   VITE_FIREBASE_AUTH_DOMAIN    chord-1a556.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID     chord-1a556
   VITE_FIREBASE_APP_ID         1:...
   VITE_FIREBASE_DB_URL         https://chord-1a556-default-rtdb.asia-southeast1.firebasedatabase.app
   ```
4. Save & deploy. First build takes 1–2 minutes.

The site is live at `https://<project>.pages.dev`. Bind a custom domain
under **Custom domains** when ready (e.g., `chord.you.com`).

### Add Firebase auth domains

In **Firebase Console → Authentication → Settings → Authorized domains**, add:
- `<project>.pages.dev`
- `chord.you.com` (your custom domain)

Otherwise anonymous sign-in is blocked from the deployed site.

---

## Step 3 — Create the R2 bucket

1. Cloudflare Dashboard → **R2** → **Create bucket** → name it `chord-images`.
2. **Settings** tab → **Public access** → enable **Public access via custom
   domain** (don't use the `*.r2.dev` URL; it's rate-limited).
3. Click **Connect Domain** → pick `images.you.com` (must be a domain you
   already host on Cloudflare). DNS is wired up automatically.

---

## Step 4 — Upload the 70k images via rclone

Manual upload via the web UI will not scale. Use rclone.

### Install rclone (one-time)

```powershell
winget install rclone.rclone
```

### Get an R2 token

R2 dashboard → **Manage R2 API Tokens** → **Create API Token** → permission
**Object Read & Write** scoped to bucket `chord-images`. Copy:
- Access Key ID
- Secret Access Key
- The endpoint URL (looks like `https://<accountid>.r2.cloudflarestorage.com`)

### Configure rclone

```powershell
rclone config
# n) New remote
# name> r2
# Storage> s3
# provider> Cloudflare
# env_auth> false
# access_key_id> <paste>
# secret_access_key> <paste>
# region> auto
# endpoint> https://<accountid>.r2.cloudflarestorage.com
# (accept defaults for the rest)
```

### Upload

```powershell
rclone copy "F:\chord\images" r2:chord-images `
  --transfers 16 `
  --checkers 32 `
  --progress
```

About 70k files / 5GB. On a 100 Mbps upload it's ~10–15 minutes. rclone is
resumable — kill and re-run anytime; it skips files already there. After
incremental scrapes, just re-run the same command to upload new files only.

### Set cache headers (optional but recommended)

```powershell
rclone copy "F:\chord\images" r2:chord-images `
  --transfers 16 --checkers 32 --progress `
  --header-upload "Cache-Control: public, max-age=31536000, immutable"
```

Browsers will cache images for a year.

---

## Step 5 — (Optional) Hotlink protection

To block requests where the Referer isn't your site:

1. Cloudflare Dashboard → your domain → **Rules** → **Transform Rules** →
   **Modify Response Header**, or use **WAF → Custom rules**.
2. Add a rule on `images.you.com`:
   ```
   Field:    Referer
   Operator: does not start with
   Value:    https://chord.you.com
   Action:   Block
   ```
3. Also add an exception so direct browser opens still work if you want, or
   leave them blocked.

This blocks bots and embeds from other sites. Determined scrapers can fake
the Referer, but it stops the lazy 95%.

---

## Step 6 — Routine workflow

**New songs added (you scraped more pages):**

```powershell
# On your machine, the Python pipeline:
python F:\chord\scripts\scrape.py --start <X> --end <Y>
python F:\chord\scripts\download.py
python F:\chord\scripts\sync_names.py

# Rebuild the slim JSON, commit, push.
cd F:\chord\webapp
npm run data
git add public/songs.json
git commit -m "data: add songs <X>..<Y>"
git push

# Upload the new images.
rclone copy "F:\chord\images" r2:chord-images --transfers 16 --progress
```

Cloudflare Pages auto-builds and deploys within ~60 seconds of your push.

---

## What lives where

| Item | Location | In Git? | Notes |
|---|---|---|---|
| Webapp source | `F:\chord\webapp\src\` | yes | |
| Slim dataset | `webapp/public/songs.json` | yes | ~10MB, regenerate with `npm run data` |
| Raw scraped JSON | `F:\chord\data\results.json` | **no** | source of truth, stays local |
| Image files | `F:\chord\images\` | **no** | uploaded to R2 separately |
| Python scrape scripts | `F:\chord\scripts\` | **no** | stays local |
| Firebase credentials | `webapp/.env.local` | **no** | re-enter as Pages env vars |
