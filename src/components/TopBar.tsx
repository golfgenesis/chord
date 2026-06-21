import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { EyeIcon, EyeOffIcon, XIcon } from "./icons";
import { ProfileButton } from "./ProfileButton";

// Web Speech API — only Chrome/Edge/Android expose it (under the webkit
// prefix on most). Safari/iOS and Firefox return undefined and the mic
// button hides itself entirely.
const SpeechRecognitionCtor =
  typeof window !== "undefined"
    ? ((window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
        (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition)
    : undefined;
const speechSupported = !!SpeechRecognitionCtor;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export function TopBar() {
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);

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
            className={`peer h-[52px] w-full rounded-2xl border border-line/80 bg-bg-card/60 pl-12 ${speechSupported ? "pr-20" : "pr-11"} text-[16px] font-medium text-ink placeholder:font-normal placeholder:text-ink-mute shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-4 focus:ring-brand/15 sm:h-[58px] sm:text-[18px] sm:placeholder:text-base`}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className={`absolute ${speechSupported ? "right-11" : "right-2.5"} top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-mute transition hover:bg-bg-hover hover:text-ink`}
              aria-label="Clear"
            >
              <XIcon className="size-[18px]" />
            </button>
          )}
          <VoiceSearchButton onResult={setQuery} />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Auto-open stays a one-tap toggle inline on tablet/desktop (it's
              flipped often during a session); on phones it collapses into the
              profile menu. Install + share always live in the profile menu
              regardless of screen size — see ProfileButton. */}
          <div className="hidden items-center gap-1.5 sm:flex">
            <AutoOpenButton />
          </div>
          <ProfileButton />
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

function VoiceSearchButton({ onResult }: { onResult: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // Clean up an active recognition session if the component unmounts mid-listen
  // (e.g. nav back) — leaving the mic hot would leak the indicator in the OS.
  useEffect(() => {
    return () => {
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  if (!SpeechRecognitionCtor) return null;

  function toggle() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SpeechRecognitionCtor!();
    rec.lang = "th-TH";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      // Speech engines tack a trailing period onto Thai dictation that
      // tanks the substring search — strip it.
      onResult(text.replace(/[.。]\s*$/, "").trim());
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if called twice in quick succession — swallow.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? "หยุดฟัง" : "ค้นหาด้วยเสียง"}
      title={listening ? "กำลังฟัง... แตะเพื่อหยุด" : "ค้นหาด้วยเสียง"}
      aria-pressed={listening}
      className={`absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-2 transition ${
        listening
          ? "bg-red-500/20 text-red-400 animate-pulse"
          : "text-ink-mute hover:bg-bg-hover hover:text-ink"
      }`}
    >
      <MicIcon className="size-[18px]" />
    </button>
  );
}

function MicIcon({ className = "" }: { className?: string }) {
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
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
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

function AutoOpenButton() {
  // When ON (default), a bandmate picking a song auto-pops the fullscreen
  // chord sheet on this device. When OFF, the NowPlaying banner still
  // updates but nothing takes over the screen — useful when you want to
  // keep browsing the list while someone else is leading.
  const autoOpen = useApp((s) => s.autoOpen);
  const toggle = useApp((s) => s.toggleAutoOpen);
  return (
    <button
      onClick={toggle}
      className={`grid size-10 place-items-center rounded-xl border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition active:scale-95 ${
        autoOpen
          ? "border-brand/40 bg-brand-soft text-brand hover:bg-brand/20"
          : "border-line/70 bg-bg-card/60 text-ink-dim hover:border-brand/40 hover:bg-bg-hover hover:text-ink"
      }`}
      title={
        autoOpen
          ? "เปิด: เด้งดูเพลงตามวงโดยอัตโนมัติ — แตะเพื่อปิด"
          : "ปิด: ต้องแตะเพลงเองเพื่อดู — แตะเพื่อเปิดใหม่"
      }
      aria-label={autoOpen ? "Auto-open is on" : "Auto-open is off"}
      aria-pressed={autoOpen}
    >
      {autoOpen ? <EyeIcon /> : <EyeOffIcon />}
    </button>
  );
}
