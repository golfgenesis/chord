# Chord

A fast, dark-mode PWA for searching, viewing, and sharing chord sheets with your band in real time — built on top of a 70k-song chord-image dataset scraped from chordtabs.in.th.

Target devices: **iPad** (singer's main view) and **mobile** (other band members watching the singer's pick).

## Highlights

- Search across all 70k songs in real time (no API; in-memory linear scan, ~10–30 ms)
- Tap a song → fullscreen chord image; PWA service worker caches images aggressively
- **Realtime room sync**: 6-digit room code, when one device taps a song the rest see it
- Latest (auto, FIFO max 30), Favorites (★), multiple Playlists
- Persisted offline in IndexedDB (`idb-keyval`)
- Virtualized list (`react-virtuoso`) — 70k rows scroll smoothly on mobile
- Installable on iPad/iPhone home screen (PWA manifest + Apple meta tags)

## Stack

- Vite 8 + React 19 + TypeScript
- Tailwind CSS 3 (dark mode)
- Zustand for state
- react-virtuoso for the virtual list
- Firebase Realtime Database for room sync (falls back to BroadcastChannel mock when not configured)
- vite-plugin-pwa for service worker + manifest
- idb-keyval for persisted favorites/playlists/latest

## Get started

```powershell
cd F:\chord
npm install            # one-time
npm run dev            # builds slim songs.json, then starts Vite on :5173
```

Open `http://localhost:5173` on your PC, or on the iPad use the LAN URL Vite prints (e.g. `http://192.168.0.174:5173`). Both PC and iPad must be on the same Wi-Fi.

Production build:

```powershell
npm run build          # outputs to dist/
npm run preview        # serves dist/ for smoke-testing
```

## How rooms work

- Every device generates and persists a 6-digit room code.
- All devices using the **same code** see each other's selections.
- Tap the room code in the top bar to edit it manually, or the refresh icon to randomize.
- When a band member taps a song, the rest get a "นักร้องเลือก" banner they can tap to open that song.
- The selecting device is highlighted in the brand color ("คุณเลือก").
- The first device to enter a fresh room becomes the **owner**; others are **guests**. Only the owner can edit playlists — guests see the owner's playlists read-only.

## Firebase setup (for real cross-device sync)

Without these env vars the app falls back to a BroadcastChannel mock that only syncs across tabs on the **same browser** — fine for UI testing, useless for real bands.

1. Create a Firebase project at https://console.firebase.google.com
2. Add a Web app — copy the config snippet
3. Enable **Realtime Database** (not Firestore) — Build > Realtime Database > Create
4. Set rules to allow anonymous reads/writes inside `rooms/`:
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
   (For tighter security, add rate limits or sign-in. The data is tiny and unprivileged — just a song id + name — so anonymous is acceptable for a band-internal tool.)
5. Copy `.env.example` to `.env.local` and fill in the values from the Firebase config snippet.
6. Restart `npm run dev`.

## Project layout

```
F:\chord\
├── data\                            # source dataset (gitignored, kept locally)
│   ├── results.json                 # [{id, src, alt}, ...] (70,107 records)
│   ├── results.jsonl                # raw line-per-record log (resumable scrape)
│   └── archive\                     # one-shot artifacts from the build
├── images\                          # 70,107 PNG chord sheets, ~4.94 GB (gitignored)
├── logs\                            # script run logs (gitignored)
├── public\                          # webapp public assets
│   ├── favicon.svg
│   ├── newrelic.js
│   └── songs.json                   # slim dataset, committed (generated)
├── src\                             # React source
│   ├── App.tsx
│   ├── main.tsx
│   ├── store.ts                     # Zustand store (state + persistence)
│   ├── types.ts
│   ├── components\
│   │   ├── TopBar.tsx
│   │   ├── NowPlaying.tsx
│   │   ├── Tabs.tsx
│   │   ├── PlaylistPicker.tsx
│   │   ├── SongList.tsx
│   │   └── Fullscreen.tsx
│   └── lib\
│       ├── firebase.ts              # Realtime DB sync + BroadcastChannel fallback
│       ├── persist.ts               # IndexedDB + localStorage helpers
│       ├── search.ts                # in-memory search
│       └── imageUrl.ts
├── scripts\
│   ├── build-data.mjs               # slims data/results.json → public/songs.json
│   ├── scrape.py                    # fetch HTML + extract <img src/alt>
│   ├── download.py                  # download images to images\
│   ├── sync_names.py                # keep alt <-> filename in sync
│   ├── upload_r2.py                 # bulk-upload images/ to Cloudflare R2
│   ├── check_missing.py             # audit songs.json ↔ R2 ↔ local disk
│   ├── scan_weird_chars.py          # find invisible control chars in titles
│   └── publish.ps1                  # end-to-end deploy
├── vite.config.ts
├── tsconfig*.json
├── tailwind.config.js, postcss.config.js, eslint.config.js
└── package.json
```

## Images

- **Dev:** served by Vite middleware from `F:\chord\images` at `/images/*`.
- **Prod:** set `VITE_IMAGE_BASE` to your CDN/origin (e.g. `https://cdn.you.com/chord`). The app fetches `${VITE_IMAGE_BASE}/${encodeURIComponent(file)}`.

## Adding new songs

```powershell
# scrape additional pages
python F:\chord\scripts\scrape.py --start 70570 --end 75000
python F:\chord\scripts\download.py
python F:\chord\scripts\sync_names.py

# rebuild the webapp's slim JSON (npm run dev/build also runs this)
npm run data
```

## Install on iPad

1. Open the LAN URL in Safari.
2. Share menu → "Add to Home Screen".
3. Launch from the home-screen icon — you get a fullscreen app with the dark UI, no Safari chrome.

---

## Data pipeline (the dataset behind the app)

All scrape/download/sync scripts compute paths relative to `PROJECT_ROOT` (= `F:\chord`), so the whole folder can be moved or renamed without code changes.

### Scrape new pages (e.g. ids beyond 70569)

```powershell
$env:PYTHONIOENCODING = "utf-8"
python F:\chord\scripts\scrape.py --start 70570 --end 75000
```

The script appends to `data\results.jsonl` (resumable) and rewrites `data\results.json` at the end. It skips ids that are already done.

### Download newly-scraped images

```powershell
python F:\chord\scripts\download.py
```

Skips files that already exist on disk. Use `--test N` to dry-run on the first N records.

### Re-sync alt fields to filenames (after re-scrape)

```powershell
python F:\chord\scripts\sync_names.py --dry-run    # preview
python F:\chord\scripts\sync_names.py              # apply
```

Backs up the previous `results.json` to `data\archive\results.before_sync.json`.

### Dataset shape

Each record in `results.json`:
```json
{
  "id": 1,
  "src": "https://chordtabs.in.th/img/nm/c0000101.png",
  "alt": "คอร์ด คำสาป Playground"
}
```

Filename rule (used when downloading):
- Strip `"คอร์ด "` prefix from `alt`
- Sanitize for Windows (`< > : " / \ | ? *` → `_`)
- If the cleaned name collides case-insensitively with another record, append `_{id}`
- `.png` extension

After `sync_names.py`, every record's `alt` minus `"คอร์ด "` matches its filename on disk exactly (sans extension).

### Counts

| | |
|---|---|
| Pages scraped (1..70569)  | 70,569 |
| Records with a real image | 70,107 |
| Image files on disk       | 70,107 |
| Total image size          | 4.94 GB |
| Duplicate-name records    | 2,162 (use `_{id}` suffix) |

### Python deps

```powershell
python -m pip install requests beautifulsoup4 lxml boto3
```
