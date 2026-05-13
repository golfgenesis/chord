import { useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import type { Playlist } from "../types";

export function PlaylistPicker() {
  const playlists = useApp((s) => s.playlists);
  const activePlaylistId = useApp((s) => s.activePlaylistId);
  const setActivePlaylist = useApp((s) => s.setActivePlaylist);
  const createPlaylist = useApp((s) => s.createPlaylist);
  const [creating, setCreating] = useState(false);

  const active = playlists.find((p) => p.id === activePlaylistId) ?? null;

  return (
    <div className="border-b border-line/60 bg-bg-soft/40">
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 no-scrollbar">
        {playlists.map((p) => (
          <PlaylistPill
            key={p.id}
            playlist={p}
            active={activePlaylistId === p.id}
            onClick={() => setActivePlaylist(p.id)}
          />
        ))}
        <button
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-brand/60 bg-brand-soft px-3.5 py-1.5 text-sm font-medium text-brand transition hover:border-brand hover:bg-brand/15"
        >
          <PlusIcon className="size-3.5" />
          {playlists.length === 0 ? "สร้าง Playlist แรก" : "Playlist ใหม่"}
        </button>
      </div>

      {active && <PlaylistHeader playlist={active} />}

      {creating && (
        <CreateSheet
          onClose={() => setCreating(false)}
          onCreate={(name) => {
            createPlaylist(name);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function PlaylistPill({
  playlist,
  active,
  onClick,
}: {
  playlist: Playlist;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 rounded-full px-3.5 py-1.5 text-sm transition ${
        active
          ? "bg-brand-grad text-white shadow-glow-sm"
          : "border border-line bg-bg-card/60 text-ink-dim hover:bg-bg-hover hover:text-ink"
      }`}
    >
      <span className="font-medium">{playlist.name}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
          active ? "bg-white/25 text-white" : "bg-bg/60 text-ink-mute"
        }`}
      >
        {playlist.songIds?.length ?? 0}
      </span>
    </button>
  );
}

function PlaylistHeader({ playlist }: { playlist: Playlist }) {
  const renamePlaylist = useApp((s) => s.renamePlaylist);
  const deletePlaylist = useApp((s) => s.deletePlaylist);
  const [mode, setMode] = useState<"view" | "rename" | "confirmDelete">("view");
  const [draft, setDraft] = useState(playlist.name);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== playlist.name) {
      renamePlaylist(playlist.id, trimmed);
    }
    setMode("view");
  }

  function cancel() {
    setDraft(playlist.name);
    setMode("view");
  }

  return (
    <div className="border-t border-line/40 px-3 py-2.5">
      {mode === "rename" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
          className="flex items-center gap-2"
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            ชื่อ
          </span>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
            className="flex-1 rounded-md border border-brand bg-bg-soft px-2.5 py-1.5 text-base font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-dim transition hover:bg-bg-hover hover:text-ink"
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            className="rounded-md bg-brand-grad px-3 py-1.5 text-sm font-medium text-white shadow-glow-sm transition hover:brightness-110"
          >
            บันทึก
          </button>
        </form>
      )}

      {mode === "confirmDelete" && (
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-sm text-danger">
            ลบ <span className="font-semibold">"{playlist.name}"</span> ?
          </span>
          <button
            onClick={() => setMode("view")}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-dim transition hover:bg-bg-hover hover:text-ink"
          >
            ยกเลิก
          </button>
          <button
            onClick={() => deletePlaylist(playlist.id)}
            className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
          >
            ลบเลย
          </button>
        </div>
      )}

      {mode === "view" && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-base font-semibold text-ink">
              {playlist.name}
            </h3>
            <p className="text-[11px] uppercase tracking-[0.16em] text-ink-mute">
              {playlist.songIds?.length ?? 0} เพลง
            </p>
          </div>
          <button
            onClick={() => {
              setDraft(playlist.name);
              setMode("rename");
            }}
            className="rounded-lg border border-line bg-bg-card/60 p-2 text-ink-dim transition hover:border-brand/50 hover:bg-bg-hover hover:text-ink"
            aria-label="แก้ไขชื่อ"
            title="แก้ไขชื่อ"
          >
            <EditIcon />
          </button>
          <button
            onClick={() => setMode("confirmDelete")}
            className="rounded-lg border border-line bg-bg-card/60 p-2 text-ink-dim transition hover:border-danger/50 hover:bg-bg-hover hover:text-danger"
            aria-label="ลบ Playlist"
            title="ลบ Playlist"
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function CreateSheet({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

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
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-brand-grad text-white shadow-glow-sm">
            <PlusIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-display text-lg font-semibold text-ink">
              สร้าง Playlist ใหม่
            </h3>
            <p className="text-xs text-ink-mute">
              ใส่ชื่อสั้นๆ จำง่าย เช่น "งานเลี้ยง", "set 1"
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) onCreate(trimmed);
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อ Playlist..."
            maxLength={40}
            className="w-full rounded-lg border border-line bg-bg-soft px-3 py-3 text-base text-ink placeholder:text-ink-mute focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-line py-2.5 font-medium text-ink-dim transition hover:bg-bg-hover hover:text-ink"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={!trimmed}
              className="flex-1 rounded-lg bg-brand-grad py-2.5 font-medium text-white shadow-glow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              สร้าง
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function PlusIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
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
      className="size-4"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}
