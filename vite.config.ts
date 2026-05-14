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
            res.setHeader("Content-Type", "image/webp");
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
      // generate one so we can wire custom routing/caching for the chord-image
      // CDN and notification handling.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon.svg", "robots.txt"],
      manifest: {
        name: "Chord",
        short_name: "Chord",
        description: "Search, view and sync chord sheets with your band",
        theme_color: "#08070d",
        background_color: "#08070d",
        display: "fullscreen",
        display_override: ["fullscreen", "standalone", "minimal-ui"],
        orientation: "any",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
      },
      // Without this the service worker only runs after `vite build`,
      // which means Chrome's PWA criteria are unmet on localhost and
      // `beforeinstallprompt` never fires — so the Install button stays
      // hidden in dev, AND offline-mode pre-cache can never work because
      // there's no SW to intercept the fetches. `type: "module"` is
      // required because our SW is a .ts file (ESM); `navigateFallback`
      // makes the dev SW behave like the prod one for SPA routing.
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
  // Pre-declare the heavy deps so Vite's dep-optimizer doesn't have to scan
  // the source tree to discover them. Without this, the first request to /
  // blocks ~10-15s on a cold cache while firebase + dnd-kit + virtuoso get
  // bundled into node_modules/.vite/deps.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "zustand",
      "idb-keyval",
      "react-virtuoso",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "firebase/app",
      "firebase/database",
      "firebase/firestore",
      // src/sw.ts pulls these in; declaring them avoids a second "new
      // dependencies optimized → reloading" pass after the SW first loads.
      "workbox-precaching",
      "workbox-routing",
      "workbox-strategies",
      "workbox-expiration",
      "workbox-cacheable-response",
    ],
  },
});
