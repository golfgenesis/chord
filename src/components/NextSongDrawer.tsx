import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Virtuoso } from "react-virtuoso";
import { useApp } from "../store";
import { searchSongs } from "../lib/search";
import type { Song } from "../types";
import { CheckIcon, XIcon } from "./icons";

/**
 * Right-side drawer for queuing the *next* song without leaving fullscreen.
 * Opened by an edge-swipe (or the handle) on the Fullscreen viewer. Tapping a
 * song sets it as the queue target; the viewer advances to it when the user
 * taps the "next" chip.
 *
 * The catalogue is ~70k rows so the list is virtualized. With no search query
 * it surfaces the "likely next" songs (favorites + recent + playlist members)
 * instead of dumping the whole catalogue at the top.
 */
export function NextSongDrawer({
  open,
  onClose,
  currentId,
  nextId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  currentId: number;
  nextId: number | null;
  onPick: (song: Song) => void;
}) {
  const songs = useApp((s) => s.songs);
  const songIndex = useApp((s) => s.songIndex);
  const byId = useApp((s) => s.byId);
  const latest = useApp((s) => s.latest);

  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const list = useMemo<Song[]>(() => {
    if (q.trim()) return searchSongs(songs, songIndex, q);
    // No query → the whole catalogue, with recently-played pinned on top —
    // same ordering as the home list (useVisibleSongs, "all" tab).
    if (latest.length === 0) return songs;
    const latestSet = new Set(latest);
    const pinned: Song[] = [];
    for (const id of latest) {
      const s = byId.get(id);
      if (s) pinned.push(s);
    }
    const rest = songs.filter((s) => !latestSet.has(s.id));
    return [...pinned, ...rest];
  }, [q, songs, songIndex, byId, latest]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[55] flex justify-end">
      <div
        className="absolute inset-0 animate-fade-in bg-black/50"
        onClick={onClose}
      />
      <div
        className="relative flex h-full w-[86%] max-w-sm animate-slide-in-right flex-col border-l border-white/10 bg-bg-soft/95 shadow-2xl backdrop-blur-xl"
        style={{ paddingTop: "var(--safe-top)" }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line/40 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-ink-mute">
              คิวถัดไป
            </div>
            <h3 className="truncate font-display text-[17px] font-semibold tracking-tight text-ink">
              เลือกเพลงถัดไป
            </h3>
          </div>
          <button
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-mute transition hover:bg-bg-hover hover:text-ink"
            aria-label="ปิด"
          >
            <XIcon className="size-[18px]" />
          </button>
        </div>

        <div className="shrink-0 px-4 py-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาเพลง / artist..."
            className="h-11 w-full rounded-xl border border-line/80 bg-bg-card/60 px-3.5 text-[15px] font-medium text-ink placeholder:font-normal placeholder:text-ink-mute focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-2 focus:ring-brand/20"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>

        <div className="min-h-0 flex-1" style={{ touchAction: "pan-y" }}>
          {list.length === 0 ? (
            <div className="px-4 py-8 text-center text-[14px] text-ink-mute">
              ไม่พบเพลง
            </div>
          ) : (
            <Virtuoso
              style={{ height: "100%" }}
              data={list}
              itemContent={(_, song) => (
                <DrawerRow
                  song={song}
                  isCurrent={song.id === currentId}
                  isNext={song.id === nextId}
                  onPick={() => onPick(song)}
                />
              )}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DrawerRow({
  song,
  isCurrent,
  isNext,
  onPick,
}: {
  song: Song;
  isCurrent: boolean;
  isNext: boolean;
  onPick: () => void;
}) {
  return (
    <div className="px-3 py-0.5">
      <button
        onClick={onPick}
        disabled={isCurrent}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition active:scale-[0.99] ${
          isNext
            ? "border border-brand/40 bg-brand-soft"
            : "border border-transparent hover:bg-bg-hover"
        } ${isCurrent ? "opacity-50" : ""}`}
      >
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
          {song.name}
        </span>
        {isCurrent ? (
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-ink-mute">
            กำลังเล่น
          </span>
        ) : isNext ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-brand">
            <CheckIcon className="size-3.5" />
            ถัดไป
          </span>
        ) : null}
      </button>
    </div>
  );
}
