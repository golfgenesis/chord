import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

const IMAGES_DIR = path.resolve(__dirname, "images");

// Owner-only "fix this flagged song with the vision model" endpoints. These exist ONLY on the
// Vite dev server (configureServer runs only under `npm run dev`) — they are never built into
// dist/, so production has no way to invoke `claude`. The client gates the Fix button on
// import.meta.env.DEV AND a positive /api/vlm-status probe, so it only appears when you're
// running dev locally on a machine where the Claude Code CLI is installed.
//   GET  /api/vlm-status      → { claude: boolean }   (is `claude` on PATH?)
//   POST /api/vlm-fix?id=<n>  → runs scripts/vlm_chordpro.py <n> --force, refreshes flags,
//                               rebuilds songs.bin; returns { ok, log }.
function vlmFixMiddleware(): Plugin {
  const json = (res: ServerResponse, code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  return {
    name: "vlm-fix-dev",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/vlm-status", (_req, res) => {
        let claude = false;
        try {
          claude = spawnSync("claude --version", { shell: true, timeout: 10000 }).status === 0;
        } catch {
          /* not on PATH → stays false */
        }
        json(res, 200, { claude });
      });

      server.middlewares.use("/api/vlm-fix", (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
        if (!/^\d+$/.test(id)) return json(res, 400, { ok: false, error: "bad id" });

        // 1) re-extract this one song with the vision model (subscription via `claude -p`)
        const vlm = spawnSync(`py -3.11 scripts/vlm_chordpro.py ${id} --force`, {
          cwd: __dirname, shell: true, encoding: "utf8", timeout: 300000,
        });
        if (vlm.status !== 0)
          return json(res, 500, { ok: false, step: "vlm", log: (vlm.stdout ?? "") + (vlm.stderr ?? "") });

        // 2) refresh _flagged.tsv (the now-fixed song drops off it — its VLM text isn't flagged)
        spawnSync("py -3.11 scripts/extract_chordpro.py --check", {
          cwd: __dirname, shell: true, encoding: "utf8", timeout: 120000,
        });

        // 3) rebuild songs.bin so the reloaded client picks up the new text + cleared flag
        const build = spawnSync("node scripts/build-data.mjs", {
          cwd: __dirname, shell: true, encoding: "utf8", timeout: 120000,
        });
        if (build.status !== 0)
          return json(res, 500, { ok: false, step: "build", log: (build.stdout ?? "") + (build.stderr ?? "") });

        json(res, 200, { ok: true, log: (vlm.stdout ?? "") + "\n" + (build.stdout ?? "") });
      });
    },
  };
}

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
    vlmFixMiddleware(),
    // Emit a second "legacy" bundle for old browsers that don't support
    // native ES modules / modern syntax. Vite 8's default build target
    // only covers Safari 14+ / Chrome ~130+ — without this, anyone on
    // an older device sees a blank screen because their browser can't
    // parse the modern bundle's optional-chaining / nullish-coalescing
    // / BigInt syntax.
    //
    // The plugin emits BOTH a modern and a legacy bundle:
    //   - Modern Chrome/Safari (`modernTargets` below) loads the
    //     modern bundle (no overhead).
    //   - Older browsers load the legacy bundle (transpiled to ES5 +
    //     polyfills via core-js) selected by the SystemJS shim.
    //
    // Floor chosen: Service-Worker minimum — Safari 11.3+, Chrome 60+,
    // Edge 79+, Firefox 60+. Below those, SW + PWA features wouldn't
    // work anyway, so polyfill bloat for unsupported environments
    // isn't worth it.
    //
    // modernTargets raises the bar for what counts as "modern" — without
    // it, a Chrome 88 user could load the modern bundle and crash on
    // syntax it doesn't recognize. We set it to the union of "Vite-
    // default ES2022-supporting browsers".
    legacy({
      targets: [
        "ios >= 11.3",
        "safari >= 11.3",
        "chrome >= 60",
        "android >= 5",
        "edge >= 79",
        "firefox >= 60",
        "samsung >= 8",
      ],
      modernTargets: [
        "chrome >= 87",
        "safari >= 14",
        "edge >= 88",
        "firefox >= 78",
      ],
      modernPolyfills: true,
    }),
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
        // Stable app identity for installs / Play Store. Matches the implicit
        // default (start_url), so existing installed PWAs aren't re-identified.
        id: "/",
        icons: [
          // Raster icons first — Chrome's install + TWA/Bubblewrap require a
          // PNG ≥512 (a lone SVG doesn't satisfy the Play Store launcher icon
          // generation). 192 + 512 cover Lighthouse's installability check.
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          // Full-bleed dark square so Android's adaptive-icon mask never
          // exposes transparent corners. Content sits in the center safe zone.
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          // SVG kept last for browsers that prefer a crisp scalable icon.
          {
            src: "/icon.svg",
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
