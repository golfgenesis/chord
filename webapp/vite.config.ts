import { defineConfig } from "vite";
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

export default defineConfig({
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
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/images/"),
            handler: "CacheFirst",
            options: {
              cacheName: "chord-images",
              expiration: {
                maxEntries: 2000,
                maxAgeSeconds: 60 * 60 * 24 * 30,
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
});
