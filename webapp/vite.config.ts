import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import fs from "node:fs";

const IMAGES_DIR = path.resolve(__dirname, "..", "images");

// Serve F:\chord\images at /images/* (dev only; for prod, host them at a real
// URL and set VITE_IMAGE_BASE).
function imagesMiddleware() {
  return {
    name: "serve-chord-images",
    configureServer(server: any) {
      server.middlewares.use("/images", (req: any, res: any, next: any) => {
        try {
          const decoded = decodeURIComponent((req.url ?? "").split("?")[0]);
          const filePath = path.join(IMAGES_DIR, decoded);
          if (!filePath.startsWith(IMAGES_DIR)) {
            res.statusCode = 403;
            return res.end("forbidden");
          }
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            return res.end("not found");
          }
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          fs.createReadStream(filePath).pipe(res);
        } catch (err) {
          next(err);
        }
      });
    },
  } as const;
}

export default defineConfig(({ mode }) => {
  // Read VITE_IMAGE_BASE at build time so the service worker can also cache
  // cross-origin CDN images (in prod). In dev, images come from /images/* so
  // the pathname rule below covers it.
  //
  // We must bake the origin into a RegExp here (not a closure-capturing
  // function) — vite-plugin-pwa serializes runtimeCaching entries via
  // Function.prototype.toString, so any reference to an outer variable would
  // become a free identifier in the generated sw.js.
  const env = loadEnv(mode, process.cwd(), "");
  let imageOrigin: string | null = null;
  try {
    if (env.VITE_IMAGE_BASE) imageOrigin = new URL(env.VITE_IMAGE_BASE).origin;
  } catch {
    // ignore malformed VITE_IMAGE_BASE
  }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Same-origin `/images/...` (dev) OR the CDN origin (prod). The `^` makes
  // Workbox opt in to handling cross-origin requests for that branch.
  const imageUrlPattern = imageOrigin
    ? new RegExp(`(?:^${escapeRe(imageOrigin)}/|/images/)`)
    : /\/images\//;

  return {
    plugins: [
      react(),
      imagesMiddleware(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg"],
        manifest: {
          name: "Chord",
          short_name: "Chord",
          description: "Search, view and sync chord sheets with your band",
          theme_color: "#0a0a0b",
          background_color: "#0a0a0b",
          display: "fullscreen",
          display_override: ["fullscreen", "standalone", "minimal-ui"],
          orientation: "any",
          start_url: "/",
          icons: [
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
          skipWaiting: true,
          clientsClaim: true,
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            {
              urlPattern: imageUrlPattern,
              handler: "CacheFirst",
              options: {
                cacheName: "chord-images",
                expiration: {
                  maxEntries: 10000,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: ({ url }) => url.pathname === "/songs.json",
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "chord-songs-json",
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    server: {
      host: true,
      port: 5173,
    },
  };
});
