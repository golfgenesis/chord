import { useEffect, useState } from "react";

/**
 * Owner-only QA tag shown at the BOTTOM of a text-mode song. `flag` is the Thai reason
 * `chordpro:check` recorded for this song (shipped in songs.bin). It renders ONLY when the
 * signed-in user is an owner — a soft review aid, consistent with the owner image toggle.
 *
 * The "แก้ด้วย AI" (fix) button appears only when BOTH:
 *   - import.meta.env.DEV  → we're running `npm run dev` (the endpoints don't exist in prod), and
 *   - /api/vlm-status says the `claude` CLI is installed on this machine.
 * Clicking it re-extracts the song with the vision model (subscription via `claude -p`),
 * refreshes flags, rebuilds songs.bin, then reloads so the corrected text shows.
 */
export function OwnerFlagTag({
  songId,
  flag,
  isOwner,
  invert,
}: {
  songId: number;
  flag?: string;
  isOwner: boolean;
  invert: boolean;
}) {
  const [canFix, setCanFix] = useState(false);
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  // Probe once: is the `claude` CLI reachable from the dev server? Only meaningful in dev —
  // in a production build import.meta.env.DEV is false so we never even ask.
  useEffect(() => {
    if (!isOwner || !flag || !import.meta.env.DEV) return;
    let alive = true;
    fetch("/api/vlm-status")
      .then((r) => r.json())
      .then((d) => alive && setCanFix(!!d?.claude))
      .catch(() => alive && setCanFix(false));
    return () => {
      alive = false;
    };
  }, [isOwner, flag]);

  if (!isOwner || !flag) return null;

  const runFix = async () => {
    setState("running");
    setErr(null);
    try {
      const r = await fetch(`/api/vlm-fix?id=${songId}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d?.ok) throw new Error(d?.step ? `${d.step}: ${d.log ?? ""}` : d?.error ?? "failed");
      // songs.bin was rebuilt — reload to pick up the corrected text + cleared flag.
      location.reload();
    } catch (e) {
      setState("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const amber = invert ? "#fcd34d" : "#b45309";
  const amberBorder = invert ? "rgba(252,211,77,0.32)" : "rgba(180,83,9,0.22)";
  // Warm amber wash with a gentle top-to-bottom gradient so the full-width band reads as
  // a deliberate footer panel, not a flat block. One per mode so it sits well on both the
  // white chord paper and the inverted black one.
  const cardBg = invert
    ? "linear-gradient(180deg, rgba(44,35,16,0.96) 0%, rgba(30,24,11,0.98) 100%)"
    : "linear-gradient(180deg, #fffaf2 0%, #fff3e3 100%)";

  // Full-bleed (เต็มความกว้างจอ) footer panel at the very end of the sheet — NOT sticky;
  // the owner reaches it by scrolling to the bottom. A top hairline + upward shadow lift
  // it off the chord text; content is centred in a readable column inside the band.
  return (
    <div
      className="w-full rounded-t-xl border-t px-3 pt-2.5 sm:px-5"
      style={{
        color: amber,
        background: cardBg,
        borderColor: amberBorder,
        boxShadow: invert
          ? "0 -8px 24px -16px rgba(0,0,0,0.7)"
          : "0 -8px 24px -16px rgba(180,83,9,0.3)",
        // The scroll container already pads its bottom by var(--safe-bottom); pull the
        // band down over that strip (negative margin) and re-add it as our own padding so
        // the amber bg hugs the screen edge while the text stays clear of the home bar.
        marginBottom: "calc(-1 * var(--safe-bottom))",
        paddingBottom: "calc(var(--safe-bottom) + 10px)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-auto max-w-3xl text-[11.5px] leading-snug">
        {/* Text on the left, fix button on the right. min-w-0 lets the flag text
            wrap instead of squeezing the button off-screen. */}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <span aria-hidden="true" className="text-[12px] leading-[1.4]">⚠</span>
            <div className="min-w-0">
              <div className="font-semibold tracking-tight">ปัญหาที่ตรวจพบ (เห็นเฉพาะเจ้าของ)</div>
              <div className="mt-0.5 opacity-85">{flag}</div>
            </div>
          </div>

          {import.meta.env.DEV && canFix && (
            <button
              onClick={runFix}
              disabled={state === "running"}
              className="shrink-0 rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold shadow-sm transition active:scale-95 disabled:opacity-60"
              style={{ color: invert ? "#0a0a0a" : "#fff", background: amber }}
            >
              {state === "running" ? "กำลังแก้…" : "แก้ด้วย AI (VLM)"}
            </button>
          )}
        </div>

        {state === "running" && (
          <div className="mt-1.5 text-right text-[11px] opacity-75">
            ~20–40 วินาที แล้วหน้าจะรีโหลด
          </div>
        )}
        {state === "error" && (
          <div className="mt-1.5 whitespace-pre-wrap break-words text-[11px] opacity-80">
            แก้ไม่สำเร็จ: {err}
          </div>
        )}
      </div>
    </div>
  );
}
