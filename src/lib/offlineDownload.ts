// Offline-image primitives. Used by Fullscreen (race the cache for instant
// open), SongList (green offline-dot per row), and a low-priority background
// prefetch that warms the cache for songs the user actually cares about —
// favorites, recents, and every playlist the room has.
//
// Bulk pre-caching the whole 70k catalogue used to live here. It's gone:
// the experience cost (multi-GB on disk, multi-hour download, iOS Safari
// quota / background-throttle fragility) wasn't worth it when 99% of users
// touch <1% of the dataset. The service worker's CacheFirst route handles
// on-demand caching for everything else, and `prefetchSongs` covers the
// "I want this offline before the gig" case for the songs that actually
// matter.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Song } from "../types";
import { imageUrl } from "./imageUrl";

const CACHE_NAME = "chord-images";

// Background prefetch tuning. Deliberately small — this runs while the
// user is browsing, so we never want it to compete with the foreground
// image they're about to view. Generous timeout (R2 edge is fast; if a
// fetch hangs for 30s something's wrong and we just drop it).
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_TIMEOUT_MS = 30_000;
// Coalesce notifyCacheChanged() bursts: when prefetch is hammering and
// 4 fetches resolve within the same React tick, we'd otherwise refresh
// useCachedSongIds 4× in a row. Batch into one notification per window.
const PREFETCH_NOTIFY_BATCH_MS = 500;

/**
 * Ask the browser to mark our storage persistent. Without this, the
 * Cache Storage entries we build up can be silently evicted when disk
 * pressure rises. Best called once at app start; Chrome accepts without
 * a gesture, Firefox needs one (we'll just no-op on Firefox without
 * complaint — eviction is recoverable, the next prefetch refills it).
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

/**
 * Build a Set of every URL currently in the chord-image cache. One
 * `cache.keys()` call beats per-song `cache.match()` round-trips by
 * orders of magnitude — used to power the green offline-dot in SongList.
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

// ─── Single-song defensive cache ─────────────────────────────────────────

/**
 * Defensive single-song cache. The Fullscreen viewer relies on the SW's
 * CacheFirst route to cache images it loads via `<img src>`, but on a
 * stale SW (or any device where the route pattern doesn't match — see
 * sw.ts IMAGE_BASE logic) that caching silently doesn't happen and the
 * green offline-available dot never appears.
 *
 * This function checks the cache directly; if the entry is missing it
 * fetches and `cache.put`s it itself. Cheap when the SW is healthy
 * (one `cache.match` only), reliable when the SW isn't.
 */
export async function ensureCached(song: Song): Promise<boolean> {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const url = imageUrl(song);
    // ignoreVary because the stored response carries `Vary: Origin`
    // from the R2 Transform Rule (see sw.ts).
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) return true;
    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return false;
      await cache.put(url, res);
      const stored = await cache.match(url, { ignoreVary: true });
      return Boolean(stored);
    } finally {
      window.clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

/**
 * Read a cached image directly out of Cache Storage as a blob: URL,
 * bypassing the service worker entirely. Used by Fullscreen to dodge
 * the SW's SQLite-backed cache lookup that adds 200–2000 ms on cold
 * iPad Safari — the "white frame on cached images" symptom.
 *
 * Returns null when the image is NOT cached, or when Cache Storage
 * isn't available. Caller MUST `URL.revokeObjectURL()` the returned
 * URL when no longer needed (otherwise the decoded image leaks).
 */
export async function getCachedImageBlobUrl(
  song: Song,
): Promise<string | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const url = imageUrl(song);
    const res = await cache.match(url, { ignoreVary: true });
    if (!res) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// ─── Background prefetch pool ────────────────────────────────────────────
//
// Opportunistic. Fire-and-forget. Callers hand in a list of songs ("these
// matter for offline"), the pool walks them with low concurrency. Anything
// already cached is skipped (single cache.match per song, no network).
// Failures are silent — if a song fails to prefetch we'll just refetch it
// when the user actually opens it.

const prefetchQueue: Song[] = [];
const prefetchInFlight = new Set<number>();
let prefetchActiveWorkers = 0;
let prefetchDirty = false;
let prefetchNotifyTimer: number | null = null;

/**
 * Queue songs for opportunistic background caching. Idempotent —
 * already-cached and already-queued songs are skipped automatically.
 * Returns immediately; the pool runs in the background.
 */
export function prefetchSongs(songs: Iterable<Song>): void {
  if (!("caches" in window)) return;
  for (const s of songs) {
    if (prefetchInFlight.has(s.id)) continue;
    prefetchQueue.push(s);
  }
  if (prefetchQueue.length === 0) return;
  void pumpPrefetch();
}

function scheduleCacheChangeNotify() {
  prefetchDirty = true;
  if (prefetchNotifyTimer !== null) return;
  prefetchNotifyTimer = window.setTimeout(() => {
    prefetchNotifyTimer = null;
    if (prefetchDirty) {
      prefetchDirty = false;
      notifyCacheChanged();
    }
  }, PREFETCH_NOTIFY_BATCH_MS);
}

async function pumpPrefetch(): Promise<void> {
  let cache: Cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    prefetchQueue.length = 0;
    return;
  }
  while (
    prefetchActiveWorkers < PREFETCH_CONCURRENCY &&
    prefetchQueue.length > 0
  ) {
    const song = prefetchQueue.shift();
    if (!song) break;
    if (prefetchInFlight.has(song.id)) continue;
    prefetchInFlight.add(song.id);
    prefetchActiveWorkers++;
    void (async () => {
      try {
        await prefetchOne(cache, song);
      } finally {
        prefetchActiveWorkers--;
        prefetchInFlight.delete(song.id);
        // Recurse on completion so we keep the pool topped up. The
        // queue might also have grown (new favorites added during the
        // run); pump picks those up too.
        void pumpPrefetch();
      }
    })();
  }
}

async function prefetchOne(cache: Cache, song: Song): Promise<void> {
  const url = imageUrl(song);
  try {
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) return;
  } catch {
    return;
  }
  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return;
    await cache.put(url, res);
    scheduleCacheChangeNotify();
  } catch {
    // silent — prefetch is opportunistic, the user will retry on open
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// ─── Cache wipe (manual debug / future settings hook) ────────────────────

/**
 * Wipe the entire chord-image cache. No UI surfaces this currently —
 * the SW's ExpirationPlugin caps the cache at 80k entries so unbounded
 * growth isn't a concern — but keep the primitive available for debug
 * console use and any future "reset offline cache" affordance.
 */
export async function clearImageCache(): Promise<boolean> {
  if (!("caches" in window)) return false;
  try {
    const ok = await caches.delete(CACHE_NAME);
    notifyCacheChanged();
    return ok;
  } catch {
    return false;
  }
}

// ─── Cache change pub/sub ────────────────────────────────────────────────
//
// The chord-image Cache Storage has no native change event. Anything that
// mutates it (a Fullscreen image load that just got SW-cached, an explicit
// clearImageCache, a prefetch batch finishing) calls notifyCacheChanged()
// so every subscriber re-scans cache.keys() and updates its derived state.

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

// ─── Hook: cached-song-id Set for SongList ───────────────────────────────

/**
 * Returns a Set of `song.id`s whose image is currently in the offline
 * cache. Refreshes whenever notifyCacheChanged() fires (Fullscreen
 * caches a song, prefetch completes a batch, etc.).
 */
export function useCachedSongIds(songs: Song[]): Set<number> {
  const [cached, setCached] = useState<Set<number>>(() => new Set());
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
    return () => {
      cancelled = true;
    };
  }, [songs, cv]);

  return cached;
}
