import type { Song } from "../types";

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

export function buildSearchIndex(songs: Song[]) {
  return songs.map((s) => normalize(s.name));
}

export function searchSongs(
  songs: Song[],
  index: string[],
  query: string,
  limit = 500,
): Song[] {
  const q = normalize(query);
  if (!q) return songs.slice(0, limit);
  const out: Song[] = [];
  for (let i = 0; i < index.length; i++) {
    if (index[i].includes(q)) {
      out.push(songs[i]);
      if (out.length >= limit) break;
    }
  }
  return out;
}
