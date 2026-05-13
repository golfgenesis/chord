import { useEffect, useRef } from "react";
import { useApp } from "../store";

/**
 * Watches the shared room state for song changes made by OTHER clients
 * and:
 *   1. Auto-opens the chord-sheet fullscreen view for that song.
 *   2. Fires a Web Notification (when permission has been granted and
 *      the user has the app permitted to show OS-level pop-ups).
 *
 * Picks made by the local client are ignored — they already opened the
 * sheet themselves and don't need to be notified about their own action.
 * The very first room snapshot after page load is also ignored, otherwise
 * users would get a notification for the song that was already showing
 * when they joined.
 */
export function useRoomSongAlert() {
  const room = useApp((s) => s.room);
  const clientId = useApp((s) => s.clientId);
  const byId = useApp((s) => s.byId);
  const open = useApp((s) => s.open);
  const autoOpen = useApp((s) => s.autoOpen);
  const roomCode = useApp((s) => s.roomCode);

  // Ask for notification permission as early as possible. Browsers require
  // a user gesture context — calling requestPermission() directly on mount
  // is silently rejected. So we attach one-shot listeners and fire the
  // prompt on the very first user interaction (any tap or key press).
  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") return;
    function ask() {
      Notification.requestPermission().catch(() => {});
      document.removeEventListener("pointerdown", ask);
      document.removeEventListener("keydown", ask);
    }
    document.addEventListener("pointerdown", ask, { once: true });
    document.addEventListener("keydown", ask, { once: true });
    return () => {
      document.removeEventListener("pointerdown", ask);
      document.removeEventListener("keydown", ask);
    };
  }, []);

  // Track the last songId we acted on so we don't re-fire when the same
  // snapshot bounces back (subscription replays, owner re-publishes, etc.).
  const lastSongId = useRef<number | null>(null);
  // Treat the first snapshot as the room's pre-existing state, not a
  // "someone just picked a song" event.
  const isInitial = useRef(true);

  useEffect(() => {
    const songId = room?.songId;
    if (!songId) return;

    if (isInitial.current) {
      isInitial.current = false;
      lastSongId.current = songId;
      return;
    }

    if (songId === lastSongId.current) return;
    lastSongId.current = songId;

    // The local user picked this themselves — `open()` already ran.
    if (room?.pickedBy === clientId) return;

    const song = byId.get(songId);
    if (!song) return;

    // Auto-open ON: pop the fullscreen chord sheet as the primary feedback.
    // Auto-open OFF: the user explicitly doesn't want the takeover, so the
    // OS notification becomes the primary feedback instead (see below).
    // The `false` flag suppresses re-broadcast — this is just a local
    // reflection of what a bandmate already published.
    if (autoOpen) {
      open(song, false);
    }

    // Notification policy:
    //   - autoOpen OFF → always notify (the user opted out of the takeover
    //     and otherwise has no signal that the song changed).
    //   - autoOpen ON  → only notify when the tab is hidden; if they're
    //     looking, the fullscreen we just opened is signal enough.
    const shouldNotify =
      "Notification" in window &&
      Notification.permission === "granted" &&
      (!autoOpen || document.visibilityState !== "visible");

    if (shouldNotify) {
      // Build the deep link the user lands on when they tap the notif:
      // the current room URL. SW's notificationclick handler will either
      // focus an existing tab or open a new one at this URL.
      // Deep link straight into the song's fullscreen view — clicking the
      // notification skips the list and drops the user on the chord sheet
      // their bandmate just picked.
      const url = `${window.location.origin}/${roomCode}/${song.id}`;
      const title = "Chord — เพลงใหม่ในห้อง";
      const opts: NotificationOptions = {
        body: song.name,
        icon: "/icon.svg",
        badge: "/icon.svg",
        // Same tag → newest replaces previous; we never stack alerts.
        tag: "chord-room-song",
        data: { url },
      };
      // Prefer the SW's showNotification because it survives the page being
      // closed and can re-open the PWA. Fall back to the page-level
      // Notification constructor on browsers without a registered SW.
      (async () => {
        try {
          if ("serviceWorker" in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
              await reg.showNotification(title, opts);
              return;
            }
          }
          const notif = new Notification(title, opts);
          notif.onclick = () => {
            window.focus();
            notif.close();
          };
        } catch {
          // Permission revoked between check and call, or browser refused —
          // silently drop. The in-app NowPlaying banner still updates.
        }
      })();
    }
  }, [room?.songId, room?.pickedBy, clientId, byId, open, autoOpen, roomCode]);
}
