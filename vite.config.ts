import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const IMAGES_DIR = path.resolve(__dirname, "images");

// Serve F:\chord\images at /images/* (dev only; for prod, host them at a real
// URL and set VITE_IMAGE_BASE).
function imagesMiddleware(): Plugin {
  return {
    name: "serve-chord-images",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        "/images",
        (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
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
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    imagesMiddleware(),
    VitePWA({
      // We write our own service worker (src/sw.ts) instead of letting workbox
      // generate one, because we need a custom runtime plugin that transcodes
      // PNG images to WebP at cache time — see src/sw.ts.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "robots.txt"],
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
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
});
