import { useApp } from "../store";
import type { Tab } from "../types";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "all", label: "ทั้งหมด", icon: "🎵" },
  { id: "favorites", label: "Favorites", icon: "★" },
  { id: "playlists", label: "Playlists", icon: "♪" },
];

export function Tabs() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-line/60 px-3 py-2 no-scrollbar">
      {TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
              active
                ? "bg-brand-grad text-white shadow-glow-sm"
                : "border border-line bg-bg-card/50 text-ink-dim hover:border-line-strong hover:bg-bg-hover hover:text-ink"
            }`}
          >
            <span className="relative z-10 whitespace-nowrap">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
