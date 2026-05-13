import { create } from "zustand";
import type { Playlist, RoomState, Song, Tab } from "./types";
import { loadJSON, loadLocal, saveJSON, saveLocal } from "./lib/persist";
import { buildSearchIndex } from "./lib/search";
import { getRoomSync, type RoomSync } from "./lib/firebase";
import { startCloudSync, pushUpdate } from "./lib/cloudSync";

function randomRoom() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function randomClientId() {
  return Math.random().toString(36).slice(2, 10);
}

// Firebase RTDB drops empty arrays and arrays-with-holes, so playlists read
// back from the wire may be missing `songIds` entirely or arrive as a sparse
// object. Normalize to a well-formed array.
function normalizePlaylists(raw: unknown): Playlist[] {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw as object);
  return arr
    .filter((p): p is Partial<Playlist> => p != null && typeof p === "object")
    .map((p) => ({
      id: String(p.id ?? Math.random().toString(36).slice(2, 10)),
      name: String(p.name ?? "Untitled"),
      songIds: Array.isArray(p.songIds) ? p.songIds.filter((x) => typeof x === "number") : [],
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    }));
}

interface State {
  // dataset
  songs: Song[];
  songIndex: string[];
  byId: Map<number, Song>;
  loaded: boolean;

  // ui
  query: string;
  tab: Tab;
  viewing: Song | null; // fullscreen image
  activePlaylistId: string | null;

  // identity / room
  clientId: string;
  roomCode: string;
  room: RoomState | null;
  unsubscribeRoom: (() => void) | null;
  unsubscribeRoomPlaylists: (() => void) | null;
  sync: RoomSync | null;

  // persisted collections
  favorites: Set<number>;
  latest: number[]; // most recent first
  playlists: Playlist[];

  // actions
  init: () => Promise<void>;
  setQuery: (q: string) => void;
  setTab: (t: Tab) => void;
  setRoomCode: (code: string, pushToCloud?: boolean) => void;
  randomizeRoom: () => void;
  open: (song: Song, broadcast?: boolean) => void;
  close: () => void;
  toggleFavorite: (id: number) => void;
  addToPlaylist: (playlistId: string, id: number) => void;
  removeFromPlaylist: (playlistId: string, id: number) => void;
  createPlaylist: (name: string) => string;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  setActivePlaylist: (id: string | null) => void;
}

export const useApp = create<State>((set, get) => ({
  songs: [],
  songIndex: [],
  byId: new Map(),
  loaded: false,

  query: "",
  tab: "all",
  viewing: null,
  activePlaylistId: null,

  clientId: "",
  roomCode: "",
  room: null,
  unsubscribeRoom: null,
  unsubscribeRoomPlaylists: null,
  sync: null,

  favorites: new Set(),
  latest: [],
  playlists: [],

  async init() {
    // Persisted identity / room
    let clientId = loadLocal<string>("clientId", "");
    if (!clientId) {
      clientId = randomClientId();
      saveLocal("clientId", clientId);
    }
    let roomCode = loadLocal<string>("roomCode", "");
    if (!/^\d{6}$/.test(roomCode)) {
      roomCode = randomRoom();
      saveLocal("roomCode", roomCode);
    }

    // Persisted collections
    const [favArr, latest, playlists] = await Promise.all([
      loadJSON<number[]>("favorites", []),
      loadJSON<number[]>("latest", []),
      loadJSON<Playlist[]>("playlists", []),
    ]);

    set({
      clientId,
      roomCode,
      favorites: new Set(favArr),
      latest,
      playlists,
    });

    // Songs dataset
    const res = await fetch("/songs.json");
    const songs = (await res.json()) as Song[];
    const byId = new Map<number, Song>();
    for (const s of songs) byId.set(s.id, s);
    set({
      songs,
      songIndex: buildSearchIndex(songs),
      byId,
      loaded: true,
    });

    // Room subscribe with the locally-known code (don't push to cloud yet —
    // we'll let cloud sync below decide whether to override).
    get().setRoomCode(roomCode, false);

    // Cross-device sync of per-user data via Firestore (Anonymous Auth).
    // Playlists are per-room (not per-user) and handled by the room sync below.
    startCloudSync(
      { favorites: favArr, latest, roomCode },
      (remote) => {
        set({
          favorites: new Set(remote.favorites ?? []),
          latest: remote.latest ?? [],
        });
        saveJSON("favorites", remote.favorites ?? []);
        saveJSON("latest", remote.latest ?? []);
        if (
          remote.roomCode &&
          /^\d{6}$/.test(remote.roomCode) &&
          remote.roomCode !== get().roomCode
        ) {
          get().setRoomCode(remote.roomCode, false);
        }
      },
    ).catch((err) => console.error("cloud sync init failed:", err));
  },

  setQuery: (q) => set({ query: q }),
  setTab: (t) =>
    set({
      tab: t,
      activePlaylistId:
        t === "playlists" ? get().activePlaylistId : null,
    }),

  setRoomCode(code, pushToCloud = true) {
    const valid = /^\d{6}$/.test(code);
    if (!valid) return;
    if (code === get().roomCode && get().sync) return; // no-op if unchanged

    const oldUnsubRoom = get().unsubscribeRoom;
    const oldUnsubPL = get().unsubscribeRoomPlaylists;
    if (oldUnsubRoom) oldUnsubRoom();
    if (oldUnsubPL) oldUnsubPL();

    const sync = getRoomSync(code);
    const unsub = sync.subscribe((state) => set({ room: state }));

    // Subscribe to the room's playlists. First snapshot decides whether to
    // adopt remote (room already has data) or seed remote with local.
    let firstPLSnap = true;
    const unsubPL = sync.subscribePlaylists((remote) => {
      const normalized = normalizePlaylists(remote);
      if (firstPLSnap) {
        firstPLSnap = false;
        if (normalized.length > 0) {
          set({ playlists: normalized, activePlaylistId: null });
          saveJSON("playlists", normalized);
        } else {
          // Empty room. If we have local playlists, seed them up.
          const localPL = get().playlists;
          if (localPL.length > 0) {
            sync.publishPlaylists(localPL).catch(console.error);
          } else {
            set({ playlists: [], activePlaylistId: null });
          }
        }
      } else {
        set((prev) => ({
          playlists: normalized,
          activePlaylistId:
            normalized.find((p) => p.id === prev.activePlaylistId)?.id ?? null,
        }));
        saveJSON("playlists", normalized);
      }
    });

    saveLocal("roomCode", code);
    if (pushToCloud) pushUpdate({ roomCode: code });
    set({
      roomCode: code,
      sync,
      unsubscribeRoom: unsub,
      unsubscribeRoomPlaylists: unsubPL,
      room: null,
    });
  },

  randomizeRoom() {
    get().setRoomCode(randomRoom());
  },

  open(song, broadcast = true) {
    set({ viewing: song });
    // push to "latest" (dedup, newest first; unbounded)
    const cur = get().latest.filter((id) => id !== song.id);
    cur.unshift(song.id);
    set({ latest: cur });
    saveJSON("latest", cur);
    pushUpdate({ latest: cur });
    // broadcast to room
    if (broadcast) {
      const sync = get().sync;
      const clientId = get().clientId;
      sync?.publish({
        songId: song.id,
        songName: song.name,
        pickedBy: clientId,
        pickedAt: Date.now(),
      });
    }
  },

  close: () => set({ viewing: null }),

  toggleFavorite(id) {
    const f = new Set(get().favorites);
    if (f.has(id)) f.delete(id);
    else f.add(id);
    set({ favorites: f });
    const arr = [...f];
    saveJSON("favorites", arr);
    pushUpdate({ favorites: arr });
  },

  addToPlaylist(playlistId, id) {
    const playlists = get().playlists.map((p) =>
      p.id === playlistId && !p.songIds.includes(id)
        ? { ...p, songIds: [...p.songIds, id] }
        : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  removeFromPlaylist(playlistId, id) {
    const playlists = get().playlists.map((p) =>
      p.id === playlistId
        ? { ...p, songIds: p.songIds.filter((x) => x !== id) }
        : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  createPlaylist(name) {
    const id = Math.random().toString(36).slice(2, 10);
    const p: Playlist = { id, name, songIds: [], createdAt: Date.now() };
    const playlists = [...get().playlists, p];
    set({ playlists, activePlaylistId: id });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
    return id;
  },

  renamePlaylist(id, name) {
    const playlists = get().playlists.map((p) =>
      p.id === id ? { ...p, name } : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  deletePlaylist(id) {
    const playlists = get().playlists.filter((p) => p.id !== id);
    set({
      playlists,
      activePlaylistId:
        get().activePlaylistId === id ? null : get().activePlaylistId,
    });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  setActivePlaylist(id) {
    set({ activePlaylistId: id });
  },
}));
