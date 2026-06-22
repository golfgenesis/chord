// Google AdSense loader (Phase 2 — the higher-risk revenue stream).
//
// DORMANT until you paste your publisher id below: while ADSENSE_CLIENT is "",
// isAdSenseConfigured() is false and <AdUnit> renders nothing anywhere. After
// AdSense approves the site, set ADSENSE_CLIENT (and add the `ads.txt` line),
// then place <AdUnit slot="…"> on browse surfaces ONLY — never the chord view
// (see MARKETING.md). Ads are additionally gated on consent + non-premium.
//
// Like analytics, the loader is lazy + skipped in dev.

export const ADSENSE_CLIENT = ""; // e.g. "ca-pub-1234567890123456"

let loaded = false;

export function isAdSenseConfigured(): boolean {
  return Boolean(ADSENSE_CLIENT);
}

export function loadAdSense(): void {
  if (
    loaded ||
    !ADSENSE_CLIENT ||
    import.meta.env.DEV ||
    typeof window === "undefined"
  )
    return;
  loaded = true;
  const s = document.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous";
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
  document.head.appendChild(s);
}
