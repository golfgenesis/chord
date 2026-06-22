// Premium upsell sheet — explains the benefits and is the entry point for the
// (future) purchase flow. Opened from the profile menu. NOT shown in the chord
// view. Today the purchase CTA is a "coming soon" placeholder because there's
// no payment processor wired yet (see MARKETING.md → Premium). A DEV-only
// toggle lets the owner preview the ad-free state locally.

import { createPortal } from "react-dom";
import { setPremium, usePremium } from "../lib/premium";
import { XIcon, CheckIcon } from "./icons";

const BENEFITS = [
  "ตัดโฆษณาทั้งหมด — ใช้งานสะอาดตา",
  "ดาวน์โหลดเพลงไว้เล่นออฟไลน์เป็นแพ็ก",
  "เปลี่ยนคีย์ / ฟอนต์ / ขนาดตัวอักษรขั้นสูง",
  "สนับสนุนให้เว็บอยู่ต่อและมีเพลงเพิ่มเรื่อย ๆ",
];

export function PremiumSheet({ onClose }: { onClose: () => void }) {
  const premium = usePremium();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-md animate-fade-in sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-[28px] border border-white/10 bg-bg-card/95 p-6 shadow-card backdrop-blur-2xl animate-slide-up sm:max-w-md sm:rounded-3xl"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
      >
        <div className="mx-auto mb-5 h-1 w-9 rounded-full bg-ink-mute/30 sm:hidden" />

        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/10">
              ★
            </span>
            <h3 className="font-display text-[20px] font-semibold tracking-tight text-ink">
              Chord Premium
            </h3>
          </div>
          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl text-ink-mute transition hover:bg-bg-hover hover:text-ink"
            aria-label="ปิด"
          >
            <XIcon className="size-[18px]" />
          </button>
        </div>

        <p className="mb-4 text-[13px] leading-relaxed text-ink-mute">
          ปลดล็อกประสบการณ์เต็มรูปแบบ และช่วยสนับสนุนเว็บคอร์ดเพลงนี้
        </p>

        <ul className="space-y-2.5">
          {BENEFITS.map((b) => (
            <li key={b} className="flex items-start gap-3">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
                <CheckIcon className="size-3.5" />
              </span>
              <span className="text-[14px] leading-relaxed text-ink-dim">{b}</span>
            </li>
          ))}
        </ul>

        <button
          disabled
          className="mt-6 h-12 w-full cursor-not-allowed rounded-xl bg-brand-grad text-[15px] font-semibold text-white opacity-60 shadow-glow-sm ring-1 ring-white/10"
        >
          เปิดให้สมัครเร็ว ๆ นี้
        </button>
        <p className="mt-2 text-center text-[11px] text-ink-mute">
          กำลังเตรียมระบบชำระเงิน
        </p>

        {import.meta.env.DEV && (
          <button
            onClick={() => setPremium(!premium)}
            className="mt-4 h-9 w-full rounded-lg border border-dashed border-line/70 text-[12px] font-medium text-ink-mute transition hover:text-ink"
          >
            (dev) {premium ? "ปิด" : "เปิด"} premium เพื่อทดสอบ — ตอนนี้:{" "}
            {premium ? "ON" : "OFF"}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
