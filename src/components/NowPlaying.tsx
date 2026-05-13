import { useApp } from "../store";

export function NowPlaying() {
  const room = useApp((s) => s.room);
  const clientId = useApp((s) => s.clientId);
  const byId = useApp((s) => s.byId);
  const open = useApp((s) => s.open);

  if (!room || !room.songId) {
    return (
      <div className="border-b border-line/40 bg-bg-soft/30 px-5 py-3 text-[13px] text-ink-mute">
        ยังไม่มีเพลงที่เลือกในห้องนี้ — กดเพลงเพื่อแจ้งให้คนในวงเห็น
      </div>
    );
  }

  const mine = room.pickedBy === clientId;
  const song = byId.get(room.songId);

  return (
    <button
      onClick={() => song && open(song, false)}
      className={`group relative flex w-full items-center gap-4 overflow-hidden border-b border-line/40 px-5 py-4 text-left transition active:scale-[0.997] sm:py-5 ${
        mine ? "bg-brand-grad-soft" : "bg-bg-soft/50"
      }`}
    >
      {/* left accent bar */}
      <span
        className={`absolute inset-y-3 left-0 w-[3px] rounded-full ${
          mine ? "bg-brand-grad" : "bg-cyan/60"
        }`}
      />
      {/* pulsing dot */}
      <span className="relative ml-1 grid size-3 shrink-0 place-items-center">
        <span
          className={`absolute size-3 rounded-full ${
            mine ? "bg-brand" : "bg-cyan"
          } animate-pulse-glow`}
        />
        <span
          className={`absolute size-6 rounded-full opacity-30 blur-[8px] ${
            mine ? "bg-brand" : "bg-cyan"
          }`}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div
          className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${
            mine ? "text-brand/90" : "text-cyan/80"
          }`}
        >
          {mine ? "คุณเลือก" : "นักร้องเลือก"}
        </div>
        <div className="mt-0.5 truncate font-display text-[19px] font-semibold tracking-[-0.015em] text-ink sm:text-[24px] sm:leading-[1.15]">
          {room.songName}
        </div>
      </div>

      <div className="grid size-11 shrink-0 place-items-center rounded-full border border-line/70 bg-bg-card/70 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] transition group-hover:border-brand/40 group-hover:bg-brand-soft group-hover:text-brand sm:size-12">
        <PlayIcon />
      </div>
    </button>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-[18px] translate-x-[1px] sm:size-5">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
