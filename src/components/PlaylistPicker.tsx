import { useState } from "react";
import { createPortal } from "react-dom";
import { useApp, useIsRoomOwner } from "../store";
import type { Playlist } from "../types";

export function PlaylistPicker() {
  const playlists = useApp((s) => s.playlists);
  const activePlaylistId = useApp((s) => s.activePlaylistId);
  const setActivePlaylist = useApp((s) => s.setActivePlaylist);
  const createPlaylist = useApp((s) => s.createPlaylist);
  const isOwner = useIsRoomOwner();
  const [creating, setCreating] = useState(false);

  const active = playlists.find((p) => p.id === activePlaylistId) ?? null;

  return (
    <div className="border-b border-line/40 bg-bg-soft/30">
      <div className="flex gap-2 overflow-x-auto px-4 py-2.5 no-scrollbar">
        {playlists.map((p) => (
          <PlaylistPill
            key={p.id}
            playlist={p}
            active={activePlaylistId === p.id}
            onClick={() => setActivePlaylist(p.id)}
          />
        ))}
        {isOwner && (
          <button
            onClick={() => setCreating(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-brand/50 bg-brand-soft px-4 py-1.5 text-[13px] font-semibold text-brand transition hover:border-brand hover:bg-brand/15 active:scale-95"
          >
            <PlusIcon className="size-3.5" />
            {playlists.length === 0 ? "สร้าง Playlist แรก" : "Playlist ใหม่"}
          </button>
        )}
        {!isOwner && playlists.length === 0 && (
          <span className="flex shrink-0 items-center rounded-full border border-line/60 bg-bg-soft/60 px-4 py-1.5 text-[12px] text-ink-mute">
            เจ้าของห้องยังไม่ได้สร้าง Playlist
          </span>
        )}
      </div>

      {active && <PlaylistHeader playlist={active} isOwner={isOwner} />}

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
      className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5 text-[13px] transition-all duration-150 active:scale-95 ${
        active
          ? "bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/10"
          : "border border-line/60 bg-bg-card/60 text-ink-dim hover:bg-bg-hover hover:text-ink"
      }`}
    >
      <span className="font-semibold tracking-[-0.005em]">{playlist.name}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
          active ? "bg-white/25 text-white" : "bg-bg/60 text-ink-mute"
        }`}
      >
        {playlist.songIds?.length ?? 0}
      </span>
    </button>
  );
}

function PlaylistHeader({
  playlist,
  isOwner,
}: {
  playlist: Playlist;
  isOwner: boolean;
}) {
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
    <div className="border-t border-line/30 px-4 py-3">
      {mode === "rename" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
          className="flex items-center gap-2"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
            className="flex-1 rounded-xl border border-brand/50 bg-bg-soft px-3 py-2 text-[15px] font-semibold text-ink shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] focus:outline-none focus:ring-4 focus:ring-brand/15"
          />
          <button
            type="button"
            onClick={cancel}
            className="rounded-xl border border-line/60 bg-bg-card/60 px-3 py-2 text-[13px] font-medium text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-95"
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            className="rounded-xl bg-brand-grad px-3 py-2 text-[13px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-95"
          >
            บันทึก
          </button>
        </form>
      )}

      {mode === "confirmDelete" && (
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-[14px] leading-[1.5] text-danger">
            ลบ <span className="font-semibold">"{playlist.name}"</span> ?
          </span>
          <button
            onClick={() => setMode("view")}
            className="rounded-xl border border-line/60 bg-bg-card/60 px-3 py-2 text-[13px] font-medium text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-95"
          >
            ยกเลิก
          </button>
          <button
            onClick={() => deletePlaylist(playlist.id)}
            className="rounded-xl bg-danger px-3 py-2 text-[13px] font-semibold text-white shadow-[0_4px_16px_-4px_rgba(244,63,94,0.5)] ring-1 ring-white/10 transition hover:brightness-110 active:scale-95"
          >
            ลบเลย
          </button>
        </div>
      )}

      {mode === "view" && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-[17px] font-semibold leading-[1.5] tracking-tight text-ink sm:text-[19px] sm:leading-[1.4]">
              {playlist.name}
            </h3>
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-ink-mute">
              {playlist.songIds?.length ?? 0} เพลง
              {!isOwner && (
                <span className="ml-2 text-ink-mute/80">· read-only</span>
              )}
            </p>
          </div>
          {isOwner && (
            <>
              <IconBtn
                onClick={() => {
                  setDraft(playlist.name);
                  setMode("rename");
                }}
                aria-label="แก้ไขชื่อ"
                title="แก้ไขชื่อ"
              >
                <EditIcon />
              </IconBtn>
              <IconBtn
                onClick={() => setMode("confirmDelete")}
                aria-label="ลบ Playlist"
                title="ลบ Playlist"
                danger
              >
                <TrashIcon />
              </IconBtn>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  "aria-label": ariaLabel,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  "aria-label"?: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`grid size-9 place-items-center rounded-xl border border-line/60 bg-bg-card/60 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition active:scale-95 ${
        danger
          ? "hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
          : "hover:border-brand/40 hover:bg-bg-hover hover:text-ink"
      }`}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
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
            <PlusIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-display text-[19px] font-semibold tracking-[-0.015em] text-ink">
              สร้าง Playlist ใหม่
            </h3>
            <p className="mt-0.5 text-[13px] text-ink-mute">
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
            className="w-full rounded-2xl border border-line/70 bg-bg-soft px-4 py-3 text-[16px] text-ink shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] placeholder:text-ink-mute focus:border-brand/60 focus:outline-none focus:ring-4 focus:ring-brand/15"
          />
          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-2xl border border-line/60 bg-bg-soft py-3 text-[15px] font-semibold text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-[0.98]"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={!trimmed}
              className="flex-1 rounded-2xl bg-brand-grad py-3 text-[15px] font-semibold text-white shadow-glow ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
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
      className="size-[18px]"
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
      className="size-[18px]"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}
