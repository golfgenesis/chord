import { useEffect } from "react";
import { useApp } from "./store";
import { useVisibleSongs } from "./hooks/useVisibleSongs";
import { useRoomSongAlert } from "./hooks/useRoomSongAlert";
import { useAutoPrefetch } from "./hooks/useAutoPrefetch";
import { requestPersistentStorage } from "./lib/offlineDownload";
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
    // Ask the browser to keep our image cache around when disk pressure
    // rises. Chrome grants without a gesture; Firefox silently no-ops,
    // which is fine — eviction just means the next prefetch refills.
    requestPersistentStorage().catch(() => {});
  }, [init]);

  // Auto-open + push notification when a bandmate picks a new song.
  useRoomSongAlert();
  // Background-cache favorites / latest / playlists for offline use.
  useAutoPrefetch();

  if (!loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 text-ink-dim">
        <div className="relative">
          <div
            aria-hidden
            className="absolute inset-0 -m-6 rounded-full bg-brand-grad opacity-30 blur-3xl"
          />
          <div className="relative grid size-16 place-items-center rounded-2xl bg-brand-grad shadow-glow ring-1 ring-white/10 animate-pulse-glow">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/25 to-transparent"
            />
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="relative size-8 text-white"
            >
              <path
                d="M9 17V5l12-2v12"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="6" cy="17" r="3" />
              <circle cx="18" cy="15" r="3" />
            </svg>
          </div>
        </div>
        <div className="text-center">
          <p className="font-display text-[15px] font-semibold tracking-[-0.005em] text-ink">
            กำลังโหลดข้อมูลเพลง
          </p>
          <p className="mt-1 text-[12px] text-ink-mute">
            แค่ครั้งแรกของเซสชั่นเท่านั้น
          </p>
        </div>
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
        <div className="flex items-center justify-between border-b border-line/30 px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-mute">
          <span>
            {query ? "ผลค้นหา " : ""}
            <span className="text-ink-dim">
              {visibleCount.toLocaleString()}
            </span>
            {query && <> / {totalSongs.toLocaleString()}</>}
            {!query && " เพลงทั้งหมด"}
          </span>
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
