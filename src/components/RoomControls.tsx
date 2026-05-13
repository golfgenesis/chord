import { useState } from "react";
import { useApp, useIsRoomOwner } from "../store";

/**
 * Room code badge + randomize button, designed to sit next to the Tabs
 * row. Editing state for the room code is local to this component because
 * it's only meaningful here.
 */
export function RoomControls() {
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
        <button
          onClick={randomizeRoom}
          title="สุ่มเลขห้องใหม่"
          aria-label="Random room"
          className="grid size-9 place-items-center rounded-xl border border-line/70 bg-bg-card/60 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/40 hover:bg-bg-hover hover:text-ink active:scale-95 sm:size-10"
        >
          <RefreshIcon />
        </button>
      )}
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
      className="group relative rounded-2xl border border-line/70 bg-bg-card/60 px-3 py-1.5 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/60 hover:bg-bg-hover active:scale-[0.98] sm:px-3.5 sm:py-2"
      title={
        isOwner
          ? "คุณเป็นเจ้าของห้องนี้ · แตะเพื่อแก้เลขห้อง"
          : "คุณเป็นผู้เข้าร่วม · แตะเพื่อแก้เลขห้อง"
      }
    >
      {labelRow}
      <span className="block font-mono text-[15px] font-semibold tracking-[0.2em] text-ink sm:text-base">
        {roomCode}
      </span>
    </button>
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
