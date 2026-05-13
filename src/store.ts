import { create } from "zustand";
import type { Playlist, RoomState, Song, Tab } from "./types";
import { loadJSON, loadLocal, saveJSON, saveLocal } from "./lib/persist";
import { buildSearchIndex } from "./lib/search";
import { decodeSongs } from "./lib/songsCodec";
// Firebase + cloudSync are heavy (~300 KB of the Firebase SDK). We import
// them dynamically so they end up in their own chunk and load in parallel
// with songs.json — the search UI never blocks on them.
import type { RoomSync } from "./lib/firebase";
type FbMod = typeof import("./lib/firebase");
type CsMod = typeof import("./lib/cloudSync");

let fbMod: FbMod | null = null;
let csMod: CsMod | null = null;
let firebaseLoading: Promise<void> | null = null;

function loadFirebase(): Promise<void> {
  if (!firebaseLoading) {
    firebaseLoading = Promise.all([
      import("./lib/firebase"),
      import("./lib/cloudSync"),
    ])
      .then(([fb, cs]) => {
        fbMod = fb;
        csMod = cs;
      })
      .catch((err) => {
        console.error("Firebase chunk failed to load:", err);
      });
  }
  return firebaseLoading;
}

// Max items kept in the "latest opened" history. Caps the size of the
// per-user Firestore doc so it can't grow forever.
const LATEST_CAP = 30;

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

function isRoomOwner(s: Pick<State, "clientId" | "roomOwnerClientId">): boolean {
  return Boolean(s.clientId) && s.roomOwnerClientId === s.clientId;
}

// Decide which playlist should be active. On the Playlists tab we always
// auto-pick the first one if the current selection is invalid or missing —
// the user shouldn't see "0 เพลง" when the room clearly has playlists.
function resolveActivePlaylistId(
  playlists: Playlist[],
  current: string | null,
  tab: Tab,
): string | null {
  if (tab !== "playlists") return null;
  if (current && playlists.some((p) => p.id === current)) return current;
  return playlists[0]?.id ?? null;
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
  invertImages: boolean; // dark-mode chord sheets (CSS filter invert)

  // identity / room
  clientId: string;
  roomCode: string;
  room: RoomState | null;
  roomOwnerClientId: string | null;
  unsubscribeRoom: (() => void) | null;
  unsubscribeRoomPlaylists: (() => void) | null;
  unsubscribeRoomOwner: (() => void) | null;
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
  reorderPlaylist: (playlistId: string, songIds: number[]) => void;
  createPlaylist: (name: string) => string;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  setActivePlaylist: (id: string | null) => void;
  toggleInvertImages: () => void;
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
  invertImages: false,

  clientId: "",
  roomCode: "",
  room: null,
  roomOwnerClientId: null,
  unsubscribeRoom: null,
  unsubscribeRoomPlaylists: null,
  unsubscribeRoomOwner: null,
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
    // Room code resolution order:
    //   1. URL path  `/{6 digits}`  — wins so shared links land in the right
    //      room even if the recipient had a different one saved locally.
    //   2. localStorage              — return visit, no link.
    //   3. random                    — first time, no link.
    // Whichever wins is written back to the URL via history.replaceState so
    // it's always shareable from the address bar.
    let roomCode: string;
    const urlMatch = window.location.pathname.match(/^\/(\d{6})$/);
    // urlForcedRoom: the user landed on this device via a shared link, so
    // their URL choice MUST beat whatever stale roomCode is sitting in this
    // client's Firestore doc from a previous session. Without this, the
    // first cloud-sync snapshot would call setRoomCode(remote) and bounce
    // the URL back to the old room.
    const urlForcedRoom = Boolean(urlMatch);
    if (urlMatch) {
      roomCode = urlMatch[1];
      saveLocal("roomCode", roomCode);
    } else {
      roomCode = loadLocal<string>("roomCode", "");
      if (!/^\d{6}$/.test(roomCode)) {
        roomCode = randomRoom();
        saveLocal("roomCode", roomCode);
      }
    }
    history.replaceState(null, "", `/${roomCode}`);
    // Back/forward navigation between rooms.
    window.addEventListener("popstate", () => {
      const m = window.location.pathname.match(/^\/(\d{6})$/);
      if (m && m[1] !== get().roomCode) get().setRoomCode(m[1]);
    });
    const invertImages = loadLocal<boolean>("invertImages", false);
    set({ invertImages });

    // Kick off heavy work in parallel: the songs dataset, the Firebase chunk,
    // and the locally-persisted collections. The shell renders as soon as the
    // local state lands; songs and Firebase fill in independently.
    const songsPromise = fetch("/songs.bin")
      .then((r) => r.arrayBuffer())
      .then(decodeSongs);
    const firebasePromise = loadFirebase();
    const [favArr, latestRaw, playlists] = await Promise.all([
      loadJSON<number[]>("favorites", []),
      loadJSON<number[]>("latest", []),
      loadJSON<Playlist[]>("playlists", []),
    ]);
    const latest = latestRaw.slice(0, LATEST_CAP);

    set({
      clientId,
      roomCode,
      favorites: new Set(favArr),
      latest,
      playlists,
    });

    // Songs dataset
    const songs = await songsPromise;
    const byId = new Map<number, Song>();
    for (const s of songs) byId.set(s.id, s);
    set({
      songs,
      songIndex: buildSearchIndex(songs),
      byId,
      loaded: true,
    });

    // Wait for the Firebase chunk before wiring up room sync / cloud sync.
    // The UI is already usable at this point — these add multi-device features.
    await firebasePromise;

    // Room subscribe with the locally-known code (don't push to cloud yet —
    // we'll let cloud sync below decide whether to override).
    get().setRoomCode(roomCode, false);

    // Cross-device sync of per-user data via Firestore (Anonymous Auth).
    // Playlists are per-room (not per-user) and handled by the room sync above.
    // The first remote snapshot may carry a stale roomCode from this client's
    // last session. If the URL just told us which room to be in, that wins —
    // we push the URL room up to cloud instead of adopting cloud's old value.
    // Subsequent snapshots can adopt normally (that's cross-device sync).
    let pendingUrlPush = urlForcedRoom;
    csMod
      ?.startCloudSync(
        clientId,
        { favorites: favArr, latest, roomCode },
        (remote) => {
          const remoteLatest = (remote.latest ?? []).slice(0, LATEST_CAP);
          set({
            favorites: new Set(remote.favorites ?? []),
            latest: remoteLatest,
          });
          saveJSON("favorites", remote.favorites ?? []);
          saveJSON("latest", remoteLatest);
          if (pendingUrlPush) {
            pendingUrlPush = false;
            if (remote.roomCode !== get().roomCode) {
              csMod?.pushUpdate({ roomCode: get().roomCode });
            }
            return;
          }
          if (
            remote.roomCode &&
            /^\d{6}$/.test(remote.roomCode) &&
            remote.roomCode !== get().roomCode
          ) {
            get().setRoomCode(remote.roomCode, false);
          }
        },
      )
      .catch((err) => console.error("cloud sync init failed:", err));
  },

  setQuery: (q) => set({ query: q }),
  setTab: (t) => {
    const { playlists, activePlaylistId } = get();
    set({
      tab: t,
      activePlaylistId: resolveActivePlaylistId(playlists, activePlaylistId, t),
    });
  },

  setRoomCode(code, pushToCloud = true) {
    const valid = /^\d{6}$/.test(code);
    if (!valid) return;
    if (code === get().roomCode && get().sync) return; // no-op if unchanged

    // Firebase chunk not loaded yet — just persist locally; init() will pick
    // this up once Firebase finishes loading.
    if (!fbMod) {
      saveLocal("roomCode", code);
      set({ roomCode: code });
      return;
    }

    // Tear down old room. If we were owner of it, release ownership in the DB
    // so the room becomes claimable again.
    const oldUnsubRoom = get().unsubscribeRoom;
    const oldUnsubPL = get().unsubscribeRoomPlaylists;
    const oldUnsubOwner = get().unsubscribeRoomOwner;
    const oldSync = get().sync;
    const oldOwnerId = get().roomOwnerClientId;
    const myClientId = get().clientId;
    if (oldSync && oldOwnerId && oldOwnerId === myClientId) {
      oldSync.releaseOwner(myClientId).catch(console.error);
    }
    if (oldUnsubRoom) oldUnsubRoom();
    if (oldUnsubPL) oldUnsubPL();
    if (oldUnsubOwner) oldUnsubOwner();

    const sync = fbMod.getRoomSync(code);
    const unsub = sync.subscribe((state) => set({ room: state }));

    // Subscribe to ownership. We attempt to claim whenever the room is
    // unowned — both on the first snapshot of a fresh room AND whenever the
    // current owner disconnects (their onDisconnect handler wipes the whole
    // rooms/{code} node, which fires a null snapshot for every remaining
    // guest). Without re-claiming, everyone would be stuck as Guest forever
    // after the owner closes their tab. claimOwner uses an RTDB transaction
    // so racing guests resolve to exactly one winner.
    const unsubOwner = sync.subscribeOwner((owner) => {
      const prevOwnerId = get().roomOwnerClientId;
      const nextOwnerId = owner?.clientId ?? null;
      set({ roomOwnerClientId: nextOwnerId });
      if (!nextOwnerId) {
        sync.claimOwner(myClientId).catch(console.error);
        return;
      }
      // On transitioning into ownership, seed the room with our local
      // playlists. If the room already had playlists, they were adopted by
      // subscribePlaylists; this just republishes the current state, which is
      // a no-op.
      if (nextOwnerId === myClientId && prevOwnerId !== myClientId) {
        const localPL = get().playlists;
        if (localPL.length > 0) {
          sync.publishPlaylists(localPL).catch(console.error);
        }
      }
    });

    // Subscribe to playlists. We always adopt the remote view (the owner is
    // the source of truth) UNLESS the remote is null/empty — that happens
    // when the owner disconnects and their onDisconnect wipes the room node.
    // Treating null as "wipe local" would destroy every guest's playlists
    // when the owner leaves. Instead we keep local intact; whichever guest
    // wins the re-claim will republish from their own copy.
    let firstPLSnap = true;
    const unsubPL = sync.subscribePlaylists((remote) => {
      const normalized = normalizePlaylists(remote);
      if (firstPLSnap) {
        firstPLSnap = false;
        if (normalized.length > 0) {
          set((prev) => ({
            playlists: normalized,
            activePlaylistId: resolveActivePlaylistId(
              normalized,
              prev.activePlaylistId,
              prev.tab,
            ),
          }));
          saveJSON("playlists", normalized);
        }
        // If empty: leave local playlists untouched for now. If we end up
        // owning this room, the owner-subscription will publish them.
        return;
      }
      // Subsequent snapshots: only adopt non-empty payloads. Empty/null means
      // the room was abandoned and is about to be re-claimed by someone.
      if (normalized.length === 0) return;
      set((prev) => ({
        playlists: normalized,
        activePlaylistId: resolveActivePlaylistId(
          normalized,
          prev.activePlaylistId,
          prev.tab,
        ),
      }));
      saveJSON("playlists", normalized);
    });

    saveLocal("roomCode", code);
    // Keep the URL in sync so the address bar is always shareable. We use
    // pushState (not replaceState) so back/forward walks through prior rooms.
    if (window.location.pathname !== `/${code}`) {
      history.pushState(null, "", `/${code}`);
    }
    if (pushToCloud) csMod?.pushUpdate({ roomCode: code });
    set({
      roomCode: code,
      sync,
      unsubscribeRoom: unsub,
      unsubscribeRoomPlaylists: unsubPL,
      unsubscribeRoomOwner: unsubOwner,
      room: null,
      roomOwnerClientId: null,
    });
  },

  randomizeRoom() {
    get().setRoomCode(randomRoom());
  },

  open(song, broadcast = true) {
    set({ viewing: song });
    // push to "latest" (dedup, newest first, FIFO max 30 so the per-user
    // Firestore doc stays bounded)
    const cur = get().latest.filter((id) => id !== song.id);
    cur.unshift(song.id);
    if (cur.length > LATEST_CAP) cur.length = LATEST_CAP;
    set({ latest: cur });
    saveJSON("latest", cur);
    csMod?.pushUpdate({ latest: cur });
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
    csMod?.pushUpdate({ favorites: arr });
  },

  addToPlaylist(playlistId, id) {
    if (!isRoomOwner(get())) return;
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
    if (!isRoomOwner(get())) return;
    const playlists = get().playlists.map((p) =>
      p.id === playlistId
        ? { ...p, songIds: p.songIds.filter((x) => x !== id) }
        : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  reorderPlaylist(playlistId, songIds) {
    if (!isRoomOwner(get())) return;
    const playlists = get().playlists.map((p) =>
      p.id === playlistId ? { ...p, songIds: [...songIds] } : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  createPlaylist(name) {
    if (!isRoomOwner(get())) return "";
    const id = Math.random().toString(36).slice(2, 10);
    const p: Playlist = { id, name, songIds: [], createdAt: Date.now() };
    const playlists = [...get().playlists, p];
    set({ playlists, activePlaylistId: id });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
    return id;
  },

  renamePlaylist(id, name) {
    if (!isRoomOwner(get())) return;
    const playlists = get().playlists.map((p) =>
      p.id === id ? { ...p, name } : p,
    );
    set({ playlists });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  deletePlaylist(id) {
    if (!isRoomOwner(get())) return;
    const playlists = get().playlists.filter((p) => p.id !== id);
    const prev = get();
    const stillValidActive = prev.activePlaylistId === id ? null : prev.activePlaylistId;
    set({
      playlists,
      activePlaylistId: resolveActivePlaylistId(playlists, stillValidActive, prev.tab),
    });
    saveJSON("playlists", playlists);
    get().sync?.publishPlaylists(playlists).catch(console.error);
  },

  setActivePlaylist(id) {
    set({ activePlaylistId: id });
  },

  toggleInvertImages() {
    const next = !get().invertImages;
    set({ invertImages: next });
    saveLocal("invertImages", next);
  },
}));

export const useIsRoomOwner = (): boolean =>
  useApp((s) => isRoomOwner(s));
