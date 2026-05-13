import { useMemo } from "react";
import { useApp } from "../store";
import { searchSongs } from "../lib/search";
import type { Song } from "../types";

export function useVisibleSongs(): Song[] {
  const songs = useApp((s) => s.songs);
  const songIndex = useApp((s) => s.songIndex);
  const byId = useApp((s) => s.byId);
  const query = useApp((s) => s.query);
  const tab = useApp((s) => s.tab);
  const favorites = useApp((s) => s.favorites);
  const latest = useApp((s) => s.latest);
  const playlists = useApp((s) => s.playlists);
  const activePlaylistId = useApp((s) => s.activePlaylistId);

  return useMemo(() => {
    if (tab === "favorites") {
      const base: Song[] = [];
      for (const id of favorites) {
        const s = byId.get(id);
        if (s) base.push(s);
      }
      if (!query.trim()) return base;
      const q = query.toLowerCase().normalize("NFC").trim();
      return base.filter((s) => s.name.toLowerCase().includes(q));
    }

    if (tab === "playlists") {
      if (!activePlaylistId) return [];
      const pl = playlists.find((p) => p.id === activePlaylistId);
      const base: Song[] = [];
      if (pl) {
        for (const id of pl.songIds) {
          const s = byId.get(id);
          if (s) base.push(s);
        }
      }
      if (!query.trim()) return base;
      const q = query.toLowerCase().normalize("NFC").trim();
      return base.filter((s) => s.name.toLowerCase().includes(q));
    }

    // tab === "all": when searching, just return search results.
    // When not searching, pin recently-played songs to the top.
    if (query.trim()) return searchSongs(songs, songIndex, query);

    if (latest.length === 0) return songs;
    const latestSet = new Set(latest);
    const pinned: Song[] = [];
    for (const id of latest) {
      const s = byId.get(id);
      if (s) pinned.push(s);
    }
    const rest = songs.filter((s) => !latestSet.has(s.id));
    return [...pinned, ...rest];
  }, [
    songs,
    songIndex,
    byId,
    query,
    tab,
    favorites,
    latest,
    playlists,
    activePlaylistId,
  ]);
}
