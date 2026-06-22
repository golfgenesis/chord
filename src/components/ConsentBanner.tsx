// PDPA cookie-consent banner — a bottom strip shown once until the user
// decides. Hidden while a song is open so it never covers the (clean) chord
// view; the user sees it on the list/home, which is where first visits land.

import { useApp } from "../store";
import { setConsent, useConsent } from "../lib/consent";

export function ConsentBanner() {
  const consent = useConsent();
  const viewing = useApp((s) => s.viewing);

  if (consent !== null || viewing) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[55] animate-slide-up px-3 pb-[calc(0.75rem+var(--safe-bottom))] pt-3"
      role="dialog"
      aria-label="ความยินยอมเรื่องคุกกี้"
    >
      <div className="mx-auto max-w-lg rounded-2xl border border-white/10 bg-bg-soft/95 p-4 shadow-2xl backdrop-blur-xl">
        <p className="text-[13px] leading-relaxed text-ink-dim">
          เราใช้คุกกี้เพื่อวิเคราะห์การใช้งานและพัฒนาเว็บให้ดีขึ้น
          คุณเลือกได้ว่าจะอนุญาตหรือไม่
        </p>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setConsent("denied")}
            className="flex-1 rounded-xl border border-line/70 bg-bg-card/60 py-2.5 text-[13px] font-semibold text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-[0.98]"
          >
            ไม่อนุญาต
          </button>
          <button
            onClick={() => setConsent("granted")}
            className="flex-1 rounded-xl bg-brand-grad py-2.5 text-[13px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98]"
          >
            อนุญาต
          </button>
        </div>
      </div>
    </div>
  );
}
