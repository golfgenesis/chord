// Platform / install-state detection. Centralized so the iPad-as-desktop-Mac
// workaround stays consistent across components — see [CLAUDE.md](../CLAUDE.md)
// for why the basic `iPhone|iPad` regex isn't enough.

/**
 * True on iPhone / iPad / iPod, including modern iPad Safari which reports
 * its user agent as desktop Mac (Apple ships "request desktop site by
 * default" since iOS 13). The Mac-with-touch heuristic catches that case:
 * real desktop Macs have 0 touch points, iPads have 5.
 */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

/**
 * True when the app is running as an installed PWA *or* inside our Trusted
 * Web Activity (the Play Store Android wrapper). All of these contexts block
 * cross-origin `window.open`, so OAuth must go through signInWithRedirect
 * (popup silently fails) — see `shouldUseRedirect()` in auth.ts.
 *
 * Detection layers:
 *   - display-mode standalone / fullscreen / minimal-ui — the manifest uses
 *     `display: fullscreen` with a display_override across all three, so the
 *     resolved mode in an installed context can be any of them (checking only
 *     `standalone` missed the fullscreen case → popup path → broken login).
 *   - iOS `navigator.standalone` — legacy home-screen PWA flag.
 *   - TWA — the launch document's referrer is `android-app://<package>`. That
 *     referrer only survives the first navigation, so we latch it in
 *     sessionStorage for the rest of the session (SPA route changes / reloads).
 */
export function isInstalledPWA(): boolean {
  const standaloneLike =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches;
  const iosStandalone =
    (navigator as { standalone?: boolean }).standalone === true;
  let twa = false;
  try {
    if (document.referrer.startsWith("android-app://")) {
      sessionStorage.setItem("chord/twa", "1");
    }
    twa = sessionStorage.getItem("chord/twa") === "1";
  } catch {
    twa = document.referrer.startsWith("android-app://");
  }
  return standaloneLike || iosStandalone || twa;
}
