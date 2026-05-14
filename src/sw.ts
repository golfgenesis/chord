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
// Response for ..." — fine for one or two requests, but during a 70k
// offline bulk-download it floods the console with tens of thousands of
// lines and tanks DevTools performance. Must be set BEFORE any workbox
// module is imported elsewhere or it's a no-op.
self.__WB_DISABLE_DEV_LOGS = true;

self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 1) Precache build assets (JS, CSS, HTML, SVG, fonts) ------------------------
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// 2) SPA navigation fallback to index.html ------------------------------------
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// 3) songs.bin (obfuscated payload) — stale-while-revalidate -----------------
registerRoute(
  ({ url }) => url.pathname === "/songs.bin",
  new StaleWhileRevalidate({
    cacheName: "chord-songs",
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// 4) Images — cache-first from R2 (or same-origin proxy in prod) -------------
const IMAGE_BASE = import.meta.env.VITE_IMAGE_BASE as string | undefined;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    // The R2 Custom Domain's Transform Rule sets `Vary: Origin` on every
    // response. Workbox's default cache.match() then refuses to serve a
    // cached entry unless the stored Request's Origin header matches the
    // new request's — but `cache.put(url, res)` in offlineDownload.ts
    // stores a Request constructed from a string URL, which has no
    // Origin header, while the live `<img crossOrigin="anonymous">`
    // request DOES have one. Result: cache.keys() finds the entry (so
    // the green dot lights up) but cache.match() comes up empty and the
    // offline image fails. ignoreVary: true skips that check — safe for
    // us because we always serve the same body regardless of Origin.
    matchOptions: { ignoreVary: true },
    plugins: [
      new ExpirationPlugin({
        // Headroom over the 70,107-song dataset so the offline-mode bulk
        // download doesn't evict its own files as it walks past 10k.
        maxEntries: 80000,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// 5) Allow the app to trigger updates ----------------------------------------
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// 6) Notification click — bring the right tab forward, or open a fresh one --
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
