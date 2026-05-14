import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useApp } from "../store";
import { useVisibleSongs } from "../hooks/useVisibleSongs";
import { useCachedSongIds } from "../lib/offlineDownload";
import type { Song } from "../types";
import { PlusIcon, TrashIcon } from "./icons";

export function SongList() {
  const songs = useVisibleSongs();
  // Use the FULL song dataset (not the filtered visible list) to compute
  // cache membership — a song should look cached on every tab regardless
  // of whether the user has it filtered into view right now.
  const allSongs = useApp((s) => s.songs);
  const cachedSongIds = useCachedSongIds(allSongs);
  const tab = useApp((s) => s.tab);
  const activePlaylistId = useApp((s) => s.activePlaylistId);
  const query = useApp((s) => s.query);
  // The active playlist is "mine" only when it's in our local playlist
  // array — playlists belonging to other room members aren't editable
  // from this device (no add / remove / reorder).
  const isActivePlaylistMine = useApp((s) =>
    s.playlists.some((p) => p.id === s.activePlaylistId),
  );

  // Refs + state for the floating "back to top" button. Virtuoso has its own
  // imperative scroll API; the sortable branch uses a plain scrollable div.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const sortableScrollRef = useRef<HTMLDivElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  function scrollToTop() {
    virtuosoRef.current?.scrollToIndex({ index: 0, behavior: "smooth" });
    sortableScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setShowScrollTop(false);
  }

  if (tab === "playlists" && !activePlaylistId) {
    return (
      <Empty
        title="ยังไม่มี Playlist"
        hint='กดปุ่ม "Playlist ใหม่" ด้านบนเพื่อสร้าง'
      />
    );
  }
  if (!songs.length) {
    if (tab === "playlists" && activePlaylistId) {
      return (
        <Empty
          title="Playlist ว่าง"
          hint='ไปแท็บ "ทั้งหมด" แล้วกด + บนเพลงเพื่อเพิ่มเข้า playlist นี้'
        />
      );
    }
    return (
      <Empty
        title="ไม่พบเพลง"
        hint={
          tab === "favorites" ? "กด ★ บนรายการเพื่อปักเก็บ" : "ลองคำค้นอื่น"
        }
      />
    );
  }

  // Drag-and-drop reorder is only enabled when the active playlist
  // belongs to the local user — you can view someone else's list but
  // you can't rearrange their songs.
  if (
    tab === "playlists" &&
    activePlaylistId &&
    isActivePlaylistMine &&
    !query.trim()
  ) {
    return (
      <>
        <SortablePlaylist
          songs={songs}
          playlistId={activePlaylistId}
          cachedSongIds={cachedSongIds}
          scrollRef={sortableScrollRef}
          onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 0)}
        />
        <ScrollTopButton visible={showScrollTop} onClick={scrollToTop} />
      </>
    );
  }

  return (
    <>
      <Virtuoso
        ref={virtuosoRef}
        data={songs}
        className="flex-1 scrollbar-thin"
        // Explicit touch-action so iOS Safari knows this region is meant for
        // vertical scrolling — without it the nested overflow container can
        // become unresponsive to drag-pan on iPhone/iPad.
        style={{ touchAction: "pan-y" }}
        itemContent={(_i, song) => (
          <Row song={song} isCached={cachedSongIds.has(song.id)} />
        )}
        computeItemKey={(_i, song) => song.id}
        increaseViewportBy={400}
        atTopStateChange={(atTop) => setShowScrollTop(!atTop)}
      />
      <ScrollTopButton visible={showScrollTop} onClick={scrollToTop} />
    </>
  );
}

function SortablePlaylist({
  songs,
  playlistId,
  cachedSongIds,
  scrollRef,
  onScroll,
}: {
  songs: Song[];
  playlistId: string;
  cachedSongIds: Set<number>;
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  const reorderPlaylist = useApp((s) => s.reorderPlaylist);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = songs.findIndex((s) => s.id === active.id);
    const newIndex = songs.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(songs, oldIndex, newIndex).map((s) => s.id);
    reorderPlaylist(playlistId, reordered);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={songs.map((s) => s.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto scrollbar-thin"
          style={{ paddingBottom: "var(--safe-bottom)" }}
        >
          {songs.map((song) => (
            <SortableRow
              key={song.id}
              song={song}
              isCached={cachedSongIds.has(song.id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ song, isCached }: { song: Song; isCached: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: song.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <Row
        song={song}
        isCached={isCached}
        dragHandle={
          <button
            {...attributes}
            {...listeners}
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="ลากเพื่อจัดเรียง"
            title="ลากเพื่อจัดเรียง"
            className="-m-1 shrink-0 cursor-grab rounded-lg p-1.5 text-ink-mute/70 transition hover:bg-bg-hover hover:text-ink active:cursor-grabbing touch-none"
          >
            <DragHandleIcon />
          </button>
        }
      />
    </div>
  );
}

function Row({
  song,
  isCached,
  dragHandle,
}: {
  song: Song;
  isCached: boolean;
  dragHandle?: React.ReactNode;
}) {
  const open = useApp((s) => s.open);
  const isFav = useApp((s) => s.favorites.has(song.id));
  const isLatest = useApp(
    (s) => s.tab === "all" && !s.query.trim() && s.latest.includes(song.id),
  );
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  const tab = useApp((s) => s.tab);
  const activePlaylistId = useApp((s) => s.activePlaylistId);
  const removeFromPlaylist = useApp((s) => s.removeFromPlaylist);
  // The remove (trash) button only shows when the active playlist is
  // ours — you can't delete songs out of another member's list.
  const canRemoveFromActive = useApp((s) =>
    s.playlists.some((p) => p.id === s.activePlaylistId),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      className="group relative mx-3 my-0.5 flex items-center gap-2.5 overflow-hidden rounded-2xl px-3 py-3 transition-all active:scale-[0.997] hover:bg-bg-card/50"
      onClick={() => open(song)}
      role="button"
    >
      {isLatest && (
        <span className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-brand-grad opacity-90" />
      )}
      {dragHandle}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(song.id);
        }}
        className="-m-1 shrink-0 rounded-lg p-1.5 transition hover:bg-bg-hover active:scale-90"
        aria-label={isFav ? "Unfavorite" : "Favorite"}
      >
        <StarIcon filled={isFav} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-medium leading-[1.5] tracking-tight text-ink sm:text-[16px]">
            {song.name}
          </span>
          {/* A small green dot signals "cached, plays offline". Songs
              streamed live from R2 on demand carry no marker — absence
              is the cleanest way to keep the 70k-row list visually
              quiet. The outer ring is a soft halo so the dot reads as
              a status indicator, not a stray pixel. */}
          {isCached && (
            <span
              className="relative ml-0.5 grid size-2 shrink-0 place-items-center"
              title="ดาวน์โหลดแล้ว · ใช้ดูออฟไลน์ได้"
              aria-label="Offline available"
            >
              <span className="absolute size-3 rounded-full bg-emerald-500/30 blur-[2px]" />
              <span className="relative size-2 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.7)]" />
            </span>
          )}
          {isLatest && (
            <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-brand">
              ล่าสุด
            </span>
          )}
        </div>
      </div>

      {/* Everyone can add a song to their OWN playlists — the picker
          sheet only lists the local user's playlists. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setPickerOpen(true);
        }}
        className="-m-1 shrink-0 rounded-lg p-1.5 text-ink-mute transition hover:bg-bg-hover hover:text-ink active:scale-90"
        aria-label="Add to playlist"
      >
        <PlusIcon />
      </button>
      {tab === "playlists" && activePlaylistId && canRemoveFromActive && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeFromPlaylist(activePlaylistId, song.id);
          }}
          className="-m-1 shrink-0 rounded-lg p-1.5 text-danger/70 transition hover:bg-danger/10 hover:text-danger active:scale-90"
          aria-label="Remove from playlist"
        >
          <TrashIcon />
        </button>
      )}
      {pickerOpen && (
        <AddToPlaylistSheet
          songId={song.id}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function AddToPlaylistSheet({
  songId,
  onClose,
}: {
  songId: number;
  onClose: () => void;
}) {
  const playlists = useApp((s) => s.playlists);
  const addToPlaylist = useApp((s) => s.addToPlaylist);
  const createPlaylist = useApp((s) => s.createPlaylist);
  const [newName, setNewName] = useState("");

  const inLists = useMemo(
    () =>
      new Set(
        playlists.filter((p) => p.songIds.includes(songId)).map((p) => p.id),
      ),
    [playlists, songId],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/70 backdrop-blur-md animate-fade-in sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-[28px] border border-line/60 bg-bg-card/95 p-6 shadow-card backdrop-blur-2xl animate-slide-up sm:max-w-md sm:rounded-3xl"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
      >
        {/* iOS-style sheet grabber */}
        <div className="mx-auto mb-5 h-1 w-9 rounded-full bg-ink-mute/30 sm:hidden" />

        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-2xl bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/10">
            <PlusIcon />
          </span>
          <h3 className="font-display text-[19px] font-semibold tracking-[-0.015em] text-ink">
            เพิ่มลง Playlist
          </h3>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
          {playlists.length === 0 && (
            <p className="rounded-2xl bg-bg-soft/70 p-4 text-[13px] text-ink-dim">
              ยังไม่มี playlist — สร้างใหม่ด้านล่าง
            </p>
          )}
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                addToPlaylist(p.id, songId);
                onClose();
              }}
              disabled={inLists.has(p.id)}
              className="flex w-full items-center justify-between rounded-2xl border border-transparent px-4 py-3 text-left transition hover:border-line/50 hover:bg-bg-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span className="font-semibold text-ink tracking-[-0.005em]">
                {p.name}
              </span>
              <span className="text-[12px] font-medium text-ink-mute">
                {inLists.has(p.id) ? "✓ เพิ่มแล้ว" : `${p.songIds.length} เพลง`}
              </span>
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = newName.trim();
            if (!n) return;
            const id = createPlaylist(n);
            addToPlaylist(id, songId);
            onClose();
          }}
          className="mt-5 flex gap-2.5"
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="ชื่อ Playlist ใหม่..."
            className="flex-1 rounded-2xl border border-line/70 bg-bg-soft px-4 py-3 text-[15px] text-ink shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] placeholder:text-ink-mute focus:border-brand/60 focus:outline-none focus:ring-4 focus:ring-brand/15"
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="rounded-2xl bg-brand-grad px-5 text-[15px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            สร้าง
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function ScrollTopButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label="กลับไปด้านบน"
      title="กลับไปด้านบน"
      className={`fixed right-4 z-30 grid size-12 place-items-center rounded-full bg-brand-grad text-white shadow-glow ring-1 ring-white/10 transition-all duration-200 active:scale-90 sm:right-6 sm:size-[52px] ${
        visible
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-4 scale-75 opacity-0"
      }`}
      style={{ bottom: "calc(1rem + var(--safe-bottom))" }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-b from-white/25 to-transparent"
      />
      <ArrowUpIcon />
    </button>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="relative size-5"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-5 transition ${
        filled
          ? "text-accent drop-shadow-[0_0_8px_rgba(245,158,11,0.55)]"
          : "text-ink-mute group-hover:text-ink-dim"
      }`}
    >
      <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}
function DragHandleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-5"
      aria-hidden="true"
    >
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-5">
        <div
          aria-hidden
          className="absolute inset-0 -m-4 rounded-full bg-brand-grad opacity-20 blur-2xl"
        />
        <div className="relative grid size-16 place-items-center rounded-3xl bg-brand-grad-soft ring-1 ring-brand/20">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="size-8 text-brand"
          >
            <path
              d="M9 17V5l12-2v12"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="6" cy="17" r="3" />
            <circle cx="18" cy="15" r="3" />
          </svg>
        </div>
      </div>
      <p className="font-display text-[19px] font-semibold tracking-[-0.015em] text-ink">
        {title}
      </p>
      <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-ink-dim">
        {hint}
      </p>
    </div>
  );
}
