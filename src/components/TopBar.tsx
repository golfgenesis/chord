import { useEffect, useState } from "react";
import { useApp } from "../store";

// Chrome's beforeinstallprompt isn't in lib.dom.d.ts yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function TopBar() {
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const roomCode = useApp((s) => s.roomCode);

  return (
    <header
      className="sticky top-0 z-30 glass-strong hairline-grad"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 sm:gap-3.5 sm:px-5 sm:py-4">
        <BrandMark />

        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-[20px] -translate-y-1/2 text-ink-mute" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลง / artist..."
            className="peer h-[52px] w-full rounded-2xl border border-line/80 bg-bg-card/60 pl-12 pr-11 text-[16px] font-medium text-ink placeholder:font-normal placeholder:text-ink-mute shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-4 focus:ring-brand/15 sm:h-[58px] sm:text-[18px] sm:placeholder:text-base"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-mute transition hover:bg-bg-hover hover:text-ink"
              aria-label="Clear"
            >
              <XIcon className="size-[18px]" />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <InstallButton />
          <ShareButton roomCode={roomCode} />
        </div>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <div className="flex shrink-0 items-center gap-2.5 pr-1">
      <div className="relative grid size-10 place-items-center rounded-[12px] bg-brand-grad shadow-glow ring-1 ring-white/10">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[12px] bg-gradient-to-b from-white/25 to-transparent"
        />
        <svg viewBox="0 0 24 24" className="relative size-[22px] text-white" fill="currentColor">
          <path d="M9 17V5l12-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="6" cy="17" r="3" />
          <circle cx="18" cy="15" r="3" />
        </svg>
      </div>
      <div className="hidden flex-col leading-[1.05] sm:flex">
        <span className="font-display text-[17px] font-semibold tracking-[-0.015em]">
          <span className="gradient-text">Chord</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.22em] text-ink-mute">
          band sync
        </span>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="grid size-10 place-items-center rounded-xl border border-line/70 bg-bg-card/60 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/40 hover:bg-bg-hover hover:text-ink active:scale-95"
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 12.5 10 17.5 19 7.5" />
    </svg>
  );
}

function InstallButton() {
  // Two distinct install flows:
  //   - Chrome / Edge / Android — the browser fires `beforeinstallprompt`,
  //     we stash it, and a tap calls .prompt() to show the native dialog.
  //   - iOS Safari — no programmatic install API exists. We detect it and
  //     show a small instruction sheet (the user has to use Safari's own
  //     Share → Add to Home Screen menu).
  // If already installed (running as PWA), we hide the button entirely.
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  // Lazy initializers — these are synchronous browser checks, not external
  // subscriptions, so they belong in render init rather than an effect.
  const [hidden, setHidden] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true,
  );
  const [isIOS] = useState(
    () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window),
  );
  const [showIOSSheet, setShowIOSSheet] = useState(false);

  useEffect(() => {
    if (hidden) return;
    function onPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setHidden(true);
      setDeferred(null);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [hidden]);

  if (hidden) return null;
  // Chrome on desktop without PWA criteria met → hide silently. Only show
  // when we actually have something useful to do.
  if (!deferred && !isIOS) return null;

  async function install() {
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setHidden(true);
      setDeferred(null);
      return;
    }
    if (isIOS) setShowIOSSheet(true);
  }

  return (
    <>
      <IconButton
        onClick={install}
        title="เพิ่มลงหน้าจอหลัก"
        aria-label="Install app"
      >
        <InstallIcon />
      </IconButton>
      {showIOSSheet && <IOSInstallSheet onClose={() => setShowIOSSheet(false)} />}
    </>
  );
}

function IOSInstallSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        className="glass-strong w-full max-w-md rounded-t-3xl border-t border-white/10 p-6 pb-[calc(1.5rem+var(--safe-bottom))] animate-slide-up sm:rounded-3xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-5 h-1.5 w-10 rounded-full bg-white/20 sm:hidden" />
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
                <SafariShareIcon />
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
    </div>
  );
}

function InstallIcon({ className = "size-[18px]" }: { className?: string }) {
  // Phone outline with a download arrow inside — communicates "add app to
  // device" more clearly than a generic + or download glyph.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M12 8v7" />
      <path d="m9 12 3 3 3-3" />
    </svg>
  );
}

function SafariShareIcon() {
  // Mini replica of iOS's share glyph so users recognize it visually.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M12 3v12" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

function ShareButton({ roomCode }: { roomCode: string }) {
  // After a successful copy, flash a check mark for a moment so the user
  // gets visual feedback even when the native share sheet didn't open
  // (e.g. desktop browsers fall back to the clipboard).
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = `${window.location.origin}/${roomCode}`;
    const shareData = {
      title: "Chord — band sync",
      text: `เข้ามาที่ห้อง ${roomCode} กันนะ`,
      url,
    };
    // navigator.share is gated behind a user gesture on iOS/Android and
    // throws "AbortError" if the user dismisses the sheet — that's not a
    // real error, just no-op.
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — nothing more we can do
    }
  }

  return (
    <IconButton
      onClick={share}
      title={copied ? "คัดลอกลิงค์แล้ว" : "แชร์ลิงค์ห้องนี้ให้เพื่อน"}
      aria-label="Share room link"
    >
      {copied ? <CheckIcon className="size-[18px]" /> : <ShareIcon />}
    </IconButton>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
    >
      <path d="M12 3v12" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}
