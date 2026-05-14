import type { Song } from "../types";

const BASE = import.meta.env.VITE_IMAGE_BASE ?? "/images";

// Image filenames are derived from `song.name` — see scripts/build-data.mjs.
export function imageUrl(song: Song) {
  return `${BASE}/${encodeURIComponent(song.name)}.webp`;
}
