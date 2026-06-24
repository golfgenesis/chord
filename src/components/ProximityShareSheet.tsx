import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp, useIsRoomOwner } from "../store";
import { XIcon } from "./icons";
import {
  broadcastRoomCode,
  listenForRoomCode,
  ultrasonicSupported,
  type Broadcast,
} from "../lib/ultrasonic";

/**
 * "Join this room" proximity sheet — three zero-typing ways for a bandmate to
 * land in the singer's room:
 *   1. QR code of the deep-link URL (scan → opens /{roomCode} → store joins).
 *   2. Broadcast via near-ultrasonic audio (the owner's iPad emits the code).
 *   3. Listen & join (a guest's mic decodes the broadcast → setRoomCode).
 *
 * Portaled to <body>: the header's `backdrop-filter` (glass-strong) would
 * otherwise become the containing block and break this `position: fixed`
 * overlay on iOS Safari (same trick as IOSInstallSheet).
 *
 * NOTE: broadcast + listen are shown to everyone (not hard-gated to owner /
 * guest) — a guest may legitimately relay the room to a newcomer. The copy
 * frames "แชร์ห้องนี้" (share, typically the owner) vs "เข้าห้องเพื่อน" (join).
 */
export function ProximityShareSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const roomCode = useApp((s) => s.roomCode);
  const setRoomCode = useApp((s) => s.setRoomCode);
  const isOwner = useIsRoomOwner();

  // Keyed by room code so a stale QR is hidden by derivation (qrUrl below)
  // rather than a synchronous setState(null) in the effect.
  const [qr, setQr] = useState<{ code: string; url: string } | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const bcRef = useRef<Broadcast | null>(null);
  const audioOk = ultrasonicSupported();

  const url = typeof window !== "undefined" ? `${window.location.origin}/${roomCode}` : "";

  // Generate the QR lazily (keeps the qrcode lib out of the main bundle).
  // setState happens only inside the async .then/.catch — never synchronously
  // in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open || !roomCode) return;
    let cancelled = false;
    const code = roomCode;
    import("qrcode")
      .then((QR) =>
        QR.toDataURL(url, {
          width: 232,
          margin: 1,
          color: { dark: "#0a0a0a", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
      )
      .then((dataUrl) => {
        if (!cancelled) setQr({ code, url: dataUrl });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: "err", text: "สร้าง QR ไม่สำเร็จ" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, roomCode, url]);
  const qrUrl = qr && qr.code === roomCode ? qr.url : null;

  const stopBroadcast = useCallback(() => {
    bcRef.current?.stop();
    bcRef.current = null;
    setBroadcasting(false);
  }, []);

  // Audio is an external resource — release the oscillator on unmount. No
  // setState here (the component is leaving), so this never trips the
  // set-state-in-effect rule.
  useEffect(() => {
    return () => {
      bcRef.current?.stop();
      bcRef.current = null;
    };
  }, []);

  // Close = stop any broadcast, then notify the parent. Done in a handler
  // (event-driven), not an effect, so state changes stay out of render/commit.
  const handleClose = useCallback(() => {
    stopBroadcast();
    onClose();
  }, [stopBroadcast, onClose]);

  const toggleBroadcast = () => {
    if (broadcasting) {
      stopBroadcast();
      return;
    }
    try {
      setStatus({ kind: "info", text: "กำลังส่งสัญญาณเสียง… ให้เพื่อนกด “ฟังเพื่อเข้าห้อง” ใกล้ๆ" });
      const bc = broadcastRoomCode(roomCode);
      bcRef.current = bc;
      setBroadcasting(true);
      bc.done.then(() => {
        bcRef.current = null;
        setBroadcasting(false);
      });
    } catch {
      setStatus({ kind: "err", text: "อุปกรณ์นี้ส่งสัญญาณเสียงไม่ได้" });
    }
  };

  const listen = async () => {
    if (listening) return;
    setListening(true);
    setStatus({ kind: "info", text: "กำลังฟัง… ถือเครื่องใกล้ลำโพงของคนที่กดส่ง" });
    try {
      const code = await listenForRoomCode({ timeoutMs: 4000 });
      if (code) {
        setRoomCode(code);
        setStatus({ kind: "ok", text: `เข้าห้อง ${code} แล้ว 🎉` });
        window.setTimeout(handleClose, 900);
      } else {
        setStatus({ kind: "err", text: "ไม่พบสัญญาณ — ลองใหม่ใกล้ลำโพงในที่เงียบกว่านี้" });
      }
    } catch {
      setStatus({ kind: "err", text: "เข้าถึงไมโครโฟนไม่ได้ (ต้องอนุญาตและใช้ HTTPS)" });
    } finally {
      setListening(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 animate-fade-in"
      onClick={handleClose}
      style={{ paddingTop: "calc(1rem + var(--safe-top))", paddingBottom: "calc(1rem + var(--safe-bottom))" }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden />
      <div
        role="dialog"
        aria-label="เข้าห้องแบบรวดเร็ว"
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-3xl border border-white/10 bg-bg-soft/95 p-5 shadow-2xl backdrop-blur-xl animate-slide-up"
        style={{ maxHeight: "calc(100dvh - 2rem - var(--safe-top) - var(--safe-bottom))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[18px] font-semibold tracking-tight text-ink">
              เข้าห้องแบบรวดเร็ว
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-dim">
              ห้อง <span className="font-mono font-semibold tracking-[0.15em] text-ink">{roomCode}</span>
              {isOwner && <span className="ml-2 text-ink-mute">· คุณเป็นเจ้าของ</span>}
            </p>
          </div>
          <button
            onClick={handleClose}
            aria-label="ปิด"
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/[0.12] bg-white/[0.06] text-white/80 transition hover:bg-white/[0.12] active:scale-95"
          >
            <XIcon className="size-[18px]" />
          </button>
        </div>

        {/* QR — scan to open /{roomCode} and drop straight into the room. */}
        <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <div className="grid size-[232px] place-items-center rounded-xl bg-white p-2">
            {qrUrl ? (
              <img src={qrUrl} alt={`QR สำหรับเข้าห้อง ${roomCode}`} width={216} height={216} className="block" />
            ) : (
              <span className="size-5 animate-spin rounded-full border-2 border-black/20 border-t-black/60" />
            )}
          </div>
          <p className="text-center text-[12px] text-ink-dim">
            ให้เพื่อนสแกนด้วยกล้องเพื่อเข้าห้องทันที
          </p>
        </div>

        {/* Audio proximity — broadcast / listen. */}
        {audioOk ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={toggleBroadcast}
              disabled={listening}
              className={`flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-semibold transition active:scale-[0.98] disabled:opacity-40 ${
                broadcasting
                  ? "bg-brand-grad text-white shadow-glow-sm ring-1 ring-white/10"
                  : "border border-white/[0.12] bg-white/[0.06] text-ink hover:bg-white/[0.12]"
              }`}
            >
              <BroadcastIcon active={broadcasting} />
              {broadcasting ? "กำลังส่งสัญญาณ… (แตะเพื่อหยุด)" : "แชร์ห้องนี้ผ่านเสียง"}
            </button>
            <button
              onClick={listen}
              disabled={listening || broadcasting}
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/[0.12] bg-white/[0.06] px-4 py-3 text-[14px] font-semibold text-ink transition hover:bg-white/[0.12] active:scale-[0.98] disabled:opacity-40"
            >
              {listening ? (
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
              ) : (
                <MicIcon />
              )}
              {listening ? "กำลังฟัง…" : "ฟังเพื่อเข้าห้องเพื่อน"}
            </button>
            <p className="px-1 text-[11px] leading-relaxed text-ink-mute">
              เสียงความถี่สูง (~18kHz) คนส่วนใหญ่ไม่ได้ยิน — ได้ผลดีสุดเมื่ออยู่ใกล้กันและที่เงียบ ถ้าไม่ติดให้ใช้ QR
            </p>
          </div>
        ) : (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-[12.5px] text-ink-dim">
            อุปกรณ์นี้ไม่รองรับการเข้าห้องผ่านเสียง — ใช้ QR ด้านบนแทนได้เลย
          </p>
        )}

        {status && (
          <p
            className={`rounded-xl px-3 py-2 text-center text-[12.5px] font-medium ${
              status.kind === "ok"
                ? "bg-emerald-400/10 text-emerald-300"
                : status.kind === "err"
                ? "bg-rose-400/10 text-rose-300"
                : "bg-white/[0.06] text-ink-dim"
            }`}
          >
            {status.text}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

function BroadcastIcon({ active }: { active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-[18px] ${active ? "animate-pulse" : ""}`}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </svg>
  );
}
