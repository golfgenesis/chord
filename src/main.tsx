import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import App from "./App.tsx";
import { initAnalytics } from "./lib/analytics";

// How often (ms) to ping the SW endpoint and ask the browser to check for
// an updated worker. Chrome already does this on every navigation + every
// 24h; Safari / iOS-PWA effectively never does. One minute is small
// enough that a deploy lands on every open device within ~a minute,
// large enough not to be a network burden — `update()` is a single
// conditional HEAD/GET for /sw.js, served fresh per Cache-Control.
const SW_UPDATE_INTERVAL_MS = 60_000;

// Register the PWA service worker explicitly. We rely on this for offline
// image caching, so we can't depend on vite-plugin-pwa's auto-inject — it
// silently doesn't run for some injectManifest dev-mode configurations,
// leaving offline-mode broken with no signal that the SW never registered.
// `immediate: true` registers at import time instead of waiting for
// `load`, and `registerType: "autoUpdate"` in vite.config.ts means new
// SWs activate automatically (skipWaiting + clientsClaim are inside sw.ts).
//
// onRegisteredSW wires the polling + foreground-trigger that's the entire
// reason this isn't a one-liner — see the long comment below.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    // Why we need this at all:
    //   Chrome auto-checks for a new sw.js on every page navigation AND
    //   every 24h while the tab is open. Safari (especially iOS Safari and
    //   home-screen-launched PWAs) effectively never does — it'll happily
    //   keep serving a months-old SW from disk until the user manually
    //   removes the website from Settings → Safari → Advanced → Website
    //   Data. So a deploy never reaches Safari users without help.
    //
    // Two triggers, deliberately layered:
    //   1. Periodic poll while the tab is alive — covers the singer who
    //      leaves the iPad open for a 3-hour rehearsal and we ship a fix
    //      mid-set. update() resolves to a noop when sw.js hasn't changed.
    //   2. visibilitychange → visible — the single most important one for
    //      iOS PWAs. When the user closes the app and re-launches from
    //      home screen, iOS rehydrates the prior tab; the JS module top
    //      level does NOT re-execute, so `registerSW()` above doesn't run
    //      a second time. visibilitychange is the only signal we get that
    //      the user just "opened the app".
    const tryUpdate = () => {
      registration.update().catch(() => {
        // Network down, server 5xx, ad-blocker injection — none of these
        // should surface; we'll just try again on the next tick / focus.
      });
    };
    setInterval(tryUpdate, SW_UPDATE_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tryUpdate();
    });
  },
});

// Auto-reload the page when a new service worker REPLACES the one that was
// already controlling this page, so a freshly-deployed SW becomes effective
// without a manual hard-refresh. Pairs with the update triggers above: those
// find the new SW, this flips the page over to it the moment it activates.
//
// `controllerAtLoad` guard — the bug it fixes:
//   On an iOS home-screen PWA (standalone), relaunching often starts the page
//   UNCONTROLLED; the SW then claims it and fires `controllerchange` even
//   though nothing was upgraded. The old code reloaded on that first claim,
//   and because each relaunch repeats the pattern (plus the visibilitychange
//   update-poll above), it spun into an endless reload — the app froze on the
//   boot splash and never mounted. We now reload ONLY when a controller was
//   ALREADY present at page load (a genuine old→new SW handover); the initial
//   claim of a fresh client is a no-op. `refreshing` keeps it a one-shot.
if ("serviceWorker" in navigator) {
  const controllerAtLoad = navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !controllerAtLoad) return;
    refreshing = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Google Analytics — self-deferred to browser idle (see lib/analytics.ts), so
// this call never delays mount. No-op in dev.
initAnalytics();
