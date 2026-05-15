# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm run dev          # build slim songs payload, then start Vite on :5173
npm run build        # tsc -b + vite build → dist/
npm run build:full   # also rebuilds public/songs.bin from data/results.json
npm run lint         # eslint .
npm run preview      # serve dist/ for smoke testing
npm run data         # rebuild public/songs.bin only

# Data pipeline (py scripts under scripts/)
npm run sync         # probe source → scrape → download → convert → upload → verify → build
npm run sync:push    # same as above, then git add/commit/push public/songs.bin
npm run sync:dry     # print every step's command without running (skips probe)
npm run check        # cross-check results.json ↔ images/ ↔ R2 bucket (pretty console)
npm run check:clean  # delete orphan WebP files locally + on R2 (asks confirmation)
```

No test suite exists; verification is type-check + lint + manual browser testing.

The dev server has the PWA service worker **enabled** (`devOptions.enabled: true` in `vite.config.ts`) because Chrome's `beforeinstallprompt` won't fire on localhost otherwise. If you touch the SW, hard-refresh and unregister the old worker in DevTools → Application → Service Workers.

## Architecture

Three sync layers, three different stores, intentionally separated:

1. **Local-only** (`src/lib/persist.ts`) — `idb-keyval` for `favorites`/`latest`/`playlists`, `localStorage` for `clientId`/`roomCode`/`invertImages`/`autoOpen`.
2. **Per-client cloud** (`src/lib/cloudSync.ts`) — Firestore doc at `clients/{clientId}` mirrors `favorites`/`latest`/`roomCode` across devices that share a `clientId`. **No Firebase Auth** — `clientId` is an 8-char random string in localStorage, so Firestore rules must allow open read/write on `clients/{clientId}`. This was a deliberate switch from anonymous auth because orphan auth records were accumulating on every cache clear.
3. **Per-room realtime** (`src/lib/firebase.ts`, RTDB) — `rooms/{code}/{current,owner,playlists/{clientId}}`. Falls back to a `BroadcastChannel` mock when `VITE_FIREBASE_*` env vars are absent — only useful for same-browser tab testing.

### Room ownership

First device into a fresh room atomically claims `rooms/{code}/owner` via `runTransaction`. The owner's `onDisconnect` only removes the `/owner` key (not the whole `rooms/{code}` node) — guests' per-client playlist entries and the shared `/current` selection stay put when the owner's tab dies. When the owner disconnects, every guest sees `owner: null` and races to re-claim via `claimOwner`; the RTDB transaction picks exactly one winner. The earlier "first snapshot only" claim logic left rooms stuck ownerless after a leader left.

### Per-client playlists

Playlists belong to people, not rooms. Each member publishes their own list to `rooms/{code}/playlists/{clientId}` with an `onDisconnect.remove()` on that node so the entry self-cleans when the tab closes; subscribers read the whole `rooms/{code}/playlists` map and split it into "mine" vs `othersPlaylists`. The UI uses `useMergedPlaylists()` (in [src/store.ts](src/store.ts)) — owner-first, then me, then everyone else by `clientId`, with `(2)/(3)/…` suffixes on duplicate names. Edit affordances (rename, delete, add/remove songs, DnD reorder) are gated on `entry.isMine`; everyone else's lists render as read-only. The previous "owner is the sole publisher" model is gone — there's no longer any "seed playlists when becoming owner" logic.

### Picker view-state sync (auto-open + close)

`RoomState.pickerViewing` (optional, defaults to `true` for legacy snapshots) is `true` while the picker still has the fullscreen sheet open and goes `false` when the picker closes. [src/hooks/useRoomSongAlert.ts](src/hooks/useRoomSongAlert.ts) reacts to transitions:
- songId changes, or pickerViewing flips `false→true` → auto-open (if `autoOpen`) + notify.
- pickerViewing flips `true→false` → close locally (only if currently viewing the same songId).
- Picks made by the local client are skipped entirely (no echo).

A receiver closing their own fullscreen never flips `pickerViewing` — only the picker's `close()` broadcasts, and only when their local `viewing` matches the room's current `songId`. NowPlaying click is `open(song, mine)`: the picker re-engaging re-broadcasts `pickerViewing: true`, a receiver clicking the banner stays silent.

### URL = source of truth

Path format: `/{roomCode}` or `/{roomCode}/{songId}`. The store's `init()` parses URL → reconciles with localStorage → does `history.replaceState`. `setRoomCode` / `open` / `close` push state on every state change; a `popstate` listener reverses the flow for back/forward. Shared URLs land guests in the same room and (if a songId is present) deep-link straight into the fullscreen view.

When a URL-specified room differs from the cloud-synced one, the URL wins. The `pendingUrlPush` flag in `init()` swallows the first remote snapshot's `roomCode` and pushes the URL choice up to Firestore instead — otherwise the cloud's stale value would yank the user out of the room their friend just shared.

### Songs payload

`public/songs.bin` is `XOR(gzip(JSON), KEY)`, decoded client-side in [src/lib/songsCodec.ts](src/lib/songsCodec.ts). It's **obfuscation, not encryption** — the key is in the bundle. Purpose: stop trivial scrapers. `scripts/build-data.mjs` produces it from `data/results.json` (gitignored 70k-record source). **The XOR key must stay identical in both files.**

### Service worker

Custom SW at `src/sw.ts` (vite-plugin-pwa `injectManifest` mode, **not** `generateSW`). Notable behavior:

- Chord images are served as WebP directly from R2 (the source set under `images/` is already WebP). The SW runs no image transcoding — earlier versions had a PNG→WebP `cacheWillUpdate` plugin and it was a measurable bottleneck. Don't reintroduce it.
- **`notificationclick` handler** focuses an existing tab and `client.navigate(data.url)` to the embedded room/song URL, or `clients.openWindow` if nothing is open. Deep-links bandmates straight to the song someone just picked.
- **Update polling in [src/main.tsx](src/main.tsx)** calls `registration.update()` every 60 s AND on every `visibilitychange → visible`. This exists because Safari (especially iOS-PWA launched from home screen) effectively never auto-checks for a new `sw.js` — Chrome polls on every navigation + every 24 h, Safari just doesn't. Without the polling a deploy never reaches Safari users. Pairs with the `controllerchange` listener in the same file that reloads the page the moment the new SW activates (`skipWaiting` + `clientsClaim` are inside `sw.ts`).

### Offline image strategy

The whole-catalogue (70k) bulk download is **gone**. It hit Safari's quota, took hours over flaky mobile networks, and 99% of users never touched 99% of the files. Today's model is layered:

1. **SW CacheFirst on viewing** — every `<img>` the user opens flows through the `chord-images` Cache Storage and is available offline next time.
2. **Background prefetch of "things that matter"** — [src/hooks/useAutoPrefetch.ts](src/hooks/useAutoPrefetch.ts) gathers favorites + latest + every playlist (mine + bandmates') into a single Set of song ids and hands them to `prefetchSongs` in [src/lib/offlineDownload.ts](src/lib/offlineDownload.ts). A small pool (4 concurrent, 30 s timeout, silent on failure) walks the queue, skipping anything already cached. Fires on every collection change but is cheap because the pool dedupes against the existing cache.
3. **Defensive single-song top-up** — `ensureCached(song)` (called from Fullscreen onLoad) catches the case where the SW route didn't actually cache the entry (stale SW, pattern mismatch).

`requestPersistentStorage()` is called once at app mount so the cache survives disk pressure. The cache wipe primitive `clearImageCache()` is exported for debug use; no UI surfaces it currently.

### Notifications

`autoOpen` (state in store, persisted in localStorage, default `true`) decides whether `useRoomSongAlert` pops the fullscreen sheet on a remote pick. The notification policy is intentionally asymmetric:
- `autoOpen=true` → notify only when the tab is hidden; the fullscreen takeover is its own feedback.
- `autoOpen=false` → notify on every pick regardless of visibility; the OS toast is the only signal because the sheet doesn't open.

Permission is requested on the first `pointerdown`/`keydown` after mount (browsers gate `Notification.requestPermission()` behind a user gesture; calling on mount silently no-ops). The notification uses `registration.showNotification` (with a fallback to `new Notification`) and embeds `data.url = /{roomCode}/{songId}` so the SW's `notificationclick` handler can deep-link straight to the song.

The hook has a **page-load baseline guard**: songs whose `pickedAt < mountedAt` (i.e. the room already had that song when this tab loaded) update bookkeeping but DON'T auto-open. A fresh page load should land on the home/list view, not get yanked into fullscreen for whatever the band was on before this tab joined. Only picks made *after* mount auto-open. Deep-linking via `/{room}/{songId}` URLs is handled in `store.init()` separately and is unaffected by this guard. Dedup of subscription replays still happens via `lastSongId.current` + `lastPickerViewing.current`.

## iOS / iPad quirks baked into the code

These are deliberate workarounds, not cargo-cult — please don't remove without verifying on a real iPad:

- **[src/components/Fullscreen.tsx](src/components/Fullscreen.tsx)** swaps the viewport meta to `user-scalable=yes, maximum-scale=5.0` while open (the index.html viewport is otherwise locked to scale=1.0 to keep the chrome from zooming on tap). On close, it sets `maximum-scale=1.0` for one frame then restores the original — without that beat, iOS holds the prior zoom level and the list page feels "stuck zoomed in" with broken touch-scroll.
- **[src/components/TopBar.tsx](src/components/TopBar.tsx) `isIOS` detection** combines `/iPhone|iPod/`, `/iPad/`, AND `Macintosh + maxTouchPoints > 1`. iPad Safari has reported as desktop Mac in UA since iOS 13.
- **[src/components/TopBar.tsx](src/components/TopBar.tsx) IOSInstallSheet** is `createPortal(..., document.body)` because `backdrop-filter` on the `<header>` (`glass-strong` class) creates a containing block that breaks `position: fixed` for descendants — without the portal the sheet pins to the 80px header instead of the viewport.
- **[src/index.css](src/index.css)** keeps `overscroll-behavior: none` on `html` only (not `body`/`#root`) and explicitly sets `touch-action: pan-y` on `body`. The Virtuoso wrapper in [src/components/SongList.tsx](src/components/SongList.tsx) also sets `style={{ touchAction: 'pan-y' }}` defensively. Removing these has caused full loss of touch-scroll on iOS.

## Production hosting

`public/_redirects` (`/* /index.html 200`) handles SPA fallback for Cloudflare Pages / Netlify; GitHub Pages would need a different trick.

Images: served from an **R2 Custom Domain** (e.g. `https://img.yourdomain.com`) bound directly to the `chord-images` bucket. Set `VITE_IMAGE_BASE=https://img.yourdomain.com` in the Pages dashboard (Settings → Environment variables → Production) AND in local `.env.local` so dev and prod fetch identical URLs.

CORS headers can be supplied either through the **R2 bucket-level CORS Policy** (R2 → bucket → Settings → CORS Policy — works on Custom Domain too, but origins must be listed explicitly, no wildcards) OR through a **Response Header Transform Rule** at the custom-domain hostname (Free plan; `Access-Control-Allow-Origin: *` works for every origin, no per-deploy list maintenance). Either approach works. Pick one.

With ACAO + `crossOrigin="anonymous"` on `<img>`, responses are "cors" (not opaque) and avoid Chrome's 7 MB-per-entry padding tax. Without these headers, `cache.put()` in [src/lib/offlineDownload.ts](src/lib/offlineDownload.ts) silently drops entries on Chrome and the offline cache stays empty.

Dev: set `VITE_IMAGE_BASE` in `.env.local` to the same custom domain prod uses, so dev and prod are byte-identical paths.

The image set on disk and in R2 is **WebP** (near-lossless q=80) — `scripts/convert_to_webp.py` converts in place and deletes the source PNG. `src/sw.ts` does not transcode at runtime.

## Scripts layout

- `scripts/_env.py` — auto-loads `.env.local` into `os.environ`. Imported transitively by every Python script that needs credentials.
- `scripts/_r2.py` — shared boto3 R2 client factory + `BUCKET` constant. Reads `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_ENDPOINT` / `R2_BUCKET` from env (which `_env.py` populated from `.env.local`).
- **`scripts/sync.py`** — Python one-stop pipeline. Auto-detects the next scrape start id from `results.json` AND auto-probes chordtabs.in.th forward until 10 consecutive misses (so `--end` is optional). Orchestrates scrape → download → sync-names → convert → upload → verify → build → (optional) git push. Run via `npm run sync` / `npm run sync:push`. Each underlying step still runs as a subprocess of its existing script, so they stay independently testable. Safety ceiling of 1000 ids per probe — re-run if the source has more than that pending.
- **`scripts/check_sync.py`** — standalone verifier: cross-checks `data/results.json` vs local `images/` vs R2 bucket. Pretty box-drawing console output; `--json` for machines. Reports missing-locally / missing-on-R2 / orphans, and can delete orphans with `--delete-orphans`. Exit 0 if everything matches, 1 otherwise (useful in pre-push hooks). Run via `npm run check`.
- `scripts/pipeline.ps1` — older PowerShell wrapper. Only runs upload + build + push (no scrape/download/convert) and uses `py` autodetect. **`sync.py` supersedes it for the full pipeline**; `pipeline.ps1` is kept for back-compat with anyone who has scripts wired into it.
- **Do NOT add `publish.ps1` or `check_missing.py` back** — both were removed because they built/checked the legacy `songs.json` (no longer exists), and the `file` field they referenced was never written by the current `build-data.mjs`.
- Sequencing when adding new songs (manually, if not using `sync.py`): `scrape.py` → `download.py` (PNG) → `sync_names.py` (still PNG-stage) → `convert_to_webp.py` (PNG→WebP, deletes source) → `upload_r2.py images/` → `check_sync.py` → `node scripts/build-data.mjs`. Running `sync_names.py` after conversion will report 70k "missing" files because it only knows about `.png`.

## Sync API contract

If you touch [src/lib/firebase.ts](src/lib/firebase.ts), the `RoomSync` interface is:
- `publishMyPlaylists(clientId, playlists)` — writes my list to `rooms/{code}/playlists/{clientId}` and arms an `onDisconnect.remove()` on that exact node.
- `removeMyPlaylists(clientId)` — explicit cleanup when switching rooms (the onDisconnect handles tab-close).
- `subscribePlaylists(cb)` — callback receives `Record<clientId, Playlist[]> | null` (the whole map). Callers split mine vs others.
- `publish(state)` / `subscribe(cb)` for `rooms/{code}/current` — `RoomState` carries `pickerViewing`.
- `claimOwner` / `releaseOwner` / `subscribeOwner` — owner is just a pointer; releasing doesn't touch anything else.

The old `publishPlaylists(playlists)` / `subscribePlaylists` returning `Playlist[]` is gone — don't bring it back.
