// Affiliate music-gear CTA (Phase 2 monetization).
//
// Rendered ONLY as the song-list footer (see SongList.tsx) — it sits at the
// BOTTOM of the list, so on the 70k "all" list it's effectively never in the
// way, while on short lists (favorites / search results / a playlist) it shows
// after the last song. Per MARKETING.md it must NEVER appear inside the
// fullscreen chord view. Clearly labelled "โฆษณา", dismissible for the session,
// `rel="sponsored"` on every outbound link.

import { useState } from "react";
import { GEAR, shopeeUrl, lazadaUrl, type GearProduct } from "../lib/affiliates";
import { usePremium } from "../lib/premium";
import { AdUnit } from "./AdUnit";

function pickFeatured(): GearProduct {
  return GEAR[Math.floor(Math.random() * GEAR.length)];
}

export function GearFooter() {
  // Picked once per mount; dismiss hides it for this session (re-shows on reload).
  const [item] = useState(pickFeatured);
  const [dismissed, setDismissed] = useState(false);
  const premium = usePremium();

  // Premium = ad-free. Still reserve the safe-area inset at the list bottom so
  // the last song row never tucks under the home indicator.
  if (premium || dismissed) return <div style={{ height: "var(--safe-bottom)" }} />;

  return (
    <div className="px-3 pb-[calc(0.875rem+var(--safe-bottom))] pt-2">
      <div className="relative overflow-hidden rounded-2xl border border-line/50 bg-bg-card/60 p-4">
        <button
          onClick={() => setDismissed(true)}
          aria-label="ปิดโฆษณา"
          title="ปิด"
          className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg text-ink-mute transition hover:bg-bg-hover hover:text-ink"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-mute">
          โฆษณา · อุปกรณ์แนะนำ
        </div>

        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-grad-soft text-2xl ring-1 ring-brand/20">
            {item.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight text-ink">
              {item.name}
            </div>
            <div className="truncate text-[12px] leading-relaxed text-ink-dim">
              {item.blurb}
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <a
            href={shopeeUrl(item)}
            target="_blank"
            rel="sponsored nofollow noopener"
            className="flex-1 rounded-xl bg-[#ee4d2d]/15 py-2 text-center text-[13px] font-semibold text-[#ff7a59] ring-1 ring-[#ee4d2d]/30 transition hover:bg-[#ee4d2d]/25 active:scale-95"
          >
            ดูบน Shopee
          </a>
          <a
            href={lazadaUrl(item)}
            target="_blank"
            rel="sponsored nofollow noopener"
            className="flex-1 rounded-xl bg-[#3b5bff]/15 py-2 text-center text-[13px] font-semibold text-[#8aa0ff] ring-1 ring-[#3b5bff]/30 transition hover:bg-[#3b5bff]/25 active:scale-95"
          >
            ดูบน Lazada
          </a>
        </div>
      </div>
      {/* Dormant until ADSENSE_CLIENT is set in lib/ads.ts; consent + non-premium gated. */}
      <AdUnit slot="list-footer" className="mt-2" />
    </div>
  );
}
