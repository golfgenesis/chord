import { useApp } from "../store";
import type { Tab } from "../types";
import { RoomControls } from "./RoomControls";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "favorites", label: "Favorites" },
  { id: "playlists", label: "Playlists" },
];

export function Tabs() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  // `flex-wrap-reverse` is the trick that makes RoomControls jump ABOVE the
  // tabs when the row gets too narrow (mobile). Without -reverse, wrapped
  // items stack below — we'd see Tabs on top, RoomControls below. DOM order
  // stays `Tabs, RoomControls`; the reverse flips wrap direction so the
  // second child ends up visually on top when it wraps. On a single row,
  // `ml-auto` keeps RoomControls right-aligned.
  return (
    <div className="flex flex-wrap-reverse items-center gap-y-2.5 gap-x-3 border-b border-line/40 px-4 py-3 sm:py-3.5">
      <div className="inline-flex shrink-0 rounded-full border border-line/60 bg-bg-soft/70 p-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative shrink-0 rounded-full px-4 py-1.5 text-[13px] font-semibold tracking-[-0.005em] transition-all duration-150 sm:px-5 sm:py-2 sm:text-sm ${
                active
                  ? "bg-bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.06)] ring-1 ring-white/5"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              <span className="whitespace-nowrap">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="sm:ml-auto">
        <RoomControls />
      </div>
    </div>
  );
}
