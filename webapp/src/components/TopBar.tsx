import { useEffect, useState } from "react";
import { useApp, useIsRoomOwner } from "../store";

export function TopBar() {
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const roomCode = useApp((s) => s.roomCode);
  const setRoomCode = useApp((s) => s.setRoomCode);
  const randomizeRoom = useApp((s) => s.randomizeRoom);
  const isOwner = useIsRoomOwner();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(roomCode);

  function commitRoom() {
    if (/^\d{6}$/.test(draft)) setRoomCode(draft);
    else setDraft(roomCode);
    setEditing(false);
  }

  return (
    <header
      className="sticky top-0 z-30 glass-strong hairline-grad"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
        <BrandMark />

        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-mute" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลง / artist..."
            className="peer h-11 w-full rounded-xl border border-line bg-bg-card/70 pl-9 pr-9 text-base text-ink placeholder:text-ink-mute transition focus:border-brand focus:bg-bg-card focus:outline-none focus:ring-2 focus:ring-brand/30"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-mute transition hover:bg-bg-hover hover:text-ink"
              aria-label="Clear"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center">
          <RoomBadge
            roomCode={roomCode}
            isOwner={isOwner}
            editing={editing}
            draft={draft}
            onStartEdit={() => {
              setDraft(roomCode);
              setEditing(true);
            }}
            onDraftChange={setDraft}
            onCommit={commitRoom}
          />
          <button
            onClick={randomizeRoom}
            className="ml-1 rounded-lg border border-line bg-bg-card/70 p-2 text-ink-dim transition hover:bg-bg-hover hover:text-ink"
            title="สุ่มเลขห้องใหม่"
            aria-label="Random room"
          >
            <RefreshIcon />
          </button>
          <FullscreenButton />
        </div>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <div className="flex shrink-0 items-center gap-2 pr-1">
      <div className="relative grid size-9 place-items-center rounded-xl bg-brand-grad shadow-glow-sm">
        <svg viewBox="0 0 24 24" className="size-5 text-white" fill="currentColor">
          <path d="M9 17V5l12-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="6" cy="17" r="3" />
          <circle cx="18" cy="15" r="3" />
        </svg>
      </div>
      <div className="hidden flex-col leading-tight sm:flex">
        <span className="font-display text-base font-semibold tracking-tight">
          <span className="gradient-text">Chord</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          band sync
        </span>
      </div>
    </div>
  );
}

function RoomBadge({
  roomCode,
  isOwner,
  editing,
  draft,
  onStartEdit,
  onDraftChange,
  onCommit,
}: {
  roomCode: string;
  isOwner: boolean;
  editing: boolean;
  draft: string;
  onStartEdit: () => void;
  onDraftChange: (s: string) => void;
  onCommit: () => void;
}) {
  return (
    <button
      onClick={() => (editing ? onCommit() : onStartEdit())}
      className="group relative rounded-xl border border-line bg-bg-card/70 px-3 py-2 text-left transition hover:border-brand/60 hover:bg-bg-hover"
      title={isOwner ? "คุณเป็นเจ้าของห้องนี้ · แตะเพื่อแก้เลขห้อง" : "คุณเป็นผู้เข้าร่วม · แตะเพื่อแก้เลขห้อง"}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-ink-mute group-hover:text-brand">
          Room
        </span>
        <span
          className={`rounded-full px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.12em] ${
            isOwner
              ? "bg-brand-grad text-white shadow-glow-sm"
              : "border border-line bg-bg-soft text-ink-mute"
          }`}
        >
          {isOwner ? "Owner" : "Guest"}
        </span>
      </div>
      {editing ? (
        <input
          autoFocus
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          value={draft}
          onChange={(e) =>
            onDraftChange(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          onBlur={onCommit}
          onKeyDown={(e) => e.key === "Enter" && onCommit()}
          className="block w-[5.5rem] bg-transparent font-mono text-sm font-semibold tracking-[0.18em] text-ink outline-none sm:text-base"
        />
      ) : (
        <span className="block font-mono text-sm font-semibold tracking-[0.18em] text-ink sm:text-base">
          {roomCode}
        </span>
      )}
    </button>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function FullscreenButton() {
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    const sync = () => setIsFs(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  function toggle() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  return (
    <button
      onClick={toggle}
      className="ml-1 rounded-lg border border-line bg-bg-card/70 p-2 text-ink-dim transition hover:bg-bg-hover hover:text-ink"
      title={isFs ? "ออกจาก Fullscreen" : "Fullscreen (ซ่อนแถบ browser)"}
      aria-label="Toggle fullscreen"
    >
      {isFs ? <ExitFsIcon /> : <EnterFsIcon />}
    </button>
  );
}

function EnterFsIcon() {
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
      <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
    </svg>
  );
}

function ExitFsIcon() {
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
      <path d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
    </svg>
  );
}

function RefreshIcon() {
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
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
