import { useEffect, useState } from "react";
import { useApp } from "../store";
import { imageUrl } from "../lib/imageUrl";

export function Fullscreen() {
  const song = useApp((s) => s.viewing);
  const close = useApp((s) => s.close);
  const invertImages = useApp((s) => s.invertImages);
  const toggleInvertImages = useApp((s) => s.toggleInvertImages);
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
        className="relative z-10 flex shrink-0 items-center gap-3 border-b border-white/[0.08] glass-strong px-4 py-2.5 text-white sm:px-5 sm:py-3"
        style={{ paddingTop: "calc(0.625rem + var(--safe-top))" }}
      >
        <div className="relative grid size-9 place-items-center rounded-xl bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-white/25 to-transparent"
          />
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="relative size-[18px]"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold leading-[1.5] tracking-tight sm:text-[20px] sm:leading-[1.4]">
          {song.name}
        </h2>
        <button
          onClick={toggleInvertImages}
          className={`grid size-9 shrink-0 place-items-center rounded-xl border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition active:scale-95 ${
            invertImages
              ? "border-brand/40 bg-brand-soft text-brand hover:bg-brand/20"
              : "border-white/[0.12] bg-white/[0.06] text-white/80 hover:border-white/20 hover:bg-white/[0.12]"
          }`}
          aria-label={invertImages ? "ปิด invert (โหมดสว่าง)" : "เปิด invert (โหมดมืด)"}
          title={invertImages ? "กำลังใช้โหมดมืด — แตะเพื่อกลับเป็นกระดาษขาว" : "กำลังใช้โหมดสว่าง — แตะเพื่อเปลี่ยนเป็นโหมดมืด"}
        >
          <ContrastIcon />
        </button>
        <button
          onClick={close}
          className="rounded-xl border border-white/[0.12] bg-white/[0.06] px-3.5 py-2 text-[14px] font-semibold tracking-[-0.005em] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition hover:border-white/20 hover:bg-white/[0.12] active:scale-95"
          aria-label="Close"
        >
          เสร็จ
          <span className="ml-2 hidden text-white/40 sm:inline">ESC</span>
        </button>
      </header>

      {/* Image fills 100% of remaining area — no padding, no border, no
          rounded corners. `filter: invert(1) hue-rotate(180deg)` flips white
          paper → black + black ink → white, while preserving any color
          highlights in the chord notation. The dark gutters (when aspect
          ratios differ) match the page bg seamlessly. */}
      <div
        className={`relative min-h-0 flex-1 ${invertImages ? "bg-black" : "bg-white"}`}
        style={{ paddingBottom: "var(--safe-bottom)" }}
        onClick={close}
      >
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2.5 text-white/70">
            <Spinner />
            <span className="text-[13px] font-medium">กำลังโหลด...</span>
          </div>
        )}
        <img
          src={imageUrl(song)}
          alt={song.name}
          onLoad={() => setLoadedId(song.id)}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
          decoding="async"
          className={`block h-full w-full select-none object-contain transition-opacity duration-300 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          style={{
            // Invert pushes anti-aliased gray edges hard toward pure white/
            // black for dark-mode legibility. Non-invert mode shows the chord
            // sheet as-is (watermark and all) — the user prefers the original.
            filter: invertImages
              ? "invert(1) hue-rotate(180deg) contrast(1.7) brightness(1.1) saturate(0.7)"
              : undefined,
            imageRendering: "auto",
          }}
        />
      </div>
    </div>
  );
}

function ContrastIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
      {/* Outline of the full circle */}
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      {/* Filled left half — classic accessibility "invert colors" mark */}
      <path d="M 12 3 A 9 9 0 0 0 12 21 Z" fill="currentColor" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 animate-spin">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        opacity="0.2"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
