import { useEffect, useState } from "react";
import { useApp } from "../store";
import { imageUrl } from "../lib/imageUrl";

export function Fullscreen() {
  const song = useApp((s) => s.viewing);
  const close = useApp((s) => s.close);
  // Track which song id has finished loading. `loaded` is derived, so it
  // automatically resets to false when `song.id` changes — no effect needed.
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const loaded = song != null && loadedId === song.id;

  useEffect(() => {
    if (!song) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song, close]);

  if (!song) return null;

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-black">
      <header
        className="relative flex shrink-0 items-center gap-3 border-b border-white/10 glass-strong px-4 py-2.5 text-white"
        style={{ paddingTop: "calc(0.625rem + var(--safe-top))" }}
      >
        <div className="grid size-8 place-items-center rounded-lg bg-brand-grad shadow-glow-sm">
          <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-semibold sm:text-lg">
          {song.name}
        </h2>
        <button
          onClick={close}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-medium transition hover:border-white/20 hover:bg-white/10"
          aria-label="Close"
        >
          ปิด <span className="ml-1 hidden text-white/40 sm:inline">ESC</span>
        </button>
      </header>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
        style={{ paddingBottom: "var(--safe-bottom)" }}
        onClick={close}
      >
        {!loaded && (
          <div className="absolute flex items-center gap-2 text-white/70">
            <Spinner />
            <span className="text-sm">กำลังโหลด...</span>
          </div>
        )}
        <img
          src={imageUrl(song)}
          alt={song.name}
          onLoad={() => setLoadedId(song.id)}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
          decoding="async"
          className="block h-full w-full select-none object-contain"
          style={{
            background: "white",
            opacity: loaded ? 1 : 0,
            transition: "opacity .2s",
            imageRendering: "auto",
          }}
        />
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.2" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
