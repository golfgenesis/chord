// ChordPro TEXT primitives — the song's chord sheet now lives as a markdown
// (.md) file on R2, fetched per-song at view time and intercepted by the
// service worker (stale-while-revalidate, see src/sw.ts) so it serves
// instantly offline. This replaces the old "bundle the text into songs.bin"
// model: songs.bin stays tiny (id + name) for the 10 ms in-memory search.
//
// URL scheme:  ${TEXT_BASE}/<id>.md
//   TEXT_BASE = VITE_TEXT_BASE, else `${VITE_IMAGE_BASE}/md`, else `/md`
//   (`/md` is served from data/songs-md by the vite dev middleware).
import type { Song } from "../types";
import { notifyCacheChanged } from "./offlineDownload";

const IMAGE_BASE = import.meta.env.VITE_IMAGE_BASE as string | undefined;
const TEXT_BASE: string =
  (import.meta.env.VITE_TEXT_BASE as string | undefined) ??
  (IMAGE_BASE ? `${IMAGE_BASE.replace(/\/+$/, "")}/md` : "/md");

const CACHE_NAME = "chord-text";

const PREFETCH_CONCURRENCY = 4;
const PREFETCH_TIMEOUT_MS = 30_000;

/** Absolute-or-relative URL of a song's ChordPro markdown on R2. */
export function chordTextUrl(song: Pick<Song, "id">): string {
  return `${TEXT_BASE}/${song.id}.md`;
}

/** Absolute URL (for comparing against cache.keys(), which returns absolute). */
export function absoluteChordTextUrl(song: Pick<Song, "id">): string {
  return new URL(chordTextUrl(song), window.location.href).href;
}

/**
 * Fetch a song's ChordPro markdown. Goes through the service worker, so a
 * cached copy is returned instantly (offline-safe) while SWR refreshes it.
 * Returns the raw text, or null when there is no sheet (404) / fetch fails
 * (offline + uncached) — the caller then falls back to the image.
 */
export async function fetchChordText(
  song: Pick<Song, "id">,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(chordTextUrl(song), { signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Set of every URL currently in the chord-text cache (powers offline-dot). */
export async function getCachedTextUrlSet(): Promise<Set<string>> {
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

// ─── Background prefetch pool ────────────────────────────────────────────
// Warms the chord-text cache for songs that matter (favorites / playlists /
// recents) so they open instantly AND work offline. Opportunistic and silent:
// already-cached songs are skipped, failures are ignored (retried on open).

const queue: Array<Pick<Song, "id">> = [];
const inFlight = new Set<number>();
let activeWorkers = 0;

export function prefetchChordTexts(songs: Iterable<Pick<Song, "id">>): void {
  if (!("caches" in window)) return;
  for (const s of songs) {
    if (inFlight.has(s.id)) continue;
    queue.push(s);
  }
  if (queue.length === 0) return;
  void pump();
}

async function pump(): Promise<void> {
  let cache: Cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    queue.length = 0;
    return;
  }
  while (activeWorkers < PREFETCH_CONCURRENCY && queue.length > 0) {
    const song = queue.shift();
    if (!song) break;
    if (inFlight.has(song.id)) continue;
    inFlight.add(song.id);
    activeWorkers++;
    void (async () => {
      try {
        await prefetchOne(cache, song);
      } finally {
        activeWorkers--;
        inFlight.delete(song.id);
        void pump();
      }
    })();
  }
}

async function prefetchOne(cache: Cache, song: Pick<Song, "id">): Promise<void> {
  const url = chordTextUrl(song);
  try {
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) return;
  } catch {
    return;
  }
  const ctrl = new AbortController();
  const timeoutId = window.setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);
  try {
    // The SW's SWR route intercepts this and populates the chord-text cache.
    const res = await fetch(url, { signal: ctrl.signal });
    // Defensive: if the SW didn't store it (stale SW / route miss), do it here.
    if (res.ok) {
      const stored = await cache.match(url, { ignoreVary: true });
      if (!stored) await cache.put(url, res.clone());
      // Refresh the offline-dot now that this song's text is cached.
      notifyCacheChanged();
    }
  } catch {
    // silent — opportunistic
  } finally {
    window.clearTimeout(timeoutId);
  }
}
