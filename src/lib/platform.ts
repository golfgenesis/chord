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
 * True when the app is running as an installed PWA. Covers both Chrome's
 * standalone display mode and iOS's legacy `navigator.standalone` flag.
 */
export function isInstalledPWA(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * True on Safari (desktop Mac OR iOS — both iPhone and iPad). Excludes
 * Chrome / Edge / Firefox / Brave on Mac, all of which use a different UA.
 *
 * Used by auth.ts to force signInWithRedirect over signInWithPopup on
 * Safari: ITP (Intelligent Tracking Prevention) treats Firebase's auth
 * iframe at `*.firebaseapp.com` as third-party storage and blocks the
 * popup-to-parent state sync. Redirect keeps everything in same-tab
 * first-party context where ITP allows storage access.
 */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  // Chromium-based browsers include "Chrome" or "CriOS" (Chrome on iOS) or
  // "Edg" in UA — exclude them first.
  if (/Chrome|CriOS|Edg|Edge|OPR|Opera|Firefox|FxiOS/.test(ua)) return false;
  // Genuine Safari includes "Safari" and "Version/" but not Chrome markers.
  return /Safari/.test(ua) && /Version\//.test(ua);
}
