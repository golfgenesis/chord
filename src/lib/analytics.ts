// Google Analytics 4 (gtag.js).
//
// Loaded LAZILY — deferred to browser idle so the 3rd-party script never
// competes with first paint. This app is tuned hard for first paint (inline
// boot splash, `<link rel=preload>` for songs.bin, print-media font swap), and
// injecting gtag eagerly in <head> would steal bandwidth/CPU on the cold mobile
// load the whole shell is optimised for. Mirrors the tetono project's "defer GA
// to idle" decision (which is what fixed its mobile PageSpeed score).
//
// The measurement id is fixed here (it's public anyway — it ships in the page).
// Skipped entirely in dev so local work never pollutes the GA property.

const GA_ID = "G-4L5B190T45";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let started = false;

export function initAnalytics(): void {
  if (started || import.meta.env.DEV || typeof window === "undefined") return;
  started = true;

  const boot = () => {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    const gtag = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    window.gtag = gtag;
    // NOTE: the PDPA consent banner is hidden for now (see MARKETING.md), so GA
    // collects normally. To re-enable Consent Mode v2: render <ConsentBanner />
    // again in App.tsx and restore the gtag("consent","default",…) block here
    // (default denied, read getStoredConsent() from ./consent).
    gtag("js", new Date());
    gtag("config", GA_ID);
  };

  // Fire after the shell is interactive. requestIdleCallback where supported
  // (Chrome/Firefox/Edge); a short timeout fallback for Safari.
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(boot, { timeout: 5000 });
  } else {
    setTimeout(boot, 2500);
  }
}
