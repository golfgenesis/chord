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
```

No test suite exists; verification is type-check + lint + manual browser testing.

The dev server has the PWA service worker **enabled** (`devOptions.enabled: true` in `vite.config.ts`) because Chrome's `beforeinstallprompt` won't fire on localhost otherwise. If you touch the SW, hard-refresh and unregister the old worker in DevTools → Application → Service Workers.

## Architecture

Three sync layers, three different stores, intentionally separated:

1. **Local-only** (`src/lib/persist.ts`) — `idb-keyval` for `favorites`/`latest`/`playlists`, `localStorage` for `clientId`/`roomCode`/`invertImages`/`autoOpen`.
2. **Per-client cloud** (`src/lib/cloudSync.ts`) — Firestore doc at `clients/{clientId}` mirrors `favorites`/`latest`/`roomCode` across devices that share a `clientId`. **No Firebase Auth** — `clientId` is an 8-char random string in localStorage, so Firestore rules must allow open read/write on `clients/{clientId}`. This was a deliberate switch from anonymous auth because orphan auth records were accumulating on every cache clear.
3. **Per-room realtime** (`src/lib/firebase.ts`, RTDB) — `rooms/{code}/{current,playlists,owner}`. Falls back to a `BroadcastChannel` mock when `VITE_FIREBASE_*` env vars are absent — only useful for same-browser tab testing.

### Room ownership

First device into a fresh room atomically claims `rooms/{code}/owner` via `runTransaction`. The owner arms `onDisconnect.remove()` on the *entire* `rooms/{code}` node, so a closed tab / killed PWA wipes the room. **Critical bug fix encoded in [src/store.ts](src/store.ts):** when the owner disconnects, every guest sees `owner: null` and races to re-claim via `claimOwner` (the RTDB transaction picks exactly one winner). The earlier "first snapshot only" claim logic left rooms stuck ownerless after a leader left. The same code path also refuses to wipe local `playlists` on a null remote — the winning new owner re-publishes from their copy.

### URL = source of truth

Path format: `/{roomCode}` or `/{roomCode}/{songId}`. The store's `init()` parses URL → reconciles with localStorage → does `history.replaceState`. `setRoomCode` / `open` / `close` push state on every state change; a `popstate` listener reverses the flow for back/forward. Shared URLs land guests in the same room and (if a songId is present) deep-link straight into the fullscreen view.

When a URL-specified room differs from the cloud-synced one, the URL wins. The `pendingUrlPush` flag in `init()` swallows the first remote snapshot's `roomCode` and pushes the URL choice up to Firestore instead — otherwise the cloud's stale value would yank the user out of the room their friend just shared.

### Songs payload

`public/songs.bin` is `XOR(gzip(JSON), KEY)`, decoded client-side in [src/lib/songsCodec.ts](src/lib/songsCodec.ts). It's **obfuscation, not encryption** — the key is in the bundle. Purpose: stop trivial scrapers. `scripts/build-data.mjs` produces it from `data/results.json` (gitignored 70k-record source). **The XOR key must stay identical in both files.**

### Service worker

Custom SW at `src/sw.ts` (vite-plugin-pwa `injectManifest` mode, **not** `generateSW`). Two notable behaviors:

- **PNG → WebP transcode at cache time** via `cacheWillUpdate` workbox plugin + `OffscreenCanvas.convertToBlob`. Origin files stay PNG; the user's local cache stores the smaller WebP, so more sheets fit before quota.
- **`notificationclick` handler** focuses an existing tab and `client.navigate(data.url)` to the embedded room/song URL, or `clients.openWindow` if nothing is open. Deep-links bandmates straight to the song someone just picked.

### Notifications + auto-open

[src/hooks/useRoomSongAlert.ts](src/hooks/useRoomSongAlert.ts) watches `room.songId` and:
- Calls `open(song, false)` (no re-broadcast) when `autoOpen=true`.
- Fires `registration.showNotification` with `data.url = /{roomCode}/{songId}`.

The hook has **no "first snapshot" guard** — guests joining mid-rehearsal should immediately auto-open whatever the band is currently on. Dedup happens via `lastSongId.current` only.

Permission is requested on the first `pointerdown`/`keydown` after mount (browsers gate `Notification.requestPermission()` behind a user gesture; calling on mount silently no-ops).

## iOS / iPad quirks baked into the code

These are deliberate workarounds, not cargo-cult — please don't remove without verifying on a real iPad:

- **[src/components/Fullscreen.tsx](src/components/Fullscreen.tsx)** swaps the viewport meta to `user-scalable=yes, maximum-scale=5.0` while open (the index.html viewport is otherwise locked to scale=1.0 to keep the chrome from zooming on tap). On close, it sets `maximum-scale=1.0` for one frame then restores the original — without that beat, iOS holds the prior zoom level and the list page feels "stuck zoomed in" with broken touch-scroll.
- **[src/components/TopBar.tsx](src/components/TopBar.tsx) `isIOS` detection** combines `/iPhone|iPod/`, `/iPad/`, AND `Macintosh + maxTouchPoints > 1`. iPad Safari has reported as desktop Mac in UA since iOS 13.
- **[src/components/TopBar.tsx](src/components/TopBar.tsx) IOSInstallSheet** is `createPortal(..., document.body)` because `backdrop-filter` on the `<header>` (`glass-strong` class) creates a containing block that breaks `position: fixed` for descendants — without the portal the sheet pins to the 80px header instead of the viewport.
- **[src/index.css](src/index.css)** keeps `overscroll-behavior: none` on `html` only (not `body`/`#root`) and explicitly sets `touch-action: pan-y` on `body`. The Virtuoso wrapper in [src/components/SongList.tsx](src/components/SongList.tsx) also sets `style={{ touchAction: 'pan-y' }}` defensively. Removing these has caused full loss of touch-scroll on iOS.

## Production hosting

`public/_redirects` (`/* /index.html 200`) handles SPA fallback for Cloudflare Pages / Netlify. GitHub Pages needs a different trick. Images: set `VITE_IMAGE_BASE=https://cdn.example.com/chord` for production; in dev they're served by the `imagesMiddleware` plugin in [vite.config.ts](vite.config.ts) from `F:\chord\images`.

## Project layout notes vs. README

- The webapp moved from `webapp/` up to project root — paths in [README.md](README.md) match the current layout but some script docs (`F:\chord\webapp\...`) are stale.
- `public/songs.json` no longer exists at runtime. The payload is `public/songs.bin` (obfuscated). README still says JSON in places.
- Components: `RoomControls.tsx` was extracted from `TopBar.tsx` and is now rendered next to `Tabs.tsx` (it owns the room-code badge + randomize button). Install + Share buttons remain in `TopBar.tsx`.
- Hooks: `useVisibleSongs.ts` (search/filter logic) and `useRoomSongAlert.ts` (auto-open + notifications) — both in `src/hooks/`.
