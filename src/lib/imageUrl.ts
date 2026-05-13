import type { Song } from "../types";

const BASE = import.meta.env.VITE_IMAGE_BASE ?? "/images";

// Image filenames are derived from `song.name` — see scripts/build-data.mjs.
// Source on R2 is always PNG. The service worker transcodes to WebP on the
// fly during caching (see src/sw.ts) — the URL stays `.png` so the source of
// truth is unchanged.
export function imageUrl(song: Song) {
  return `${BASE}/${encodeURIComponent(song.name)}.png`;
}
