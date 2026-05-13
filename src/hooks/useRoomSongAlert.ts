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
      try {
        const notif = new Notification("Chord — เพลงใหม่ในห้อง", {
          body: song.name,
          icon: "/icon.svg",
          // Same tag → newest replaces previous; we never stack alerts.
          tag: "chord-room-song",
        });
        notif.onclick = () => {
          window.focus();
          notif.close();
        };
      } catch {
        // Some browsers throw if the user revoked permission between the
        // permission check and the constructor call — silently ignore.
      }
    }
  }, [room?.songId, room?.pickedBy, clientId, byId, open, autoOpen]);
}
