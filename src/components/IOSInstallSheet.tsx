import { createPortal } from "react-dom";
import { InstallIcon, ShareIcon } from "./icons";

export function IOSInstallSheet({ onClose }: { onClose: () => void }) {
  // Portal to body so the fixed-positioning escapes any backdrop-filter
  // ancestor (CSS spec: backdrop-filter establishes a containing block for
  // fixed-position descendants, which would otherwise pin the sheet to the
  // header instead of the viewport).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-strong w-full max-w-md animate-slide-up rounded-3xl border border-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-brand-grad shadow-glow-sm ring-1 ring-white/10">
            <InstallIcon className="size-5 text-white" />
          </div>
          <h3 className="font-display text-[19px] font-semibold leading-[1.4] tracking-tight text-ink">
            เพิ่มลงหน้าจอหลัก
          </h3>
        </div>
        <ol className="space-y-3.5 text-[15px] leading-[1.55] text-ink-dim">
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-bg-soft text-[12px] font-bold text-brand">
              1
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              แตะปุ่มแชร์
              <span className="inline-grid size-7 place-items-center rounded-md border border-line/80 bg-bg-card text-ink-dim">
                <ShareIcon className="size-4" />
              </span>
              ในแถบล่างของ Safari
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-bg-soft text-[12px] font-bold text-brand">
              2
            </span>
            <span>เลื่อนหา <span className="text-ink">"Add to Home Screen"</span></span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-bg-soft text-[12px] font-bold text-brand">
              3
            </span>
            <span>แตะ <span className="text-ink">"Add"</span> มุมขวาบน</span>
          </li>
        </ol>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-2xl bg-brand-grad py-3 text-[15px] font-semibold tracking-tight text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98]"
        >
          เข้าใจแล้ว
        </button>
      </div>
    </div>,
    document.body,
  );
}
