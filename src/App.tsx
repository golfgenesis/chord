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

  // The shell (TopBar, Tabs, NowPlaying) renders immediately — it doesn't
  // depend on the songs dataset. SongList shows its own loading state until
  // `loaded` flips true. This trades a full-screen blank spinner for an
  // interactive shell within ~one frame of JS executing.
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
            {!loaded ? (
              "กำลังโหลด..."
            ) : (
              <>
                {query ? "ผลค้นหา " : ""}
                <span className="text-ink-dim">
                  {visibleCount.toLocaleString()}
                </span>
                {query && <> / {totalSongs.toLocaleString()}</>}
                {!query && " เพลงทั้งหมด"}
              </>
            )}
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
