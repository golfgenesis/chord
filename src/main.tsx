import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import App from "./App.tsx";

// Register the PWA service worker explicitly. We rely on this for offline
// image caching, so we can't depend on vite-plugin-pwa's auto-inject — it
// silently doesn't run for some injectManifest dev-mode configurations,
// leaving offline-mode broken with no signal that the SW never registered.
// `immediate: true` registers at import time instead of waiting for
// `load`, and `registerType: "autoUpdate"` in vite.config.ts means new
// SWs activate automatically (skipWaiting + clientsClaim are inside sw.ts).
registerSW({ immediate: true });

// Auto-reload the page when a new service worker takes control so a
// freshly-deployed SW becomes effective without manual hard-refresh.
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
