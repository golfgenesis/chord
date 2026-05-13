/// <reference lib="webworker" />
// Service worker — written by hand so we can inject a custom runtime plugin
// that transcodes PNG chord sheets into WebP at cache time. Source files on
// R2 stay PNG; the user's local cache holds the (smaller) WebP rendering, so
// more sheets fit before hitting browser quotas.
//
// Built via vite-plugin-pwa (strategies: "injectManifest"). `self.__WB_MANIFEST`
// is replaced at build time with the precache list.

import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import type { WorkboxPlugin } from "workbox-core/types";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

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

// 4) Images — fetch PNG, transcode to WebP, cache the WebP --------------------
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

// Feature-detect: OffscreenCanvas with convertToBlob lands in Chrome 88+,
// Firefox 110+, Safari 16.4+. Older browsers skip transcoding and just cache
// the PNG as-is (the URL stays the same; behavior is identical, only the
// cache footprint differs).
const canTranscodeToWebP =
  typeof OffscreenCanvas !== "undefined" &&
  typeof OffscreenCanvas.prototype.convertToBlob === "function" &&
  typeof createImageBitmap !== "undefined";

const webpTranscodePlugin: WorkboxPlugin = {
  async cacheWillUpdate({ response }) {
    if (!response || !response.ok) return null;
    const type = response.headers.get("Content-Type") ?? "";
    // Only transcode raster PNG. WebP/JPEG/SVG/etc. pass through unchanged.
    if (!type.startsWith("image/png")) return response;
    if (!canTranscodeToWebP) return response;
    try {
      const pngBlob = await response.clone().blob();
      const bitmap = await createImageBitmap(pngBlob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return response;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const webpBlob = await canvas.convertToBlob({
        type: "image/webp",
        // High quality; chord sheets are mostly flat colors so any artifacting
        // would be obvious. 0.95 is visually identical to PNG in practice.
        quality: 0.95,
      });
      // Some browsers refuse WebP (sad iOS 16.3 etc.) — fall back to PNG.
      if (!webpBlob || webpBlob.type !== "image/webp") return response;
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "image/webp");
      headers.set("Content-Length", String(webpBlob.size));
      headers.delete("Content-Encoding");
      headers.set("X-Transcoded", "webp");
      return new Response(webpBlob, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      console.warn("[sw] WebP transcode failed; caching PNG", err);
      return response;
    }
  },
};

registerRoute(
  imagePattern,
  new CacheFirst({
    cacheName: "chord-images",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10000,
        maxAgeSeconds: 60 * 60 * 24 * 365,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      webpTranscodePlugin,
    ],
  }),
);

// 5) Allow the app to trigger updates ----------------------------------------
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
