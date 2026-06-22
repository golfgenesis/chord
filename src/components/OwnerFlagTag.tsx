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
  const amberBg = invert ? "rgba(252,211,77,0.12)" : "rgba(180,83,9,0.08)";
  const amberBorder = invert ? "rgba(252,211,77,0.3)" : "rgba(180,83,9,0.25)";

  return (
    <div
      className="mx-auto mt-6 mb-2 max-w-3xl rounded-lg px-3 py-2.5 text-[13px] leading-relaxed sm:px-4"
      style={{ color: amber, background: amberBg, border: `1px solid ${amberBorder}` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true">⚠</span>
        <div className="flex-1">
          <div className="font-medium">ปัญหาที่ตรวจพบ (เห็นเฉพาะเจ้าของ)</div>
          <div className="mt-0.5 opacity-90">{flag}</div>

          {import.meta.env.DEV && canFix && (
            <div className="mt-2.5 flex items-center gap-2">
              <button
                onClick={runFix}
                disabled={state === "running"}
                className="rounded-md px-3 py-1.5 text-[13px] font-semibold transition active:scale-95 disabled:opacity-60"
                style={{ color: invert ? "#0a0a0a" : "#fff", background: amber }}
              >
                {state === "running" ? "กำลังแก้ด้วย AI…" : "แก้ด้วย AI (VLM)"}
              </button>
              {state === "running" && (
                <span className="text-[12px] opacity-75">~20–40 วินาที แล้วหน้าจะรีโหลด</span>
              )}
            </div>
          )}

          {state === "error" && (
            <div className="mt-2 whitespace-pre-wrap break-words text-[12px] opacity-80">
              แก้ไม่สำเร็จ: {err}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
