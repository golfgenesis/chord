import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { isInstalledPWA, isIOS } from "../lib/platform";
import { TrashIcon } from "./icons";
import {
  abortBulkDownload,
  clearImageCache,
  formatBytes,
  getCachedUrlSet,
  getCacheVersion,
  getDownloadState,
  getStorageInfo,
  requestPersistentStorage,
  startBulkDownload,
  subscribeCacheChange,
  subscribeDownload,
  absoluteImageUrl,
  type StorageInfo,
} from "../lib/offlineDownload";

// Higher concurrency wins on Cloudflare R2: their edge speaks HTTP/2 so all
// 16 requests share one TCP+TLS connection, and the per-image cost reduces
// to just the body transfer. We saw ~3× speedup going 6→16 on a 200 Mbps
// fiber link with no throttling. Going higher (24–32) sometimes triggers
// browser-side throttling or hits R2's per-connection concurrent-stream
// limit, so 16 is the sweet spot.
const CONCURRENCY = 16;

export function OfflineButton() {
  const [open, setOpen] = useState(false);
  // Subscribe to the same singleton the sheet uses — the button stays in
  // sync with an in-flight download even after the modal is dismissed,
  // which is the whole reason download state lives outside React.
  const { isDownloading, progress } = useSyncExternalStore(
    subscribeDownload,
    getDownloadState,
  );
  const pct =
    progress && progress.total > 0
      ? Math.floor((progress.done / progress.total) * 100)
      : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={
          isDownloading && pct !== null
            ? `กำลังดาวน์โหลด ${pct}% — แตะเพื่อดูรายละเอียด`
            : "ใช้งานออฟไลน์"
        }
        aria-label={
          isDownloading && pct !== null
            ? `Offline download running at ${pct}%`
            : "Offline download"
        }
        className={`relative grid size-10 place-items-center rounded-xl border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition active:scale-95 ${
          isDownloading
            ? "border-brand/40 bg-brand-soft text-brand"
            : "border-line/70 bg-bg-card/60 text-ink-dim hover:border-brand/40 hover:bg-bg-hover hover:text-ink"
        }`}
      >
        <CloudDownloadIcon />
        {/* Progress ring around the icon while a download is in flight.
            The button is rounded-xl (8 px corner radius) but we draw the
            ring on a circle inscribed in the 40 px square — it sits just
            inside the corners so the visual is "icon wrapped in a ring",
            not "ring matches the button shape". stroke-dashoffset animates
            so progress climbs smoothly between snapshot updates. */}
        {isDownloading && pct !== null && (
          <svg
            className="pointer-events-none absolute inset-0 -rotate-90"
            viewBox="0 0 40 40"
            aria-hidden
          >
            <circle
              cx="20"
              cy="20"
              r="17"
              fill="none"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth="2"
            />
            <circle
              cx="20"
              cy="20"
              r="17"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 17}
              strokeDashoffset={2 * Math.PI * 17 * (1 - pct / 100)}
              style={{ transition: "stroke-dashoffset 200ms ease-out" }}
            />
          </svg>
        )}
      </button>
      {open && <OfflineSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function OfflineSheet({ onClose }: { onClose: () => void }) {
  const songs = useApp((s) => s.songs);
  // Download state lives on the module singleton so it survives closing
  // and reopening the modal — without this, the user sees the progress
  // bar reset to 0% on every reopen even though the download is still
  // running in the background.
  const { isDownloading: downloading, progress } = useSyncExternalStore(
    subscribeDownload,
    getDownloadState,
  );
  // Re-scan cache.keys() whenever something mutates Cache Storage (e.g.
  // clearImageCache) so the "ดาวน์โหลดแล้ว N เพลง" tally drops to 0
  // immediately instead of waiting for the next reopen.
  const cv = useSyncExternalStore(subscribeCacheChange, getCacheVersion);
  const [storage, setStorage] = useState<StorageInfo>({
    quota: null,
    usage: null,
    available: null,
    persisted: false,
  });
  const [cachedCount, setCachedCount] = useState<number>(0);
  // Two-step confirmation for the destructive "clear cache" action — one
  // mis-tap shouldn't wipe a 30-minute download.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [installed] = useState(isInstalledPWA);
  const [ios] = useState(isIOS);

  // Refresh storage info on open and after each download tick so the user
  // sees the "used X / Y" number climb in real time.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const [s, cached] = await Promise.all([
        getStorageInfo(),
        getCachedUrlSet(),
      ]);
      if (cancelled) return;
      setStorage(s);
      let count = 0;
      for (const song of songs) {
        if (cached.has(absoluteImageUrl(song))) count++;
      }
      setCachedCount(count);
    }
    refresh();
    // Re-poll while a download is in flight so the progress UI's storage
    // line stays current.
    const id = downloading ? window.setInterval(refresh, 3000) : null;
    return () => {
      cancelled = true;
      if (id !== null) window.clearInterval(id);
    };
  }, [downloading, songs, cv]);

  async function start() {
    // Ask for persistence under a real user gesture (this onClick) so the
    // 30-minute download isn't silently evicted later when iOS or Chrome
    // hits a low-disk threshold.
    await requestPersistentStorage();
    // Singleton handles in-flight detection — calling while already
    // downloading is a no-op.
    startBulkDownload(songs, CONCURRENCY);
  }

  function cancel() {
    abortBulkDownload();
  }

  async function clearCache() {
    await clearImageCache();
    setConfirmingClear(false);
    // Storage / cachedCount refresh on the polling interval — and the
    // singleton's `progress: null` reset already triggered a re-render.
  }

  const total = songs.length;
  const allDone = cachedCount === total && total > 0;
  const remaining = total - cachedCount;
  // Empirical average per chord sheet (WebP near-lossless q=80 from upstream).
  // Used for the "will it fit?" pre-flight check below; the actual size
  // depends entirely on each individual image so we keep a 20% buffer.
  const avgBytesPerSong = 40 * 1024;
  const estimatedSize = remaining * avgBytesPerSong;
  // Pre-flight check: do we have enough room? If we don't know the quota
  // (some browsers return null), default to "probably yes" — never block
  // on uncertain info, just let the download try and fail loudly. If we
  // DO know and the headroom is below the estimate × 1.2, warn the user
  // up front instead of getting a stuck-at-83% disaster.
  const willFit =
    storage.available === null ||
    storage.available >= estimatedSize * 1.2;
  const tightFit =
    storage.available !== null &&
    storage.available < estimatedSize * 1.2 &&
    storage.available >= estimatedSize * 0.9;

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
            <CloudDownloadIcon className="size-5 text-white" />
          </div>
          <div>
            <h3 className="font-display text-[19px] font-semibold leading-[1.4] tracking-tight text-ink">
              ใช้งานออฟไลน์
            </h3>
            <p className="text-[12px] text-ink-mute">
              เก็บเพลงทั้งหมดในเครื่อง ใช้ดูได้แม้ไม่มีเน็ต
            </p>
          </div>
        </div>

        {ios && !installed && (
          <div className="mb-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3.5 text-[13px] leading-[1.5] text-amber-100/90">
            <strong className="font-semibold">แนะนำ:</strong> บน iPad/iPhone
            ให้ "Add to Home Screen" ก่อน — โหมด PWA มีพื้นที่เก็บใหญ่กว่าและไม่ถูกล้างเมื่อล้าง Safari history
          </div>
        )}

        {!allDone && !willFit && (
          <div className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-3.5 text-[13px] leading-[1.5] text-danger">
            <strong className="font-semibold">พื้นที่ไม่พอ:</strong> เหลือ
            {" "}
            <span className="font-mono">{formatBytes(storage.available)}</span>
            {" "}แต่ต้องใช้ประมาณ
            {" "}
            <span className="font-mono">{formatBytes(estimatedSize)}</span>
            . ลองลบ website data เก่า หรือเคลียร์พื้นที่ในเครื่องก่อน
          </div>
        )}
        {!allDone && willFit && tightFit && (
          <div className="mb-4 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3.5 text-[13px] leading-[1.5] text-amber-100/90">
            <strong className="font-semibold">เฉียดฉิว:</strong> พื้นที่เหลือเกือบพอดี — บางเพลงสุดท้ายอาจล้มเหลวถ้า quota เต็มกลางทาง
          </div>
        )}

        {/* Status row */}
        <div className="mb-4 space-y-2 rounded-2xl border border-line/60 bg-bg-soft/40 p-4 text-[13px]">
          <Row
            label="ดาวน์โหลดแล้ว"
            value={
              <span>
                <span className="font-semibold text-ink">
                  {cachedCount.toLocaleString()}
                </span>
                <span className="text-ink-mute"> / {total.toLocaleString()} เพลง</span>
              </span>
            }
          />
          <Row
            label="พื้นที่ใช้ไป"
            value={
              <span className="font-mono text-ink-dim">
                {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
              </span>
            }
          />
          {!allDone && (
            <Row
              label="ประมาณการที่จะดาวน์โหลด"
              value={
                <span className="font-mono text-ink-dim">
                  ~{formatBytes(estimatedSize)}
                </span>
              }
            />
          )}
          <Row
            label="พื้นที่ถาวร"
            value={
              <span
                className={
                  storage.persisted ? "text-emerald-300" : "text-ink-mute"
                }
              >
                {storage.persisted ? "✓ อนุมัติแล้ว" : "ยังไม่อนุมัติ"}
              </span>
            }
          />
        </div>

        {/* Progress bar (only while downloading or right after) */}
        {progress && (
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-ink-dim">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
                {progress.failed > 0 && (
                  <span className="ml-2 text-danger/90">
                    · ล้มเหลว {progress.failed}
                  </span>
                )}
              </span>
              <span className="font-mono text-ink-mute">
                {Math.round((progress.done / progress.total) * 100)}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg-soft">
              <div
                className="h-full bg-brand-grad transition-[width] duration-200"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2.5">
          <button
            onClick={onClose}
            className="flex-1 rounded-2xl border border-line/60 bg-bg-soft py-3 text-[15px] font-semibold text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-[0.98]"
          >
            ปิด
          </button>
          {downloading ? (
            <button
              onClick={cancel}
              className="flex-1 rounded-2xl bg-danger py-3 text-[15px] font-semibold text-white shadow-[0_4px_16px_-4px_rgba(244,63,94,0.5)] ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98]"
            >
              หยุด
            </button>
          ) : (
            <button
              onClick={start}
              disabled={total === 0 || allDone || !willFit}
              className="flex-1 rounded-2xl bg-brand-grad py-3 text-[15px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {allDone
                ? "ครบแล้ว ✓"
                : !willFit
                  ? "พื้นที่ไม่พอ"
                  : cachedCount > 0
                    ? "ดาวน์โหลดต่อ"
                    : "เริ่มดาวน์โหลด"}
            </button>
          )}
        </div>

        {/* Clear-cache zone. Only shown when there's something cached to
            clear — the button + inline confirm pattern avoids the user
            wiping a 30-minute download with one tap. */}
        {cachedCount > 0 && !downloading && (
          <div className="mt-4 border-t border-line/40 pt-4">
            {confirmingClear ? (
              <div className="space-y-2.5">
                <p className="text-[13px] leading-[1.5] text-ink-dim">
                  ลบรูปที่ดาวน์โหลดไว้ทั้งหมด{" "}
                  <span className="font-semibold text-ink">
                    {cachedCount.toLocaleString()} เพลง
                  </span>{" "}
                  · จะใช้งานออฟไลน์ไม่ได้จนกว่าจะดาวน์โหลดใหม่
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmingClear(false)}
                    className="flex-1 rounded-xl border border-line/60 bg-bg-soft py-2.5 text-[14px] font-semibold text-ink-dim transition hover:bg-bg-hover hover:text-ink active:scale-[0.98]"
                  >
                    ยกเลิก
                  </button>
                  <button
                    onClick={clearCache}
                    className="flex-1 rounded-xl bg-danger py-2.5 text-[14px] font-semibold text-white shadow-[0_4px_16px_-4px_rgba(244,63,94,0.5)] ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98]"
                  >
                    ลบเลย
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingClear(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-[13px] font-medium text-ink-mute transition hover:bg-danger/10 hover:text-danger active:scale-[0.98]"
              >
                <TrashIcon className="size-[14px]" />
                ลบแคชทั้งหมด ({formatBytes(storage.usage)})
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-mute">{label}</span>
      {value}
    </div>
  );
}

function CloudDownloadIcon({
  className = "size-[18px]",
}: {
  className?: string;
}) {
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
      <path d="M20 16.2A4.5 4.5 0 0 0 17.5 8H17a7 7 0 0 0-13.5 1A4 4 0 0 0 4 17" />
      <path d="M12 12v8" />
      <path d="m8 17 4 4 4-4" />
    </svg>
  );
}
