# Chord

A fast, dark-mode PWA for searching, viewing, and sharing chord sheets
with your band in real time — built on top of a 70k-song chord-image
dataset scraped from chordtabs.in.th.

Target devices: **iPad** (singer's main view) and **mobile** (other band
members watching the singer's pick).

## Features

### Browsing & search
- **70k-song catalogue** loaded from a single ~0.9 MB obfuscated payload
  (`public/songs.bin` — XOR + brotli, decoded client-side)
- **In-memory search** across every title in ~10–30 ms (NFC normalized,
  case-insensitive, capped at 500 results)
- **Virtualized list** (`react-virtuoso`) — 70k rows scroll smoothly on
  iOS / iPad
- **"ล่าสุด" pin** — the last 30 songs you opened are pinned to the top of
  the "ทั้งหมด" tab with a brand-grad accent, so picking the next song in a
  set is always one tap away
- **Floating scroll-to-top** button appears once you've scrolled away
  from the top

### Fullscreen chord viewer
- **ChordPro text first** — tap any row and the viewer fetches that song's
  inline-ChordPro sheet (`.md`) from R2, renders it as reflowing text, and
  lets you **transpose** to any key on the fly (music-theory based — no OCR).
  The sheets are extracted offline by Gemini 2.5 Flash (see *ChordPro text*
  below). The service worker caches each `.md` stale-while-revalidate, so a
  song you've opened opens **instantly and works offline**.
- **WebP image fallback** — songs not yet converted, or opened offline before
  their text was cached, fall back to the original WebP chord sheet from R2
  (cache-first). So shipping before the backfill finishes is fine.
- **Image inversion toggle** (top-right ◐) — flips white paper → black,
  black ink → white, for stage-friendly dark mode while preserving any
  color highlights in the chord notation
- **Pinch-to-zoom on iPad** — viewport meta is swapped in/out so the
  chord page can zoom while the rest of the app stays locked to 1.0
- **Cache-first instant render** — the moment you tap a row, the store
  kicks off `new Image()` *before* Fullscreen even mounts. When the SW
  has the bytes, the image paints with zero white-flash
- **Blob bypass** — Fullscreen also reads the Cache Storage directly via
  `cache.match` → `URL.createObjectURL`, dodging the 200–2000 ms cold SW
  lookup on idle iPad PWAs
- **Loading spinner** appears only on genuinely slow loads (150 ms CSS
  delay; cache hits never paint it), inside a dark pill so it's
  visible on both white and inverted backgrounds
- **Error overlay** when an image fails — different copy + icon for
  "ออฟไลน์ ยังไม่ได้บันทึก" vs "โหลดไม่สำเร็จ"; "ลองอีกครั้ง" button forces a
  fresh fetch by remounting the `<img>`; auto-retries when `navigator.onLine`
  flips back to true
- **Esc to close** on keyboard; tap the dark gutter on touch

### Library & playlists
- **Favorites** (★) — toggle from any row or in the dedicated tab
- **Latest** — auto-tracked, FIFO, capped at 30 entries to keep the
  per-user Firestore doc bounded
- **Multiple playlists** — create / rename / delete; drag-and-drop
  reorder (`@dnd-kit`) when viewing your own list
- **Per-client playlists in a shared room** — every member's lists are
  merged into one picker, **owner-first**, then yours, then everyone
  else's by `clientId`. Duplicate names get `(2)/(3)/…` suffixes.
  Read-only badge on lists you don't own; edit affordances are hidden
- All collections persist locally in IndexedDB (`idb-keyval`)

### Realtime room sync (Firebase RTDB)
- **6-digit room codes** — tap to edit, or hit the refresh icon to
  randomize. Same code on multiple devices = same room
- **Shared "now playing"** — when one device taps a song, every other
  device in the room sees it via the `NowPlaying` banner ("คุณเลือก" /
  "เลือกจากผู้เล่นคนอื่น")
- **Auto-open fullscreen** on remote picks (toggle eye-icon in TopBar);
  the picker's close also closes receivers who are still viewing the
  same song. Page-load baseline guard: songs already in the room when
  this tab opened don't auto-pop fullscreen — only post-mount picks do
- **OS push notifications** — asymmetric policy: `autoOpen=on` notifies
  only when tab is hidden; `autoOpen=off` notifies every time
- **Deep-linkable URLs** — `/{room}` or `/{room}/{songId}` is the source
  of truth; sharing a song-URL drops the recipient straight into the
  fullscreen view. Back/forward buttons walk through prior rooms/songs
- **Atomic ownership** — first device into a fresh room claims it via
  RTDB transaction; on owner disconnect the pointer clears and guests
  race to re-claim. Releasing owner doesn't wipe `/current` or anyone
  else's `/playlists/{cid}` — those keep going

### Cross-device sync (Firestore)
- A random 8-char `clientId` (persisted in localStorage) keys a
  Firestore doc at `clients/{clientId}`. Mirror `favorites`, `latest`,
  `roomCode` across any device that shares the same `clientId`
- **No Firebase Auth** — open rules on `clients/{clientId}`. Trade-off
  documented in [src/lib/firebase.ts](src/lib/firebase.ts) and
  [CLAUDE.md](CLAUDE.md)
- URL-forced room beats stale cloud value: a shared link always wins
  over whatever room this device was in last

### Offline
- **PWA service worker** (custom, `injectManifest` mode) — precaches
  build assets, falls back navigation to `index.html`, caches
  `songs.bin` stale-while-revalidate, and chord images cache-first
  from R2 (~5,000-entry cap, `Vary: Origin` normalized)
- **Three-layer image strategy**
  1. SW CacheFirst on every image you view
  2. Background prefetch ([useAutoPrefetch](src/hooks/useAutoPrefetch.ts))
     for favorites + latest + every playlist (mine + bandmates') —
     low-concurrency (4), skips already-cached, silent on failure
  3. Defensive `ensureCached()` on every Fullscreen onLoad, in case the
     SW route didn't actually cache the entry (stale SW, pattern miss)
- **Green offline dot** on each row when its image is in the local cache
- **`requestPersistentStorage()`** at app mount so the cache survives
  disk pressure on iOS
- Notification deep-link via SW `notificationclick` → focus existing
  tab + navigate, or `openWindow` to the song URL

### Install / share
- **Install button** (TopBar) — Chrome / Edge / Android fire the native
  `beforeinstallprompt`; iPad / iPhone Safari get an instruction sheet
  ("Share → Add to Home Screen") portaled to `document.body` to escape
  the header's `backdrop-filter` containing block
- Hidden entirely once running as an installed PWA
- **Share button** — `navigator.share` with clipboard fallback; flashes
  ✓ when the link is on the clipboard

### Quick room join — no typing the 6-digit code
- **QR code** — the room chip opens a sheet with a QR of the deep-link
  (`{origin}/{roomCode}`). A bandmate scans the singer's iPad with any
  camera → lands straight in the room. The QR library is lazy-loaded
  (its own ~23 KB chunk, only when the sheet opens)
- **Ultrasonic audio** — "แชร์ห้องนี้ผ่านเสียง" plays the 6 digits as
  near-ultrasonic (~18–19 kHz) FSK tone bursts; "ฟังเพื่อเข้าห้องเพื่อน"
  opens the mic, decodes them back, and joins the room. Best-effort
  (proximity + quiet-room dependent) — QR is the reliable fallback. No
  Web Bluetooth (iPad Safari blocks it)

### Misc UX
- **Auto-open eye toggle** — explicit control over whether remote picks
  take over your screen
- **Owner / Guest badge** on the room code chip
- **Click-outside to cancel** the room-code edit input
- All collections survive tab close + page reload (idb-keyval +
  localStorage)

## Stack

- Vite 8 + React 19 + TypeScript
- Tailwind CSS 3 (dark mode)
- Zustand for state, react-virtuoso for the virtual list
- Firebase Realtime DB (room sync) + Firestore (per-client cross-device sync)
- vite-plugin-pwa (custom SW under `injectManifest`)
- idb-keyval for persisted favorites/playlists/latest
- Cloudflare R2 Custom Domain + Snippet (image + ChordPro `.md` hosting, see DEPLOY.md)
- `@google/genai` (Gemini 2.5 Flash) for offline ChordPro extraction;
  `brotli` (payload decode), `qrcode` (room QR) — both client-side
- Web Audio API (near-ultrasonic room-code transport)

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
│   │                                # Fullscreen, PlaylistPicker,
│   │                                # RoomControls
│   ├── hooks\                       # useVisibleSongs, useRoomSongAlert,
│   │                                # useAutoPrefetch
│   └── lib\                         # firebase, cloudSync, persist, search,
│                                    # songsCodec, imageUrl, chordText,
│                                    # chordpro, offlineDownload
├── data\
│   ├── results.json                 # source dataset (gitignored)
│   └── songs-md\                    # ChordPro .md sheets (gitignored → R2)
├── scripts\
│   ├── _env.py                      # loads .env.local into os.environ
│   ├── _r2.py                       # boto3 R2 client factory
│   ├── scrape.py                    # fetch chordtabs HTML → results.json
│   ├── download.py                  # PNG downloader (source format)
│   ├── sync_names.py                # rectify alt ↔ filename (PNG stage)
│   ├── convert_to_webp.py           # PNG → WebP in place, delete source
│   ├── upload_r2.py                 # bulk image upload to R2 (resumable)
│   ├── gemini-backfill.mjs          # chord-sheet image → ChordPro .md (Gemini 2.5 Flash)
│   ├── upload_md_r2.py              # upload data/songs-md/*.md → R2 md/<id>.md
│   ├── scan_weird_chars.py          # spot invisible control chars in titles
│   ├── build-data.mjs               # results.json → public/songs.bin (+ t flag)
│   ├── check_sync.py                # cross-check results.json ↔ images/ ↔ R2
│   ├── sync.py                      # one-stop image pipeline (probe→scrape→…→push)
│   └── pipeline.ps1                 # legacy: upload + build + push only
├── .env.example, .env.local (gitignored)
└── CLAUDE.md, DEPLOY.md, README.md
```

## Images

The image source files on disk are **WebP** (near-lossless q=80 — see
`scripts/convert_to_webp.py`). Original PNGs from chordtabs.in.th are
downloaded by `download.py` then replaced in place by the convert step.

Both **dev** and **prod** set `VITE_IMAGE_BASE` to the same R2 Custom
Domain (e.g. `https://img.yourdomain.com`). A Transform Rule at that
hostname adds `Access-Control-Allow-Origin: *` so responses are
`cors`-not-`opaque` — Chrome's "opaque-response padding" tax stays off
and the offline cache fits in ~3 GB instead of ~500 GB.

See `DEPLOY.md` for the click-by-click setup.

## ChordPro text (chord sheets as text)

The viewer's primary mode renders **inline ChordPro markdown**, not the image.
Those sheets are extracted **offline** from the chord-sheet images by
**Gemini 2.5 Flash** and distributed via R2 — they are *not* bundled into
`songs.bin` (which stays ≈0.9 MB for fast in-memory search).

```powershell
# 1) get a free key → https://aistudio.google.com/apikey , put in .env.local:
#    GEMINI_API_KEY=...
npm run chordpro:backfill   # image → data/songs-md/<id>.md  (resumable, 4s/img, skips cached)
npm run data                # rebuild songs.bin (bakes a `t` has-text marker per song)
npm run chordpro:upload     # push data/songs-md/*.md → R2 under md/<id>.md
# or all three at once:
npm run chordpro:ship
```

- **Resumable** — already-extracted songs (a `data/songs-md/<id>.md` exists)
  are skipped; Ctrl+C and re-run any time. `--limit N`, `--start ID`,
  `--ids 1,2,3`, `--force` flags scope a run.
- **`data/songs-md/` is gitignored** (like `images/`); R2 is the distribution.
  The committed `songs.bin` only carries the 1-byte `t` flag per song with text.
- **Offline** — the service worker caches each `.md` stale-while-revalidate;
  the client falls back to the WebP image when a song has no text / is opened
  offline before its text cached.
- Fix one bad sheet: `node scripts/gemini-backfill.mjs --ids <id> --force`
  then `npm run chordpro:upload` + `npm run data`.
- **Automatic for new songs** — `npm run sync` runs this extraction + `.md`
  upload right after the image steps (scoped to the newly-scraped ids), so
  fresh songs get their text hands-free. Use `--skip-chordpro` for images only.
- **24/7 backfill** — a circuit breaker (`--max-rate-errors`, default 6) stops
  a run cleanly at the daily-quota / 503 wall, so a resumable loop on a server
  pauses and resumes day by day instead of churning the queue.

## Adding new songs

The one-stop pipeline auto-detects the next scrape id from
`data/results.json`, probes the source forward until 10 consecutive
misses, then orchestrates scrape → download → sync-names → convert →
upload → verify → build:

```powershell
npm run sync          # full pipeline, no git push
npm run sync:push     # same, then git add/commit/push public/songs.bin
npm run sync:dry      # print every step's command without running
```

Cloudflare Pages auto-deploys within ~60 s of the push.

Cross-check that everything is in sync without changing anything:

```powershell
npm run check         # results.json ↔ images/ ↔ R2 bucket
npm run check:clean   # also delete orphan WebPs (asks confirmation)
```

R2 credentials live in `.env.local` — Python scripts auto-load them via
`scripts/_env.py`, no need to re-export `$env:R2_*` every shell session:

```
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
```

The legacy `scripts/pipeline.ps1` (upload + build + push only) is kept
for back-compat but `sync.py` supersedes it for the full flow.

### Doing the steps manually

If you'd rather drive each script yourself (e.g. partial reruns after a
crash), each step is resumable:

```powershell
py scripts\scrape.py --start 70570 --end 75000
py scripts\download.py
py scripts\sync_names.py            # PNG stage only — rectify alt ↔ filename
py scripts\convert_to_webp.py       # in-place PNG → WebP, deletes source PNG
py scripts\upload_r2.py images\
py scripts\check_sync.py
node scripts\build-data.mjs
```

Running `sync_names.py` *after* `convert_to_webp.py` will report 70k
"missing" files because it only knows about `.png` — keep them in this
order.

## Install on iPad

1. Open the LAN URL (or production URL) in Safari.
2. Share menu → "Add to Home Screen".
3. Launch from the icon — fullscreen, dark UI, no Safari chrome.

PWA install also unlocks **persistent storage** on iOS, which is what
keeps the offline image cache (favorites + playlists + recents,
prefetched in the background) from being evicted when iOS runs low
on disk.

## Data pipeline details

All scripts compute paths relative to `PROJECT_ROOT` (the parent of
`scripts/`), so the whole folder can be moved without code changes.

### Dataset shape (results.json)

```json
{ "id": 1, "src": "https://chordtabs.in.th/img/nm/c0000101.png",
  "alt": "คอร์ด คำสาป Playground" }
```

`build-data.mjs` slims this down to `{id, name}` (plus a 1-byte `t:1` marker
when the song has a ChordPro sheet on R2), strips the prefix + sanitises the
filename, then XOR+brotli-obfuscates it as `public/songs.bin`. The image URL is
reconstructed at runtime via `src/lib/imageUrl.ts`
(`${BASE}/${encodeURIComponent(name)}.webp`); the ChordPro text via
`src/lib/chordText.ts` (`${TEXT_BASE}/${id}.md`).

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
