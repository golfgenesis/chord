// Bulk download of chord-sheet images for offline use. Hands each URL to
// the service worker via a regular `fetch`; the SW's CacheFirst route then
// caches the response. When the device later goes offline the same cache
// serves the same URLs without a network round-trip.
//
// IMPORTANT: this requires the service worker to be active. In dev that
// means `devOptions.enabled: true` in vite.config.ts; in prod the SW
// registers automatically via vite-plugin-pwa.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Song } from "../types";
import { imageUrl } from "./imageUrl";

const CACHE_NAME = "chord-images";

export interface DownloadProgress {
  done: number;
  total: number;
  failed: number;
}

export interface StorageInfo {
  quota: number | null;
  usage: number | null;
  /** Bytes remaining before the browser starts evicting (best estimate). */
  available: number | null;
  /** True if the user has been granted persistent storage — the browser
   *  won't evict our cache when disk fills up. */
  persisted: boolean;
}

/**
 * Ask the browser to mark our storage persistent. Without this the chord-
 * image cache can be silently evicted when disk space runs low, throwing
 * away a 30-minute download. Requires a user-gesture context on most
 * browsers (so call it from a click handler).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const persisted =
    navigator.storage?.persisted
      ? await navigator.storage.persisted().catch(() => false)
      : false;
  if (!navigator.storage?.estimate) {
    return { quota: null, usage: null, available: null, persisted };
  }
  try {
    const e = await navigator.storage.estimate();
    const quota = e.quota ?? null;
    const usage = e.usage ?? null;
    const available = quota !== null && usage !== null ? quota - usage : null;
    return { quota, usage, available, persisted };
  } catch {
    return { quota: null, usage: null, available: null, persisted };
  }
}

/**
 * Build a Set of every URL currently in the chord-image cache. One
 * `cache.keys()` call beats 70k individual `cache.match()` round-trips by
 * orders of magnitude — used both to fast-skip already-downloaded songs
 * and to display "ดาวน์โหลดแล้ว N เพลง" in the UI.
 */
export async function getCachedUrlSet(): Promise<Set<string>> {
  if (!("caches" in window)) return new Set();
  try {
    const cache = await caches.open(CACHE_NAME);
    const reqs = await cache.keys();
    const out = new Set<string>();
    for (const r of reqs) out.add(r.url);
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Resolve a song's URL to an absolute one so it can be compared against
 * the cache's key set (cache.keys() returns absolute URLs).
 */
export function absoluteImageUrl(song: Song): string {
  return new URL(imageUrl(song), window.location.href).href;
}

/**
 * Concurrent bulk-download with a configurable worker pool. Skips songs
 * that are already cached, calls `onProgress` after each completion, and
 * aborts immediately if the caller calls `signal.abort()`.
 *
 * The function intentionally swallows per-song failures (network blips,
 * 404s) — they're recorded in `progress.failed` so the UI can surface a
 * "N เพลงโหลดไม่สำเร็จ" tally and let the user retry, but they don't kill
 * the whole batch.
 */
export async function downloadAllSongs(
  songs: Song[],
  concurrency: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  const cached = await getCachedUrlSet();
  const queue: Song[] = [];
  for (const s of songs) {
    if (!cached.has(absoluteImageUrl(s))) queue.push(s);
  }

  const total = songs.length;
  let done = songs.length - queue.length;
  let failed = 0;
  onProgress({ done, total, failed });

  async function worker() {
    while (queue.length && !signal.aborted) {
      const song = queue.shift();
      if (!song) break;
      try {
        // Default cors mode. Both environments are configured so this
        // produces a non-opaque cache entry (no Chrome padding tax):
        //   - PROD: VITE_IMAGE_BASE=/images → same-origin (Pages Function
        //     in functions/images/[[path]].ts proxies R2). CORS doesn't
        //     apply at all, response is "basic".
        //   - DEV: VITE_IMAGE_BASE points at the R2 Public Development URL
        //     which honors the bucket's CORS Policy, so the cross-origin
        //     fetch returns proper Access-Control-Allow-Origin headers
        //     and the response is "cors" (not opaque).
        // Don't repoint VITE_IMAGE_BASE at the Cloudflare custom-domain
        // R2 URL — it strips CORS headers and would push every entry
        // back into opaque + ~7 MB-per-entry padding land.
        const res = await fetch(imageUrl(song), { signal });
        if (res.ok) {
          await res.blob();
          done++;
        } else {
          failed++;
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        failed++;
      }
      onProgress({ done, total, failed });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { done, total, failed };
}

// ─── Cache change pub/sub ────────────────────────────────────────────────
//
// The chord-image Cache Storage has no native change event. Anything that
// mutates it (a Fullscreen image load that just got SW-cached, an explicit
// clearImageCache, a one-off fetch) has to call notifyCacheChanged() so
// every subscriber re-scans cache.keys() and updates its derived state.
// Without this, the green "offline-available" dot in SongList stays stale
// after the user views a song, and the "downloaded N เพลง" tally in
// OfflineSheet doesn't fall to 0 after Clear Cache.

let cacheVersion = 0;
const cacheChangeListeners = new Set<() => void>();

export function subscribeCacheChange(listener: () => void): () => void {
  cacheChangeListeners.add(listener);
  return () => {
    cacheChangeListeners.delete(listener);
  };
}

export function getCacheVersion(): number {
  return cacheVersion;
}

export function notifyCacheChanged(): void {
  cacheVersion++;
  for (const l of cacheChangeListeners) l();
}

// ─── Singleton download manager ──────────────────────────────────────────
//
// The OfflineSheet modal mounts and unmounts as the user opens/closes it,
// so React-local state (`useState`) would reset to `progress=null` every
// time they reopen — even mid-download. Keeping the download's progress
// and AbortController at module scope (and exposing them through a
// useSyncExternalStore subscription) lets the modal disappear without
// affecting the in-flight work. When the user reopens the sheet they see
// "52 / 70,107" right where it was, not 0%.

export interface DownloadManagerState {
  isDownloading: boolean;
  progress: DownloadProgress | null;
}

let managerState: DownloadManagerState = {
  isDownloading: false,
  progress: null,
};
let currentController: AbortController | null = null;
const listeners = new Set<() => void>();

function setManagerState(patch: Partial<DownloadManagerState>) {
  managerState = { ...managerState, ...patch };
  for (const l of listeners) l();
}

export function subscribeDownload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDownloadState(): DownloadManagerState {
  return managerState;
}

/**
 * Start (or no-op if already running) a bulk-download of the given songs.
 * Returns the final progress, or `null` if a download was already in
 * flight. Cleans up `isDownloading` automatically on completion or abort.
 */
export async function startBulkDownload(
  songs: Song[],
  concurrency: number,
): Promise<DownloadProgress | null> {
  if (managerState.isDownloading) return null;
  const ctrl = new AbortController();
  currentController = ctrl;
  setManagerState({
    isDownloading: true,
    progress: { done: 0, total: songs.length, failed: 0 },
  });
  try {
    const finalProgress = await downloadAllSongs(
      songs,
      concurrency,
      (p) => setManagerState({ progress: p }),
      ctrl.signal,
    );
    setManagerState({ progress: finalProgress });
    return finalProgress;
  } finally {
    setManagerState({ isDownloading: false });
    if (currentController === ctrl) currentController = null;
  }
}

export function abortBulkDownload(): void {
  currentController?.abort();
}

/**
 * Wipe the entire chord-image cache. Used by the "clear cache" button in
 * the offline-mode sheet — gives the user a way to reclaim the GBs the
 * pre-cache consumed without having to use the browser's settings UI.
 *
 * Aborts any in-flight bulk download first so the abortion handler can
 * unwind cleanly (otherwise workers keep adding to the cache while we
 * clear it from underneath them and the storage usage stays misleading).
 */
export async function clearImageCache(): Promise<boolean> {
  abortBulkDownload();
  // Tiny pause so the workers actually observe the abort signal before
  // we drop the cache out from under them — otherwise some "in flight"
  // fetches finish after `caches.delete` and re-add entries.
  await new Promise((r) => setTimeout(r, 100));
  if (!("caches" in window)) return false;
  try {
    const ok = await caches.delete(CACHE_NAME);
    setManagerState({ progress: null });
    notifyCacheChanged();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Returns a Set of `song.id`s whose image is currently in the offline
 * cache. Subscribes to the bulk-download manager so badges update as the
 * download progresses; uses an interval poll while download is running
 * because progress fires too rapidly to recompute every tick. When idle
 * (no download in flight), refreshes only on mount + when songs/viewing
 * change — single-view caches get picked up on the next interaction.
 */
export function useCachedSongIds(songs: Song[]): Set<number> {
  const [cached, setCached] = useState<Set<number>>(() => new Set());
  const dl = useSyncExternalStore(subscribeDownload, getDownloadState);
  // Re-scan whenever something explicitly tells us the cache changed
  // (Fullscreen image load, clearImageCache, etc.) — Cache Storage has
  // no native change event so notifyCacheChanged() is the trigger.
  const cv = useSyncExternalStore(subscribeCacheChange, getCacheVersion);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (songs.length === 0) return;
      const urlSet = await getCachedUrlSet();
      if (cancelled) return;
      const ids = new Set<number>();
      for (const s of songs) {
        if (urlSet.has(absoluteImageUrl(s))) ids.add(s.id);
      }
      if (!cancelled) setCached(ids);
    }
    refresh();
    if (dl.isDownloading) {
      const id = window.setInterval(refresh, 2000);
      return () => {
        cancelled = true;
        window.clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [songs, dl.isDownloading, cv]);

  return cached;
}

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
