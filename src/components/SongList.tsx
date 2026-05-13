import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Virtuoso } from "react-virtuoso";
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
import { useApp, useIsRoomOwner } from "../store";
import { useVisibleSongs } from "../hooks/useVisibleSongs";
import type { Song } from "../types";

export function SongList() {
  const songs = useVisibleSongs();
  const tab = useApp((s) => s.tab);
  const activePlaylistId = useApp((s) => s.activePlaylistId);
  const query = useApp((s) => s.query);
  const isOwner = useIsRoomOwner();

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
          tab === "favorites"
            ? "กด ★ บนรายการเพื่อปักเก็บ"
            : "ลองคำค้นอื่น"
        }
      />
    );
  }

  // Owners viewing a playlist with no active search → drag-and-drop reorder.
  // Guests, search-filtered views, or other tabs use the regular virtualized
  // list (reordering a filtered subset is ambiguous).
  if (
    tab === "playlists" &&
    activePlaylistId &&
    isOwner &&
    !query.trim()
  ) {
    return <SortablePlaylist songs={songs} playlistId={activePlaylistId} />;
  }

  return (
    <Virtuoso
      data={songs}
      className="flex-1 scrollbar-thin"
      itemContent={(_i, song) => <Row song={song} />}
      computeItemKey={(_i, song) => song.id}
      increaseViewportBy={400}
    />
  );
}

function SortablePlaylist({
  songs,
  playlistId,
}: {
  songs: Song[];
  playlistId: string;
}) {
  const reorderPlaylist = useApp((s) => s.reorderPlaylist);
  // distance: 5px before drag starts → quick taps on the handle still open
  // the song; an actual drag intent is required to begin reordering.
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
          className="flex-1 overflow-y-auto scrollbar-thin"
          style={{ paddingBottom: "var(--safe-bottom)" }}
        >
          {songs.map((song) => (
            <SortableRow key={song.id} song={song} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ song }: { song: Song }) {
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
        dragHandle={
          <button
            {...attributes}
            {...listeners}
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label="ลากเพื่อจัดเรียง"
            title="ลากเพื่อจัดเรียง"
            className="-m-1.5 shrink-0 cursor-grab rounded-lg p-1.5 text-ink-mute transition hover:bg-bg-hover hover:text-ink active:cursor-grabbing touch-none"
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
  dragHandle,
}: {
  song: Song;
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
  const isOwner = useIsRoomOwner();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      className="group relative mx-2 my-0.5 flex items-center gap-2 overflow-hidden rounded-xl px-2 py-3 transition active:scale-[0.997] hover:bg-bg-card/60"
      onClick={() => open(song)}
      role="button"
    >
      {isLatest && (
        <span className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-brand-grad opacity-80" />
      )}
      {dragHandle}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(song.id);
        }}
        className="-m-1.5 shrink-0 rounded-lg p-1.5 transition hover:bg-bg-hover"
        aria-label={isFav ? "Unfavorite" : "Favorite"}
      >
        <StarIcon filled={isFav} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base text-ink">{song.name}</span>
          {isLatest && (
            <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand">
              ล่าสุด
            </span>
          )}
        </div>
      </div>

      {isOwner && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPickerOpen(true);
          }}
          className="-m-1.5 shrink-0 rounded-lg p-1.5 text-ink-mute transition hover:bg-bg-hover hover:text-ink"
          aria-label="Add to playlist"
        >
          <PlusIcon />
        </button>
      )}
      {isOwner && tab === "playlists" && activePlaylistId && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeFromPlaylist(activePlaylistId, song.id);
          }}
          className="-m-1.5 shrink-0 rounded-lg p-1.5 text-danger/70 transition hover:bg-danger/10 hover:text-danger"
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
      className="fixed inset-0 z-40 flex items-end bg-black/70 backdrop-blur-sm animate-fade-in sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-3xl border border-line bg-bg-card p-5 shadow-card animate-slide-up sm:max-w-md sm:rounded-2xl"
        style={{ paddingBottom: "calc(1.25rem + var(--safe-bottom))" }}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-grad text-white">
            <PlusIcon />
          </span>
          <h3 className="text-lg font-semibold text-ink">เพิ่มลง Playlist</h3>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
          {playlists.length === 0 && (
            <p className="rounded-lg bg-bg-soft p-3 text-sm text-ink-dim">
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
              className="flex w-full items-center justify-between rounded-lg border border-transparent px-3 py-2.5 text-left transition hover:border-line hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span className="font-medium text-ink">{p.name}</span>
              <span className="text-xs text-ink-mute">
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
          className="mt-4 flex gap-2"
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="ชื่อ Playlist ใหม่..."
            className="flex-1 rounded-lg border border-line bg-bg-soft px-3 py-2.5 text-ink placeholder:text-ink-mute focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <button className="rounded-lg bg-brand-grad px-5 font-medium text-white shadow-glow-sm transition hover:brightness-110">
            สร้าง
          </button>
        </form>
      </div>
    </div>,
    document.body,
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
      className={`size-5 transition ${filled ? "text-accent drop-shadow-[0_0_6px_rgba(245,158,11,0.5)]" : "text-ink-mute group-hover:text-ink-dim"}`}
    >
      <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
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
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 grid size-14 place-items-center rounded-2xl bg-brand-grad-soft">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="size-7 text-brand"
        >
          <path d="M9 17V5l12-2v12" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="6" cy="17" r="3" />
          <circle cx="18" cy="15" r="3" />
        </svg>
      </div>
      <p className="text-lg font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-dim">{hint}</p>
    </div>
  );
}
