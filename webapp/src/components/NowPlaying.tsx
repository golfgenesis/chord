import { useApp } from "../store";

export function NowPlaying() {
  const room = useApp((s) => s.room);
  const clientId = useApp((s) => s.clientId);
  const byId = useApp((s) => s.byId);
  const open = useApp((s) => s.open);

  if (!room || !room.songId) {
    return (
      <div className="border-b border-line/60 bg-bg-soft/40 px-4 py-2.5 text-xs text-ink-mute">
        ยังไม่มีเพลงที่เลือกในห้องนี้ — กดเพลงเพื่อแจ้งให้คนในวงเห็น
      </div>
    );
  }

  const mine = room.pickedBy === clientId;
  const song = byId.get(room.songId);

  return (
    <button
      onClick={() => song && open(song, false)}
      className={`group relative flex w-full items-center gap-3 overflow-hidden border-b border-line/60 px-4 py-3 text-left transition active:scale-[0.998] ${
        mine ? "bg-brand-grad-soft" : "bg-bg-soft/60"
      }`}
    >
      {/* left accent bar */}
      <span
        className={`absolute inset-y-2 left-0 w-[3px] rounded-full ${
          mine ? "bg-brand-grad" : "bg-cyan/60"
        }`}
      />
      {/* pulsing dot */}
      <span className="relative ml-1.5 grid size-2.5 shrink-0 place-items-center">
        <span
          className={`absolute size-2.5 rounded-full ${
            mine ? "bg-brand" : "bg-cyan"
          } animate-pulse-glow`}
        />
        <span
          className={`absolute size-5 rounded-full opacity-30 blur-[6px] ${
            mine ? "bg-brand" : "bg-cyan"
          }`}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-mute">
          {mine ? "คุณเลือก" : "นักร้องเลือก"}
        </div>
        <div className="truncate text-base font-semibold text-ink sm:text-lg">
          {room.songName}
        </div>
      </div>

      <div className="grid size-10 shrink-0 place-items-center rounded-full bg-bg-card/70 text-ink-dim transition group-hover:bg-brand-soft group-hover:text-brand">
        <PlayIcon />
      </div>
    </button>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-5">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
