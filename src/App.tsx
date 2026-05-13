import { useEffect } from "react";
import { useApp } from "./store";
import { useVisibleSongs } from "./hooks/useVisibleSongs";
import { TopBar } from "./components/TopBar";
import { NowPlaying } from "./components/NowPlaying";
import { Tabs } from "./components/Tabs";
import { PlaylistPicker } from "./components/PlaylistPicker";
import { SongList } from "./components/SongList";
import { Fullscreen } from "./components/Fullscreen";

export default function App() {
  const init = useApp((s) => s.init);
  const loaded = useApp((s) => s.loaded);
  const tab = useApp((s) => s.tab);
  const totalSongs = useApp((s) => s.songs.length);
  const visibleCount = useVisibleSongs().length;
  const query = useApp((s) => s.query);

  useEffect(() => {
    init();
  }, [init]);

  if (!loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-ink-dim">
        <div className="grid size-14 place-items-center rounded-2xl bg-brand-grad shadow-glow animate-pulse-glow">
          <svg viewBox="0 0 24 24" fill="currentColor" className="size-7 text-white">
            <path d="M9 17V5l12-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="6" cy="17" r="3" />
            <circle cx="18" cy="15" r="3" />
          </svg>
        </div>
        <p className="text-sm">กำลังโหลดข้อมูลเพลง...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Fixed header — never scrolls */}
      <div className="shrink-0">
        <TopBar />
        <NowPlaying />
        <Tabs />
        {tab === "playlists" && <PlaylistPicker />}
        <div className="flex items-center justify-between border-b border-line/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-mute">
          <span>
            {query ? "ผลค้นหา " : ""}
            <span className="text-ink-dim">
              {visibleCount.toLocaleString()}
            </span>
            {query && <> / {totalSongs.toLocaleString()}</>}
            {!query && " เพลงทั้งหมด"}
          </span>
          <span className="text-ink-mute">Chord</span>
        </div>
      </div>
      {/* Scrollable list only */}
      <div className="flex min-h-0 flex-1 flex-col">
        <SongList />
      </div>
      <Fullscreen />
    </div>
  );
}
