import { useEffect } from "react";

// Keep the screen awake while `active` is true (i.e. the chord sheet is open).
// Musicians read off the screen hands-free, so letting it sleep mid-song is a
// real annoyance. Uses the Screen Wake Lock API where available; a silent
// no-op on browsers without it (notably iOS Safari < 16.4).
//
// Gotcha baked in: the OS releases the sentinel whenever the page is hidden
// (tab switch, phone auto-lock, app backgrounded). We re-acquire on the next
// `visibilitychange → visible` so the lock survives a glance away — same
// pattern the SW update-poll uses in main.tsx.
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    // Typed as always-present in lib.dom, but undefined at runtime on
    // unsupported browsers — cast so the guard is legitimate.
    const wl = navigator.wakeLock as WakeLock | undefined;
    if (!wl) return;

    let sentinel: WakeLockSentinel | null = null;
    // Set on cleanup so a request still in flight when the sheet closes
    // releases itself instead of leaking a lock.
    let released = false;

    const acquire = async () => {
      if (released || sentinel || document.visibilityState !== "visible") return;
      try {
        const s = await wl.request("screen");
        if (released) {
          s.release().catch(() => {});
          return;
        }
        sentinel = s;
        // The OS fires "release" when it drops the lock (page hidden). Clear
        // our handle so the visibility handler can re-acquire on return.
        s.addEventListener("release", () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        // request() rejects under battery-saver / permissions policy — bail quietly.
        sentinel = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
