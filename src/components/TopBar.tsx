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
  function cancelRoom() {
    setDraft(roomCode);
    setEditing(false);
  }

  return (
    <header
      className="sticky top-0 z-30 glass-strong hairline-grad"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 sm:gap-3.5 sm:px-5 sm:py-4">
        <BrandMark />

        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ink-mute" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลง / artist..."
            className="peer h-12 w-full rounded-2xl border border-line/80 bg-bg-card/60 pl-11 pr-10 text-base font-medium text-ink placeholder:font-normal placeholder:text-ink-mute shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-4 focus:ring-brand/15 sm:h-[52px] sm:text-[17px] sm:placeholder:text-[15px]"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-ink-mute transition hover:bg-bg-hover hover:text-ink"
              aria-label="Clear"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
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
            onCancel={cancelRoom}
          />
          {!editing && (
            <>
              <IconButton
                onClick={randomizeRoom}
                title="สุ่มเลขห้องใหม่"
                aria-label="Random room"
              >
                <RefreshIcon />
              </IconButton>
              <FullscreenButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <div className="flex shrink-0 items-center gap-2.5 pr-1">
      <div className="relative grid size-10 place-items-center rounded-[12px] bg-brand-grad shadow-glow ring-1 ring-white/10">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[12px] bg-gradient-to-b from-white/25 to-transparent"
        />
        <svg viewBox="0 0 24 24" className="relative size-[22px] text-white" fill="currentColor">
          <path d="M9 17V5l12-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="6" cy="17" r="3" />
          <circle cx="18" cy="15" r="3" />
        </svg>
      </div>
      <div className="hidden flex-col leading-[1.05] sm:flex">
        <span className="font-display text-[17px] font-semibold tracking-[-0.015em]">
          <span className="gradient-text">Chord</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.22em] text-ink-mute">
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
  onCancel,
}: {
  roomCode: string;
  isOwner: boolean;
  editing: boolean;
  draft: string;
  onStartEdit: () => void;
  onDraftChange: (s: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const labelRow = (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-ink-mute">
        Room
      </span>
      <span
        className={`rounded-full px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.14em] ${
          isOwner
            ? "bg-brand-grad text-white shadow-glow-sm"
            : "border border-line/80 bg-bg-soft text-ink-mute"
        }`}
      >
        {isOwner ? "Owner" : "Guest"}
      </span>
    </div>
  );

  if (editing) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-2xl border border-brand/50 bg-bg-card/80 px-3 py-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_0_4px_rgba(139,92,246,0.12)] transition"
        title="แก้เลขห้อง — กด ✓ หรือ Enter เพื่อยืนยัน"
      >
        <div className="flex flex-col">
          {labelRow}
          <input
            autoFocus
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={draft}
            onChange={(e) =>
              onDraftChange(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit();
              else if (e.key === "Escape") onCancel();
            }}
            className="block w-[5.5rem] bg-transparent font-mono text-[15px] font-semibold tracking-[0.2em] text-ink outline-none sm:text-base"
          />
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="grid size-8 shrink-0 place-items-center rounded-xl border border-line/80 bg-bg-soft/60 text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-95"
          title="ยกเลิก (Esc)"
          aria-label="ยกเลิก"
        >
          <XIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={!/^\d{6}$/.test(draft)}
          className="grid size-8 shrink-0 place-items-center rounded-xl bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          title="ยืนยัน (Enter)"
          aria-label="ยืนยัน"
        >
          <CheckIcon className="size-[18px]" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onStartEdit}
      className="group relative rounded-2xl border border-line/70 bg-bg-card/60 px-3.5 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/60 hover:bg-bg-hover active:scale-[0.98]"
      title={
        isOwner
          ? "คุณเป็นเจ้าของห้องนี้ · แตะเพื่อแก้เลขห้อง"
          : "คุณเป็นผู้เข้าร่วม · แตะเพื่อแก้เลขห้อง"
      }
    >
      {labelRow}
      <span className="block font-mono text-base font-semibold tracking-[0.22em] text-ink sm:text-[17px]">
        {roomCode}
      </span>
    </button>
  );
}

function IconButton({
  children,
  onClick,
  title,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="grid size-10 place-items-center rounded-xl border border-line/70 bg-bg-card/60 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/40 hover:bg-bg-hover hover:text-ink active:scale-95"
      title={title}
      aria-label={ariaLabel}
    >
      {children}
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
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 12.5 10 17.5 19 7.5" />
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
    <IconButton
      onClick={toggle}
      title={isFs ? "ออกจาก Fullscreen" : "Fullscreen (ซ่อนแถบ browser)"}
      aria-label="Toggle fullscreen"
    >
      {isFs ? <ExitFsIcon /> : <EnterFsIcon />}
    </IconButton>
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
      className="size-[18px]"
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
      className="size-[18px]"
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
      className="size-[18px]"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
