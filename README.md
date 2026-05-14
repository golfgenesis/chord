# Chord

A fast, dark-mode PWA for searching, viewing, and sharing chord sheets
with your band in real time — built on top of a 70k-song chord-image
dataset scraped from chordtabs.in.th.

Target devices: **iPad** (singer's main view) and **mobile** (other band
members watching the singer's pick).

## Highlights

- Search across all 70k songs in real time (in-memory linear scan, ~10–30 ms)
- Tap a song → fullscreen chord image; service worker caches images for
  offline use; a one-tap "Download all" button pre-caches the entire
  dataset (~2.5 GB) for travelling-without-Wi-Fi rehearsals
- **Realtime room sync** via Firebase RTDB: 6-digit room code, when one
  device taps a song the rest see it (with optional auto-open + OS push
  notification, deep-linkable URL `/{room}/{songId}`)
- **Per-client playlists**: every member's lists are merged into one
  picker, owner-first; edits/reorder/delete are gated to your own lists
- Latest (auto, FIFO), Favorites (★), multiple Playlists with drag-and-
  drop reorder, persisted offline in IndexedDB (`idb-keyval`)
- Virtualized list (`react-virtuoso`) — 70k rows scroll smoothly on iOS
- Installable on iPad/iPhone home screen (PWA manifest + Apple meta tags)

## Stack

- Vite 8 + React 19 + TypeScript
- Tailwind CSS 3 (dark mode)
- Zustand for state, react-virtuoso for the virtual list
- Firebase Realtime DB (room sync) + Firestore (per-client cross-device sync)
- vite-plugin-pwa (custom SW under `injectManifest`)
- idb-keyval for persisted favorites/playlists/latest
- Cloudflare Pages Functions + R2 (image hosting, see DEPLOY.md)

## Get started

```powershell
cd F:\chord
npm install
npm run dev          # rebuilds public/songs.bin, then starts Vite on :5173
```

Open `http://localhost:5173` on your PC, or the LAN URL Vite prints
(e.g. `http://192.168.0.174:5173`) on the iPad. Both devices need to be
on the same Wi-Fi for the LAN URL.

Production:

```powershell
npm run build          # tsc + Vite build → dist/
npm run preview        # serve dist/ for smoke testing
```

## How rooms work

- Every device generates and persists a 6-digit room code.
- Devices using the **same code** see each other's selections.
- Tap the room code in the toolbar to edit it, or the refresh icon to
  randomize.
- When a band member taps a song, others auto-open the chord sheet (or
  just get a notification if they turned auto-open off).
- The first device into a fresh room becomes the **owner**; others are
  **guests**. Both can create their own playlists; edits are gated to
  what you own.
- URLs are shareable: `/{roomCode}/{songId}` deep-links into the
  fullscreen view.

See `CLAUDE.md` for the full sync architecture (Firebase RTDB layout,
URL routing, picker view-state, etc.).

## Firebase setup

Without the env vars below the app falls back to a `BroadcastChannel`
mock that only syncs across tabs of the same browser — fine for UI
testing, useless for a real band.

1. Create a Firebase project at https://console.firebase.google.com
2. Add a Web app; copy the config snippet.
3. Enable **Realtime Database** (not Firestore... well, both — the per-
   client sync uses Firestore too; both are auto-provisioned).
4. RTDB security rules for `rooms/`:

   ```json
   {
     "rules": {
       "rooms": {
         "$code": {
           ".read": true,
           ".write": true,
           ".validate": "$code.matches(/^[0-9]{6}$/)"
         }
       }
     }
   }
   ```

5. Firestore rules for `clients/{clientId}`:

   ```
   match /clients/{clientId} {
     allow read, write: if true;
   }
   ```

   The app deliberately doesn't use Firebase Auth — `clientId` is a
   random 8-char string in localStorage, so the doc is keyed by a
   hard-to-guess ID rather than an authenticated user. See
   `src/lib/cloudSync.ts`.
6. Copy `.env.example` → `.env.local`; paste the config values.
7. Restart `npm run dev`.

## Project layout

```
F:\chord\
├── data\                            # source dataset (gitignored)
│   └── results.json                 # [{id, src, alt}, ...]
├── images\                          # WebP chord sheets (gitignored, ~2.5 GB)
├── logs\                            # script run logs (gitignored)
├── functions\
│   └── images\[[path]].ts           # Cloudflare Pages Function: R2 proxy
├── public\
│   ├── favicon.svg, icon.svg, robots.txt
│   ├── _redirects                   # SPA fallback for Pages
│   └── songs.bin                    # obfuscated dataset, committed
├── src\
│   ├── App.tsx, main.tsx
│   ├── store.ts                     # Zustand: state + persistence
│   ├── types.ts
│   ├── sw.ts                        # custom service worker
│   ├── components\                  # TopBar, NowPlaying, Tabs, SongList,
│   │                                # Fullscreen, PlaylistPicker, OfflineSheet,
│   │                                # RoomControls
│   ├── hooks\                       # useVisibleSongs, useRoomSongAlert
│   └── lib\                         # firebase, cloudSync, persist, search,
│                                    # songsCodec, imageUrl, offlineDownload
├── scripts\
│   ├── _env.py                      # loads .env.local into os.environ
│   ├── _r2.py                       # boto3 R2 client factory
│   ├── scrape.py                    # fetch chordtabs HTML → results.json
│   ├── download.py                  # PNG downloader (source format)
│   ├── sync_names.py                # rectify alt ↔ filename (PNG stage)
│   ├── convert_to_webp.py           # PNG → WebP in place, delete source
│   ├── upload_r2.py                 # bulk upload to R2 (resumable)
│   ├── scan_weird_chars.py          # spot invisible control chars in titles
│   ├── build-data.mjs               # results.json → public/songs.bin
│   └── pipeline.ps1                 # one-shot: upload + build + push
├── .env.example, .env.local (gitignored)
└── CLAUDE.md, DEPLOY.md, README.md
```

## Images

The image source files on disk are **WebP** (near-lossless q=80 — see
`scripts/convert_to_webp.py`). Original PNGs from chordtabs.in.th are
downloaded by `download.py` then replaced in place by the convert step.

| Environment | How images are served |
|---|---|
| **Dev** | Vite serves them via `imagesMiddleware` in `vite.config.ts` from `F:\chord\images` at `/images/*` (same origin). Or, set `VITE_IMAGE_BASE` to the R2 Public Development URL to hit R2 directly. |
| **Prod (Cloudflare Pages)** | The Pages Function at `functions/images/[[path]].ts` proxies R2 over the **same origin** as the app. No `VITE_IMAGE_BASE` needed — the default `/images/` path goes straight to the function. Same-origin avoids Chrome's "opaque-response padding" tax that would balloon the offline cache from ~3 GB to ~500 GB. |

The bucket needs an R2 binding wired up in Pages settings; see
`DEPLOY.md` for the click-by-click.

## Adding new songs

Full pipeline, each step resumable:

```powershell
py scripts\scrape.py --start 70570 --end 75000
py scripts\download.py
py scripts\sync_names.py            # PNG stage only — rectify alt ↔ filename
py scripts\convert_to_webp.py       # in-place PNG → WebP, deletes source PNG
scripts\pipeline.ps1 -Message "data: add songs 70570..75000"
```

`pipeline.ps1` runs: `upload_r2.py` → `npm run data` (rebuild
`public/songs.bin`) → `git commit && git push`. Cloudflare Pages
auto-deploys within ~60 s.

R2 credentials live in `.env.local`:

```
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
```

Python scripts auto-load these via `scripts/_env.py` — no need to
re-export `$env:R2_*` every shell session.

## Install on iPad

1. Open the LAN URL (or production URL) in Safari.
2. Share menu → "Add to Home Screen".
3. Launch from the icon — fullscreen, dark UI, no Safari chrome.

PWA install also unlocks **persistent storage** on iOS, which is what
keeps the 70k-image offline cache from being evicted when iOS runs low
on disk.

## Data pipeline details

All scripts compute paths relative to `PROJECT_ROOT` (the parent of
`scripts/`), so the whole folder can be moved without code changes.

### Dataset shape (results.json)

```json
{ "id": 1, "src": "https://chordtabs.in.th/img/nm/c0000101.png",
  "alt": "คอร์ด คำสาป Playground" }
```

`build-data.mjs` slims this down to `{id, name}` (strips the prefix +
sanitises the filename), then XOR+gzip-obfuscates it as
`public/songs.bin`. The image URL is reconstructed at runtime via
`src/lib/imageUrl.ts` (`${BASE}/${encodeURIComponent(name)}.webp`).

### Filename rule

- Strip the `"คอร์ด "` prefix from `alt`
- Sanitize Windows-illegal chars (`< > : " / \ | ? *`) → `_`
- If the cleaned name collides case-insensitively with another record,
  append `_{id}` to disambiguate
- Extension is `.webp` (source on disk and on R2)

`sync_names.py` enforces this exact mapping between filenames and `alt`
fields — important to keep them in lockstep so the `imageUrl()` function
in JS can reconstruct the right URL.

### Counts

| | |
|---|---|
| Pages scraped (1..70569) | 70,569 |
| Records with a real image | 70,107 |
| WebP files on disk + R2 | 70,107 |
| Total image size (WebP @ q=80) | ~2.5 GB |
| Duplicate-name records | 2,162 (use `_{id}` suffix) |

### Python deps

```powershell
py -m pip install requests beautifulsoup4 lxml boto3 tqdm
```
