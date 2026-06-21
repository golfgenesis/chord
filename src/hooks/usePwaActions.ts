import { useEffect, useState } from "react";
import { isInstalledPWA, isIOS } from "../lib/platform";

// Chrome's beforeinstallprompt isn't in lib.dom.d.ts yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallPrompt {
  /** Whether there's anything to install — a stashed Chrome `beforeinstallprompt`,
   *  or iOS Safari where we can only show manual instructions. False once the
   *  app is already running as an installed PWA. */
  canInstall: boolean;
  /** Run the install flow. Resolves `true` when the caller must show the iOS
   *  instruction sheet (no programmatic install API on iOS); `false` when the
   *  native Chrome prompt already handled it. */
  trigger: () => Promise<boolean>;
}

// Two distinct install flows, shared by the desktop TopBar button and the
// mobile profile menu:
//   - Chrome / Edge / Android — the browser fires `beforeinstallprompt`, we
//     stash it, and trigger() calls .prompt() to show the native dialog.
//   - iOS Safari — no programmatic install API exists; trigger() returns true
//     so the caller can show the manual instruction sheet.
//
// The listener must be mounted *before* `beforeinstallprompt` fires (it fires
// early and only once), so call this hook from a persistently-mounted
// component — not from a popover that mounts on demand.
export function useInstallPrompt(): InstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(isInstalledPWA);
  const [ios] = useState(isIOS);

  useEffect(() => {
    if (hidden) return;
    function onPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setHidden(true);
      setDeferred(null);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [hidden]);

  // Chrome on desktop without PWA criteria met → nothing to install and not
  // iOS, so canInstall stays false and callers hide the affordance.
  const canInstall = !hidden && (!!deferred || ios);

  async function trigger(): Promise<boolean> {
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setHidden(true);
      setDeferred(null);
      return false;
    }
    return ios; // iOS → caller shows the instruction sheet
  }

  return { canInstall, trigger };
}

export interface ShareRoom {
  /** True for ~1.6s after a clipboard-fallback copy (desktop / browsers with
   *  no navigator.share) so the UI can flash a check mark. */
  copied: boolean;
  share: () => Promise<void>;
}

export function useShareRoom(roomCode: string): ShareRoom {
  // After a successful copy, flash a check mark for a moment so the user gets
  // visual feedback even when the native share sheet didn't open (e.g. desktop
  // browsers fall back to the clipboard).
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = `${window.location.origin}/${roomCode}`;
    const shareData = {
      title: "Chord — band sync",
      text: `เข้ามาที่ห้อง ${roomCode} กันนะ`,
      url,
    };
    // navigator.share is gated behind a user gesture on iOS/Android and throws
    // "AbortError" if the user dismisses the sheet — that's not a real error,
    // just a no-op.
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — nothing more we can do
    }
  }

  return { copied, share };
}
