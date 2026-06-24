import { useEffect } from "react";
import { useApp } from "../store";
import { prefetchSongs } from "../lib/offlineDownload";
import { prefetchChordTexts } from "../lib/chordText";
import type { Song } from "../types";

/**
 * Background-cache the chord sheets for songs the user actually cares about —
 * favorites, recents, and every playlist in the current room (mine +
 * bandmates'). Warms BOTH caches: the ChordPro text (.md, the primary view)
 * and the WebP image (the offline fallback). Runs on low-concurrency pools
 * that skip already-cached entries, so re-firing on every collection change
 * is cheap.
 *
 * This replaces the old "ดาวน์โหลด 70k ทั้งหมด" sweep. The total set is
 * usually <500 songs even for heavy users, and the prefetch silently
 * finishes in the background instead of being a multi-hour UI ordeal.
 */
export function useAutoPrefetch(): void {
  const loaded = useApp((s) => s.loaded);
  const byId = useApp((s) => s.byId);
  const favorites = useApp((s) => s.favorites);
  const latest = useApp((s) => s.latest);
  const playlists = useApp((s) => s.playlists);
  const othersPlaylists = useApp((s) => s.othersPlaylists);

  useEffect(() => {
    if (!loaded || byId.size === 0) return;
    const ids = new Set<number>();
    for (const id of favorites) ids.add(id);
    for (const id of latest) ids.add(id);
    for (const p of playlists) for (const id of p.songIds) ids.add(id);
    for (const lists of Object.values(othersPlaylists)) {
      for (const p of lists) for (const id of p.songIds) ids.add(id);
    }
    const songs: Song[] = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (s) songs.push(s);
    }
    if (songs.length > 0) {
      prefetchChordTexts(songs); // primary view (.md text)
      prefetchSongs(songs); // offline image fallback
    }
  }, [loaded, byId, favorites, latest, playlists, othersPlaylists]);
}
