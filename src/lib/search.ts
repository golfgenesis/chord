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
  // Split into whitespace-separated tokens and require ALL of them to
  // appear somewhere in the name (order-independent). Lets "รอ The R"
  // match "รอน้องจอดหัวใจ The Richman Toy" even though the tokens are
  // not contiguous in the source string.
  const tokens = q.split(" ").filter(Boolean);
  const out: Song[] = [];
  for (let i = 0; i < index.length; i++) {
    const name = index[i];
    let ok = true;
    for (let t = 0; t < tokens.length; t++) {
      if (!name.includes(tokens[t])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push(songs[i]);
      if (out.length >= limit) break;
    }
  }
  return out;
}
