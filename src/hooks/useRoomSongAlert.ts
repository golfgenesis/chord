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
 * sheet themselves. Songs that were already in the room *before* this
 * hook mounted (`pickedAt < mountedAt`) are treated as baseline only —
 * they update bookkeeping but don't pop the fullscreen sheet, so a fresh
 * page load always lands on the list/home view first. Only picks made
 * *after* mount auto-open. Deep-linking from a shared `/{room}/{songId}`
 * URL is handled separately in `store.init()` and is unaffected by this
 * guard.
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
  // Track the picker's "still in fullscreen" flag so we can detect the
  // transition where the picker closes their viewer — when that happens
  // receivers should close too, but a receiver closing locally is private
  // and never flips this flag.
  const lastPickerViewing = useRef<boolean>(true);
  // Stamp the moment this hook mounts. Any room song whose `pickedAt` is
  // older than this is treated as pre-existing state — we record it as
  // baseline but don't auto-open, so the user lands on the home page on
  // a fresh page load instead of getting yanked straight into fullscreen.
  // Initialized lazily in the effect to keep render pure.
  const mountedAt = useRef<number | null>(null);

  useEffect(() => {
    if (mountedAt.current === null) mountedAt.current = Date.now();
    const songId = room?.songId;
    // pickerViewing is optional on the wire (legacy rooms predate it).
    // Treat missing as `true` so old snapshots behave the same as before.
    const pickerViewing = room?.pickerViewing !== false;
    const prevSongId = lastSongId.current;
    const prevPickerViewing = lastPickerViewing.current;
    lastSongId.current = songId ?? null;
    lastPickerViewing.current = pickerViewing;

    if (!songId) return;

    // The local user picked this themselves — `open()` (and any later
    // close broadcast) already ran. Skip auto-open AND skip auto-close.
    if (room?.pickedBy === clientId) return;

    const song = byId.get(songId);
    if (!song) return;

    // Pre-existing song in the room when we landed: record bookkeeping but
    // don't pop fullscreen. Fresh page load should show the home/list view
    // first; only picks made after mount auto-open.
    const pickedAt = room?.pickedAt ?? 0;
    if (pickedAt > 0 && pickedAt < mountedAt.current) return;

    // Detect the "picker just closed" transition: same song, but
    // pickerViewing flipped true → false. Mirror their close locally if
    // (and only if) we're currently looking at the same song they were.
    const closedByPicker =
      songId === prevSongId && prevPickerViewing && !pickerViewing;
    if (closedByPicker) {
      const cur = useApp.getState().viewing;
      if (cur && cur.id === songId) useApp.getState().close();
      return;
    }

    // Auto-open trigger: a new song appeared OR the picker re-opened the
    // existing one. If they've closed and not re-engaged (pickerViewing
    // still false), don't pop the sheet — just update bookkeeping.
    const newSong = songId !== prevSongId;
    const pickerReopened =
      songId === prevSongId && !prevPickerViewing && pickerViewing;
    if (!newSong && !pickerReopened) return;
    if (!pickerViewing) return;

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
  }, [room?.songId, room?.pickedBy, room?.pickedAt, room?.pickerViewing, clientId, byId, open, autoOpen, roomCode]);
}
