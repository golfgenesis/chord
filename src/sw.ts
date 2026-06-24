/// <reference lib="webworker" />
// Service worker — handles SPA navigation fallback, song-payload caching,
// chord-image caching, and the notification-click deep-link.
//
// Built via vite-plugin-pwa (strategies: "injectManifest"). `self.__WB_MANIFEST`
// is replaced at build time with the precache list.

import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  __WB_DISABLE_DEV_LOGS?: boolean;
};

// Silence workbox's per-route debug logging. Without this, every cached
// fetch prints "[workbox] Updating the 'chord-images' cache with a new
// Response for ..." — noise during a background-prefetch burst (a few
// hundred files on first room join) and tanks DevTools performance.
// Must be set BEFORE any workbox module is imported elsewhere or it's
// a no-op.
self.__WB_DISABLE_DEV_LOGS = true;

self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // songs.bin moved from a runtime stale-while-revalidate route to the
      // precache — delete the legacy "chord-songs" cache so an old payload
      // can't linger and reclaim its ~1.4 MB. No-op if it never existed.
      await caches.delete("chord-songs").catch(() => {});
      await self.clients.claim();
    })(),
  );
});

// 1) Precache build assets (JS, CSS, HTML, SVG, fonts) ------------------------
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// 2) SPA navigation fallback to index.html ------------------------------------
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// 3) songs.bin (obfuscated payload) — PRECACHED, not a runtime route ---------
// It's matched by precacheAndRoute above (included via the `bin` glob in
// vite.config.ts). Being revisioned by content hash, a songs.bin change bumps
// sw.js, so the main.tsx update poll + controllerchange reload deliver the new
// data to every client. The old stale-while-revalidate route is gone — it
// served the previous payload for one extra load after each deploy.

const IMAGE_BASE = import.meta.env.VITE_IMAGE_BASE as string | undefined;
const TEXT_BASE = import.meta.env.VITE_TEXT_BASE as string | undefined;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 4) ChordPro text (.md) — stale-while-revalidate from R2 --------------------
// Registered BEFORE the image route on purpose: the markdown lives on the SAME
// R2 origin as the images, and the image route below matches anything on that
// origin. Workbox uses the FIRST matching route, so `.md` must be claimed here
// first. SWR = serve the cached copy instantly (zero-latency offline) while a
// background fetch refreshes it, so a re-extracted sheet silently updates.
let textPattern: RegExp;
try {
  // The client builds text URLs as `${VITE_TEXT_BASE ?? VITE_IMAGE_BASE/md}/<id>.md`
  // (see src/lib/chordText.ts). Derive the same origin here, falling back to a
  // same-origin `/md/` path for local dev (served by the vite md middleware).
  const tb =
    TEXT_BASE || (IMAGE_BASE ? `${IMAGE_BASE.replace(/\/+$/, "")}/md` : "");
  const origin = tb ? new URL(tb).origin : null;
  textPattern = origin
    ? new RegExp(`^${escapeRe(origin)}/.*\\.md(?:\\?|$)`)
    : /\/md\/[^/]*\.md(?:\?|$)/;
} catch {
  textPattern = /\/md\/[^/]*\.md(?:\?|$)/;
}

registerRoute(
  textPattern,
  new StaleWhileRevalidate({
    cacheName: "chord-text",
    // R2 sends `Vary: Origin`; normalize the key (mirrors the image route) so
    // the SW-side fetch and any JS-side cache.put hit the SAME entry.
    matchOptions: { ignoreVary: true },
    plugins: [
      { cacheKeyWillBeUsed: async ({ request }) => new Request(request.url) },
      new ExpirationPlugin({
        maxEntries: 5000,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// 5) Images — cache-first from R2 (or same-origin proxy in prod) -------------
let imagePattern: RegExp;
try {
  const origin = IMAGE_BASE ? new URL(IMAGE_BASE).origin : null;
  imagePattern = origin
    ? new RegExp(`(?:^${escapeRe(origin)}/|/images/)`)
    : /\/images\//;
} catch {
  imagePattern = /\/images\//;
}

registerRoute(
  imagePattern,
  new CacheFirst({
    cacheName: "chord-images",
    // R2 Custom Domain sends `Vary: Origin`. Two protections layered:
    //   1) cacheKeyWillBeUsed — normalize the storage key to `new
    //      Request(url)` so SW (live <img> with Origin) and JS-side
    //      `cache.put(url, res)` from prefetch / ensureCached (no Origin)
    //      hit the SAME entry. Without this both paths wrote different
    //      keys for the same URL → 2× storage and the offline-dot
    //      disagreed with the actual SW-served bytes.
    //   2) matchOptions.ignoreVary — belt-and-suspenders against any
    //      legacy entries from before #1 that still have an Origin in
    //      their key. Cheap and safe (we serve identical bytes regardless
    //      of caller's Origin).
    matchOptions: { ignoreVary: true },
    plugins: [
      {
        cacheKeyWillBeUsed: async ({ request }) =>
          new Request(request.url),
      },
      new ExpirationPlugin({
        // Generous cap. In normal use the cache holds whatever the user
        // has opened + their prefetched favorites/playlists/recents —
        // typically well under 1k entries. The high ceiling is just
        // insurance against the rare power user with hundreds of saved
        // songs across rooms.
        maxEntries: 5000,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// 6) Allow the app to trigger updates ----------------------------------------
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// 7) Notification click — bring the right tab forward, or open a fresh one --
// When a bandmate picks a song the page (or SW) fires a notification with a
// `data.url` pointing at the current room. Clicking the OS notification
// should land the user on that exact room URL: focus an existing client if
// one is open, otherwise launch the PWA / open a new tab at that URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url || "/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer a client already on the same origin — focus it and, if its
      // URL differs from `target`, navigate it there. This avoids opening
      // a duplicate tab when one already exists.
      for (const client of clientList) {
        try {
          const url = new URL(client.url);
          if (url.origin !== self.location.origin) continue;
          await client.focus();
          if (url.pathname !== new URL(target, self.location.origin).pathname) {
            await client.navigate(target).catch(() => {});
          }
          return;
        } catch {
          // continue trying other clients
        }
      }
      // Nothing open — let the OS launch the PWA / a new tab at target.
      await self.clients.openWindow(target);
    })(),
  );
});
