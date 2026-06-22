import { useMemo } from "react";
import { create } from "zustand";
import type { Playlist, PlaylistTombstones, RoomState, Song, Tab } from "./types";
import { loadJSON, loadLocal, saveJSON, saveLocal } from "./lib/persist";
import { buildSearchIndex } from "./lib/search";
import { decodeSongs } from "./lib/songsCodec";
import { imageUrl } from "./lib/imageUrl";

/**
 * Kick off an image fetch the instant the user picks a song — *before*
 * Fullscreen even mounts. The browser then has the bytes in its
 * in-memory image cache by the time React renders the `<img>`, so the
 * `<img>` element resolves synchronously (img.complete = true on first
 * paint) and Fullscreen's useLayoutEffect can flip `loaded` true with
 * zero white-flash. Also primes the SW's chord-images Cache, so the
 * next open of the same song is offline-ready.
 *
 * `new Image()` is the canonical lightweight prefetch: it does NOT block
 * the main thread, fires onload/onerror like a normal img, and shares
 * the browser's normal image cache with the eventual `<img>` render.
 */
function preloadSongImage(song: Song): void {
  if (typeof Image === "undefined") return;
  const img = new Image();
  // Same crossOrigin as Fullscreen's <img> — without this the prefetched
  // response is an opaque "no-cors" entry that the real CORS <img> can't
  // share, costing us a second network round-trip.
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = imageUrl(song);
}
// Firebase + cloudSync are heavy (~300 KB of the Firebase SDK). We import
// them dynamically so they end up in their own chunk and load in parallel
// with songs.bin — the search UI never blocks on them.
import type { RoomSync } from "./lib/firebase";
import type { AuthUser } from "./lib/auth";
type FbMod = typeof import("./lib/firebase");
type CsMod = typeof import("./lib/cloudSync");
type AuthMod = typeof import("./lib/auth");

let fbMod: FbMod | null = null;
let csMod: CsMod | null = null;
let authMod: AuthMod | null = null;
let firebaseLoading: Promise<void> | null = null;

// init() runs from App's mount effect. React StrictMode (dev) and HMR can
// fire that effect more than once; without this guard a second init() would
// stack a duplicate popstate listener and a second auth subscription that
// races the first over cloudSync's single active sync.
let storeInitialized = false;

function loadFirebase(): Promise<void> {
  if (!firebaseLoading) {
    firebaseLoading = Promise.all([
      import("./lib/firebase"),
      import("./lib/cloudSync"),
      import("./lib/auth"),
    ])
      .then(([fb, cs, auth]) => {
        fbMod = fb;
        csMod = cs;
        authMod = auth;
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

// How long a delete-tombstone is honored before we forget it. Long enough that
// any device that was offline at delete time will have synced back by then;
// after that the tombstone is pruned so the doc doesn't grow without bound.
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

function randomRoom() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function randomClientId() {
  return Math.random().toString(36).slice(2, 10);
}

// URL shape: `/<room>` or `/<room>/<songId>`. Anything else is treated as no
// room/song info on the URL.
const URL_PATH_RE = /^\/(\d{6})(?:\/(\d+))?$/;

function parseUrlPath(
  pathname: string,
): { roomCode: string; songId: number | null } | null {
  const m = pathname.match(URL_PATH_RE);
  if (!m) return null;
  return { roomCode: m[1], songId: m[2] ? Number(m[2]) : null };
}

// Public SEO landing path: `/song/<id>[/<slug>]`. These are the crawlable pages
// rendered at the edge (functions/song/[[path]].js). The slug is decorative —
// only the numeric id resolves the song. Distinct from room URLs (rooms are
// strictly 6 digits, so the `/song/` prefix can never collide). Returns the
// song id so init() can deep-link into the EXISTING fullscreen view, exactly
// like a `/<room>/<songId>` link does — the in-app UI is unchanged.
const SONG_LANDING_RE = /^\/song\/(\d+)(?:\/|$)/;
function parseSongLandingPath(pathname: string): number | null {
  const m = pathname.match(SONG_LANDING_RE);
  return m ? Number(m[1]) : null;
}

function urlPathFor(roomCode: string, songId: number | null): string {
  return songId !== null ? `/${roomCode}/${songId}` : `/${roomCode}`;
}

// pushState only if the path actually changed — avoids spamming the history
// stack with duplicate entries when callers eagerly call this on every state
// change.
function pushUrl(roomCode: string, songId: number | null) {
  const next = urlPathFor(roomCode, songId);
  if (window.location.pathname !== next) {
    history.pushState(null, "", next);
  }
}

// Firebase RTDB drops empty arrays and arrays-with-holes, so playlists read
// back from the wire may be missing `songIds` entirely or arrive as a sparse
// object. Normalize to a well-formed array.
function normalizePlaylists(raw: unknown): Playlist[] {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw as object);
  return arr
    .filter((p): p is Partial<Playlist> => p != null && typeof p === "object")
    .map((p) => {
      const createdAt = typeof p.createdAt === "number" ? p.createdAt : Date.now();
      return {
        id: String(p.id ?? Math.random().toString(36).slice(2, 10)),
        name: String(p.name ?? "Untitled"),
        songIds: Array.isArray(p.songIds)
          ? p.songIds.filter((x) => typeof x === "number")
          : [],
        createdAt,
        // Legacy rows (pre-updatedAt) fall back to createdAt so they still
        // participate sanely in last-write-wins instead of defaulting to 0.
        updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : createdAt,
      };
    });
}

// Coerce arbitrary wire data into a clean { id → deletedAt } map.
function sanitizeTombstones(raw: unknown): PlaylistTombstones {
  if (raw == null || typeof raw !== "object") return {};
  const out: PlaylistTombstones = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Deterministic, order-stable merge of two playlist sets (local ↔ cloud).
 * The unit of merge is a single playlist id, NOT the whole array — so a
 * create on one device and a create on another both survive.
 *
 *   - tombstones: union, keeping the latest deletedAt per id.
 *   - live playlists: per id, keep the copy with the newest `updatedAt`.
 *   - a tombstone newer-or-equal to its live copy wins → playlist stays
 *     deleted; a live copy edited AFTER its tombstone resurrects it (and the
 *     stale tombstone is dropped).
 *   - order: local order first, then any cloud-only ids appended — keeps the
 *     user's current device arrangement stable across merges.
 *   - tombstones older than TTL are pruned so the doc stays bounded.
 *
 * Idempotent and convergent: merge(x, x) == x, so re-running it (e.g. when the
 * server echoes our own write back) produces no further changes.
 */
function mergePlaylistData(
  localLive: Playlist[],
  localTombs: PlaylistTombstones,
  remoteLive: Playlist[],
  remoteTombs: PlaylistTombstones,
): { playlists: Playlist[]; tombstones: PlaylistTombstones } {
  const tombs: PlaylistTombstones = { ...localTombs };
  for (const [id, t] of Object.entries(remoteTombs)) {
    tombs[id] = Math.max(tombs[id] ?? 0, t);
  }

  const newest = new Map<string, Playlist>();
  const order: string[] = [];
  for (const p of [...localLive, ...remoteLive]) {
    const cur = newest.get(p.id);
    if (!cur) order.push(p.id);
    if (!cur || p.updatedAt > cur.updatedAt) newest.set(p.id, p);
  }

  const playlists: Playlist[] = [];
  for (const id of order) {
    const p = newest.get(id)!;
    const deletedAt = tombs[id];
    if (deletedAt != null && deletedAt >= p.updatedAt) continue; // stays deleted
    if (deletedAt != null) delete tombs[id]; // edit newer than delete → resurrected
    playlists.push(p);
  }

  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const [id, t] of Object.entries(tombs)) if (t < cutoff) delete tombs[id];

  return { playlists, tombstones: tombs };
}

// Stable fingerprint of a playlist set, used to decide whether a freshly
// merged local set carries anything the server doesn't have yet (→ push back).
function playlistFingerprint(
  live: Playlist[],
  tombs: PlaylistTombstones,
): string {
  const l = [...live]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}:${p.updatedAt}:${p.name}:${p.songIds.join(",")}`)
    .join("|");
  const t = Object.entries(tombs)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, ts]) => `${id}:${ts}`)
    .join("|");
  return `${l}##${t}`;
}

/**
 * Merge "what's on this device right now" with "what's already on the server
 * for this account" — runs once per sign-in to bring both sides in sync.
 *
 * Rules:
 *   - favorites: union (a song favorited on either device stays favorited)
 *   - latest: local-first dedup, capped at LATEST_CAP — the device the user
 *     is actively on is the most authoritative source for recency
 *   - playlists: per-id last-write-wins with delete-tombstones (see
 *     mergePlaylistData) — a create survives, a delete propagates, neither
 *     device clobbers the other.
 *   - roomCode: local wins (user just opened this device, so this is where
 *     they want to be — don't yank them to whatever room another device
 *     happens to be in)
 */
function mergeUserData(
  local: import("./lib/cloudSync").UserData,
  remote: import("./lib/cloudSync").UserData,
): import("./lib/cloudSync").UserData {
  const favs = new Set(local.favorites);
  for (const f of remote.favorites ?? []) favs.add(f);

  const seen = new Set<number>();
  const latest: number[] = [];
  for (const id of local.latest ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      latest.push(id);
    }
  }
  for (const id of remote.latest ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      latest.push(id);
    }
  }
  if (latest.length > LATEST_CAP) latest.length = LATEST_CAP;

  const { playlists, tombstones } = mergePlaylistData(
    local.playlists ?? [],
    sanitizeTombstones(local.playlistTombstones),
    remote.playlists ?? [],
    sanitizeTombstones(remote.playlistTombstones),
  );

  return {
    favorites: [...favs],
    latest,
    playlists,
    playlistTombstones: tombstones,
    roomCode: local.roomCode || remote.roomCode,
  };
}

function isRoomOwner(s: Pick<State, "clientId" | "roomOwnerClientId">): boolean {
  return Boolean(s.clientId) && s.roomOwnerClientId === s.clientId;
}

/**
 * Single tagged entry for the merged playlist view. `ownerClientId` lets
 * the UI grant edit rights to entries the local user owns and show the
 * `read-only` badge on everyone else's; `displayName` is the original
 * name with `1/2/3…` suffix appended when multiple clients picked the
 * same playlist title.
 */
export interface MergedPlaylist {
  playlist: Playlist;
  ownerClientId: string;
  displayName: string;
  isMine: boolean;
}

/**
 * Merge `playlists` (the local user's) with `othersPlaylists` (every
 * other member of the current room) into a single ordered list. Order:
 *   1. The room owner's playlists first (whether that's me or a guest),
 *   2. then everyone else, alphabetical by clientId for a deterministic
 *      sort that doesn't shuffle as edits land.
 * Duplicate names get `(2)`, `(3)`… suffixes in display order so the UI
 * never shows two identical-looking pills.
 */
function mergePlaylistsFromState(state: {
  playlists: Playlist[];
  othersPlaylists: Record<string, Playlist[]>;
  clientId: string;
  roomOwnerClientId: string | null;
}): MergedPlaylist[] {
  const myId = state.clientId;
  const ownerId = state.roomOwnerClientId;
  // Group by clientId, then sort clientIds so the room owner comes first.
  const buckets: Array<[string, Playlist[]]> = [];
  buckets.push([myId, state.playlists]);
  for (const cid of Object.keys(state.othersPlaylists).sort()) {
    buckets.push([cid, state.othersPlaylists[cid] ?? []]);
  }
  buckets.sort((a, b) => {
    if (a[0] === ownerId) return -1;
    if (b[0] === ownerId) return 1;
    // Within non-owners, keep "mine" right after the owner so my entries
    // are easy to find — but only if I'm not the owner (else I'm already
    // first by the rule above).
    if (a[0] === myId) return -1;
    if (b[0] === myId) return 1;
    return a[0].localeCompare(b[0]);
  });

  const flat: MergedPlaylist[] = [];
  for (const [cid, pls] of buckets) {
    for (const p of pls) {
      flat.push({
        playlist: p,
        ownerClientId: cid,
        displayName: p.name,
        isMine: cid === myId,
      });
    }
  }
  // Dedupe display names with (2), (3)… suffixes in encounter order.
  const counts = new Map<string, number>();
  for (const item of flat) {
    const n = (counts.get(item.playlist.name) ?? 0) + 1;
    counts.set(item.playlist.name, n);
    if (n > 1) item.displayName = `${item.playlist.name} (${n})`;
  }
  return flat;
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
  autoOpen: boolean; // auto-open fullscreen when a bandmate picks a song

  // identity / room
  clientId: string;
  roomCode: string;
  room: RoomState | null;
  roomOwnerClientId: string | null;
  unsubscribeRoom: (() => void) | null;
  unsubscribeRoomPlaylists: (() => void) | null;
  unsubscribeRoomOwner: (() => void) | null;
  sync: RoomSync | null;

  // auth
  user: AuthUser | null;     // null = anonymous (clientId mode)
  authReady: boolean;        // true after the first onAuthStateChanged fires

  // persisted collections
  favorites: Set<number>;
  latest: number[]; // most recent first
  playlists: Playlist[];
  // Delete-tombstones for playlists (id → deletedAt). Persisted alongside
  // `playlists` and synced to the cloud doc when signed in so a delete made
  // on one device doesn't get undone by a stale copy on another. Live-only
  // playlists are what the UI renders; this never reaches the room layer.
  playlistTombstones: PlaylistTombstones;
  // Playlists belonging to OTHER clients in the same room, keyed by their
  // clientId. Ephemeral — populated by the room subscription, wiped when
  // we leave / switch rooms. We don't persist this; on rejoin everyone
  // republishes from their own local copy.
  othersPlaylists: Record<string, Playlist[]>;

  // actions
  init: () => Promise<void>;
  setQuery: (q: string) => void;
  setTab: (t: Tab) => void;
  setRoomCode: (code: string, pushToCloud?: boolean) => void;
  randomizeRoom: () => void;
  open: (song: Song, broadcast?: boolean, recordLatest?: boolean) => void;
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
  toggleAutoOpen: () => void;
  // Auth-aware. Signing in switches the cloud-sync source from
  // clients/{clientId} to users/{uid} and runs a one-time merge so the
  // user's local state and any prior remote state combine correctly.
  signOutLocal: () => Promise<void>;
}

export const useApp = create<State>((set, get) => {
  // Push our own playlists up to the current room. Called after every
  // local mutation so other members see edits in real time. No-ops outside
  // of a room.
  function publishOwnPlaylists(playlists: Playlist[]) {
    const { sync, clientId } = get();
    if (!sync || !clientId) return;
    sync.publishMyPlaylists(clientId, playlists).catch(console.error);
  }

  // Persist + broadcast a new playlists array in one shot. Every mutation
  // (add/remove/reorder/create/rename/delete) ends with the same steps,
  // so we centralize them here. Pass `tombstones` only when the delete-set
  // changed (i.e. deletePlaylist) — other mutations leave it untouched.
  function commitPlaylists(playlists: Playlist[], tombstones?: PlaylistTombstones) {
    set(tombstones ? { playlists, playlistTombstones: tombstones } : { playlists });
    saveJSON("playlists", playlists);
    if (tombstones) saveJSON("playlistTombstones", tombstones);
    // The room layer only ever sees live playlists — tombstones are an
    // account-sync concern, not a room concern.
    publishOwnPlaylists(playlists);
    // Push to cloud only when signed in — anon clients/{clientId} docs
    // intentionally don't carry playlists (they're local + room-scoped only
    // for anonymous users, as requested).
    if (get().user) {
      csMod?.pushUpdate(
        tombstones ? { playlists, playlistTombstones: tombstones } : { playlists },
      );
    }
  }

  return {
  songs: [],
  songIndex: [],
  byId: new Map(),
  loaded: false,

  query: "",
  tab: "all",
  viewing: null,
  activePlaylistId: null,
  invertImages: false,
  autoOpen: true,

  clientId: "",
  roomCode: "",
  room: null,
  roomOwnerClientId: null,
  unsubscribeRoom: null,
  unsubscribeRoomPlaylists: null,
  unsubscribeRoomOwner: null,
  sync: null,

  user: null,
  authReady: false,

  favorites: new Set(),
  latest: [],
  playlists: [],
  playlistTombstones: {},
  othersPlaylists: {},

  async init() {
    if (storeInitialized) return;
    storeInitialized = true;
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
    // URL shape: /<room>            → just the room
    //            /<room>/<songId>   → room + open this song in fullscreen
    // (anything else falls through to localStorage / random)
    const urlParsed = parseUrlPath(window.location.pathname);
    // A `/song/<id>` landing (from Google / a shared SEO link) deep-links into
    // the same fullscreen view as a `/<room>/<songId>` link. The room stays
    // whatever's local/random; the URL-normalize below then rewrites the address
    // bar to `/<room>/<id>` with the song open, reusing the urlSongId path.
    const urlSongId = urlParsed?.songId ?? parseSongLandingPath(window.location.pathname);
    // urlForcedRoom: the user landed on this device via a shared link, so
    // their URL choice MUST beat whatever stale roomCode is sitting in this
    // client's Firestore doc from a previous session. Without this, the
    // first cloud-sync snapshot would call setRoomCode(remote) and bounce
    // the URL back to the old room.
    const urlForcedRoom = urlParsed !== null;
    if (urlParsed) {
      roomCode = urlParsed.roomCode;
      saveLocal("roomCode", roomCode);
    } else {
      roomCode = loadLocal<string>("roomCode", "");
      if (!/^\d{6}$/.test(roomCode)) {
        roomCode = randomRoom();
        saveLocal("roomCode", roomCode);
      }
    }
    // Normalize URL so the address bar matches state — keep songId when
    // present, otherwise just the room.
    const initialPath = urlPathFor(roomCode, urlSongId);
    if (window.location.pathname !== initialPath) {
      history.replaceState(null, "", initialPath);
    }
    // Back/forward navigation. Path can change in two dimensions (room
    // changes, song open/close), so reconcile both against current state.
    window.addEventListener("popstate", () => {
      const parsed = parseUrlPath(window.location.pathname);
      // Back/forward can also land on a public `/song/<id>` URL.
      const landingSongId = parsed ? null : parseSongLandingPath(window.location.pathname);
      if (!parsed && landingSongId === null) return;
      if (parsed && parsed.roomCode !== get().roomCode) get().setRoomCode(parsed.roomCode);
      const songId = parsed ? parsed.songId : landingSongId;
      const cur = get().viewing;
      if (songId === null && cur) {
        set({ viewing: null });
      } else if (songId !== null && (!cur || cur.id !== songId)) {
        const song = get().byId.get(songId);
        if (song) {
          preloadSongImage(song);
          set({ viewing: song });
        }
      }
    });
    const invertImages = loadLocal<boolean>("invertImages", false);
    const autoOpen = loadLocal<boolean>("autoOpen", true);
    // Push identity + room into the store BEFORE any await so the shell's
    // first render shows the right room code (instead of the empty default
    // for a few frames). Cheap — these are all synchronous reads.
    set({ clientId, roomCode, invertImages, autoOpen });

    // Kick off heavy work in parallel: the songs dataset and the locally-
    // persisted collections. The shell renders as soon as the local state
    // lands; songs fill in independently. Firebase is deferred — see below.
    const songsPromise = fetch("/songs.bin")
      .then((r) => r.arrayBuffer())
      .then(decodeSongs);
    const [favArr, latestRaw, playlistsRaw, tombsRaw] = await Promise.all([
      loadJSON<number[]>("favorites", []),
      loadJSON<number[]>("latest", []),
      loadJSON<unknown>("playlists", []),
      loadJSON<unknown>("playlistTombstones", {}),
    ]);
    const latest = latestRaw.slice(0, LATEST_CAP);
    // Run local playlists through the normalizer too, so rows persisted by an
    // older build (no `updatedAt`) get backfilled before any merge runs.
    const playlists = normalizePlaylists(playlistsRaw);
    const playlistTombstones = sanitizeTombstones(tombsRaw);

    set({
      favorites: new Set(favArr),
      latest,
      playlists,
      playlistTombstones,
    });

    // Start loading the Firebase chunk (~425 KB) now — late enough that it
    // doesn't contend with songs.bin for the very first network slot, but
    // early enough that it's usually ready by the time songs decode. We
    // await it AFTER songs land so the UI never blocks on room sync.
    const firebasePromise = loadFirebase();

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

    // If the URL pointed at a specific song, open the fullscreen view now
    // that we have the dataset. Local-only — don't re-broadcast to the room
    // (the room owner already broadcast it; we're just deep-linking in).
    if (urlSongId !== null) {
      const song = byId.get(urlSongId);
      if (song) {
        preloadSongImage(song);
        set({ viewing: song });
      }
    }

    // Wait for the Firebase chunk before wiring up room sync / cloud sync.
    // The UI is already usable at this point — these add multi-device features.
    await firebasePromise;

    // Room subscribe with the locally-known code (don't push to cloud yet —
    // we'll let cloud sync below decide whether to override).
    get().setRoomCode(roomCode, false);

    // ── Cloud sync (auth-aware) ────────────────────────────────────────────
    // Source of cloud sync is decided by current auth state:
    //   - signed out → clients/{clientId}  (same as pre-auth behavior)
    //   - signed in  → users/{uid}         (carries playlists too)
    //
    // The first remote snapshot may carry a stale roomCode from a prior
    // session of this identity. If the URL just told us which room to be in,
    // that wins — we push the URL room up to cloud instead of adopting the
    // stale value. The flag is one-shot and applies only to the very first
    // snapshot received across all source switches in this app session.
    let pendingUrlPush = urlForcedRoom;
    let unsubCloud: (() => void) | null = null;
    const migratedUids = new Set<string>();

    const startSyncWith = async (
      source: import("./lib/cloudSync").SyncSource,
    ) => {
      if (!csMod) return;
      // Re-arm the URL-wins guard for THIS source's first snapshot. Without
      // it, whichever source emits first (often the anonymous client source
      // during a cold sign-in, before auth restores) consumes the one-shot
      // flag, and the later user-source snapshot then adopts a stale roomCode
      // — yanking a freshly shared-link guest out of the room they just
      // opened. Re-arming per source keeps "URL wins" true across the
      // sign-out→sign-in source switch.
      pendingUrlPush = urlForcedRoom;
      // Tear down old subscription before installing a new one. cloudSync's
      // teardown flushes any pending writes, so we don't lose a debounced
      // update that hadn't fired yet.
      if (unsubCloud) {
        unsubCloud();
        unsubCloud = null;
      }

      // First sign-in on a given uid in this session: merge local+remote
      // BEFORE wiring the subscription. We can't let onSnapshot's first
      // emit clobber local edits the user made before logging in — read
      // once, merge, push the merged blob, then subscribe.
      if (source.kind === "user" && !migratedUids.has(source.uid)) {
        migratedUids.add(source.uid);
        try {
          const remote = await csMod.readRemoteOnce(source);
          const localBlob: import("./lib/cloudSync").UserData = {
            favorites: [...get().favorites],
            latest: get().latest,
            playlists: get().playlists,
            playlistTombstones: get().playlistTombstones,
            roomCode: get().roomCode,
          };
          if (remote == null) {
            // Fresh account — just push local up.
            await csMod.writeRemote(source, localBlob);
          } else {
            const merged = mergeUserData(localBlob, remote);
            const mergedPlaylists = merged.playlists ?? [];
            const mergedTombs = merged.playlistTombstones ?? {};
            set({
              favorites: new Set(merged.favorites),
              latest: merged.latest,
              playlists: mergedPlaylists,
              playlistTombstones: mergedTombs,
            });
            saveJSON("favorites", merged.favorites);
            saveJSON("latest", merged.latest);
            saveJSON("playlists", mergedPlaylists);
            saveJSON("playlistTombstones", mergedTombs);
            // Re-publish into the current room so other members see the
            // post-merge playlists, not the stale pre-merge ones.
            const { sync: roomSync, clientId: myCid } = get();
            if (roomSync && myCid) {
              roomSync
                .publishMyPlaylists(myCid, mergedPlaylists)
                .catch(console.error);
            }
            await csMod.writeRemote(source, merged);
          }
        } catch (err) {
          console.error("[store] sign-in migration failed:", err);
        }
      }

      // Snapshot of local state to seed the subscription's "no remote doc
      // exists" branch. After migration above, this matches what's on the
      // server anyway.
      const initial: import("./lib/cloudSync").UserData = {
        favorites: [...get().favorites],
        latest: get().latest,
        roomCode: get().roomCode,
        ...(source.kind === "user"
          ? {
              playlists: get().playlists,
              playlistTombstones: get().playlistTombstones,
            }
          : {}),
      };

      unsubCloud = csMod.startCloudSync(source, initial, (remote) => {
        const remoteLatest = (remote.latest ?? []).slice(0, LATEST_CAP);
        set({
          favorites: new Set(remote.favorites ?? []),
          latest: remoteLatest,
        });
        saveJSON("favorites", remote.favorites ?? []);
        saveJSON("latest", remoteLatest);

        // Playlists only sync for a user source — anon `clients/{clientId}`
        // docs don't carry them. Crucially we MERGE remote into local per-id
        // (not overwrite): a create on another device, a delete that should
        // stick, and a fresh local edit all survive. If the merge surfaces
        // anything the server doesn't have yet, push the converged set back
        // so every device ends up identical.
        if (source.kind === "user") {
          const remoteLive = normalizePlaylists(remote.playlists);
          const remoteTombs = sanitizeTombstones(remote.playlistTombstones);
          const { playlists: mergedLive, tombstones: mergedTombs } =
            mergePlaylistData(
              get().playlists,
              get().playlistTombstones,
              remoteLive,
              remoteTombs,
            );
          set({ playlists: mergedLive, playlistTombstones: mergedTombs });
          saveJSON("playlists", mergedLive);
          saveJSON("playlistTombstones", mergedTombs);
          // Re-publish my (live) playlists into the room so guests see
          // remote-driven edits made on the user's other device.
          const { sync: roomSync, clientId: myCid } = get();
          if (roomSync && myCid) {
            roomSync.publishMyPlaylists(myCid, mergedLive).catch(console.error);
          }
          // Converge the server toward the union. Guarded by a fingerprint so
          // an echo of our own write (merge == remote) writes nothing —
          // mergePlaylistData is idempotent, so this settles in one round.
          if (
            playlistFingerprint(mergedLive, mergedTombs) !==
            playlistFingerprint(remoteLive, remoteTombs)
          ) {
            csMod?.pushUpdate({
              playlists: mergedLive,
              playlistTombstones: mergedTombs,
            });
          }
        }
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
      });
    };

    // Subscribe to auth state. First emit (which Firebase delivers
    // synchronously from cached state) decides the initial source.
    if (authMod) {
      authMod.subscribeAuth((authUser) => {
        const prev = get().user;
        set({ user: authUser, authReady: true });
        const samePrincipal =
          (prev?.uid ?? null) === (authUser?.uid ?? null);
        // Skip work if the principal didn't actually change. subscribeAuth
        // can fire on profile updates (display name, photo) which are not
        // identity changes — don't tear down sync for those.
        if (samePrincipal && unsubCloud) return;
        const source: import("./lib/cloudSync").SyncSource = authUser
          ? { kind: "user", uid: authUser.uid }
          : { kind: "client", clientId };
        startSyncWith(source).catch((err) =>
          console.error("[store] startSyncWith failed:", err),
        );
      });
    } else {
      // Auth chunk failed to load — fall back to anonymous client sync.
      set({ authReady: true });
      startSyncWith({ kind: "client", clientId }).catch(console.error);
    }
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

    // Tear down old room. We release ownership AND clear our per-client
    // playlist key so the previous room doesn't keep our data hanging
    // around. (onDisconnect handles closed-tab cleanup separately.)
    const oldUnsubRoom = get().unsubscribeRoom;
    const oldUnsubPL = get().unsubscribeRoomPlaylists;
    const oldUnsubOwner = get().unsubscribeRoomOwner;
    const oldSync = get().sync;
    const oldOwnerId = get().roomOwnerClientId;
    const myClientId = get().clientId;
    if (oldSync && oldOwnerId && oldOwnerId === myClientId) {
      oldSync.releaseOwner(myClientId).catch(console.error);
    }
    if (oldSync && myClientId) {
      oldSync.removeMyPlaylists(myClientId).catch(console.error);
    }
    if (oldUnsubRoom) oldUnsubRoom();
    if (oldUnsubPL) oldUnsubPL();
    if (oldUnsubOwner) oldUnsubOwner();

    const sync = fbMod.getRoomSync(code);
    const unsub = sync.subscribe((state) => set({ room: state }));

    // Subscribe to ownership. We claim whenever the room is unowned (both
    // on first snapshot and whenever the current owner disconnects).
    // claimOwner uses an RTDB transaction so racing guests resolve to a
    // single winner.
    const unsubOwner = sync.subscribeOwner((owner) => {
      const nextOwnerId = owner?.clientId ?? null;
      set({ roomOwnerClientId: nextOwnerId });
      if (!nextOwnerId) {
        sync.claimOwner(myClientId).catch(console.error);
      }
    });

    // Subscribe to the room's playlists map (`{ clientId → Playlist[] }`).
    // Split mine vs others — we never overwrite our own state from the
    // wire, only update `othersPlaylists`. Local edits are the source of
    // truth for our entry; we push that up explicitly on every mutation.
    const unsubPL = sync.subscribePlaylists((byClient) => {
      const map = byClient ?? {};
      const others: Record<string, Playlist[]> = {};
      for (const [cid, pls] of Object.entries(map)) {
        if (cid === myClientId) continue;
        others[cid] = normalizePlaylists(pls);
      }
      set((prev) => {
        // After the room's playlist map changes (someone joined, left, or
        // edited), recompute the active selection so it still points at a
        // valid entry within the new merged view.
        const merged = mergePlaylistsFromState({
          playlists: prev.playlists,
          othersPlaylists: others,
          clientId: myClientId,
          roomOwnerClientId: prev.roomOwnerClientId,
        });
        return {
          othersPlaylists: others,
          activePlaylistId: resolveActivePlaylistId(
            merged.map((m) => m.playlist),
            prev.activePlaylistId,
            prev.tab,
          ),
        };
      });
    });

    // Push our own playlists into the new room immediately so other
    // members see them without needing us to make an edit first.
    if (myClientId) {
      sync
        .publishMyPlaylists(myClientId, get().playlists)
        .catch(console.error);
    }

    saveLocal("roomCode", code);
    // Keep the URL in sync so the address bar is always shareable. Preserve
    // the currently-open song (if any) so swapping rooms while in fullscreen
    // doesn't drop the songId from the path. pushState (not replace) lets
    // back/forward walk through prior rooms.
    pushUrl(code, get().viewing?.id ?? null);
    if (pushToCloud) csMod?.pushUpdate({ roomCode: code });
    set({
      roomCode: code,
      sync,
      unsubscribeRoom: unsub,
      unsubscribeRoomPlaylists: unsubPL,
      unsubscribeRoomOwner: unsubOwner,
      room: null,
      roomOwnerClientId: null,
      // Stale members from the previous room don't apply here.
      othersPlaylists: {},
    });
  },

  randomizeRoom() {
    get().setRoomCode(randomRoom());
  },

  open(song, broadcast = true, recordLatest = true) {
    // Prefetch the chord-sheet image BEFORE flipping `viewing`. Fullscreen
    // mounts on the next React tick; in the gap the browser has already
    // started (and often finished) the SW/cache lookup, so when the
    // `<img>` actually renders it resolves synchronously and the user
    // never sees the blank-white moment that used to bridge "I tapped a
    // song" and "image appears".
    preloadSongImage(song);
    set({ viewing: song });
    // Clear the search input on user-initiated opens so closing fullscreen
    // returns to a fresh list. Auto-open from a remote pick keeps the
    // local search context intact.
    if (broadcast && get().query) set({ query: "" });
    // push to "latest" (dedup, newest first, FIFO max 30 so the per-user
    // Firestore doc stays bounded). Skipped for passive auto-opens (a
    // bandmate's remote pick reflected by useRoomSongAlert) so the band's
    // picks don't flood THIS user's recently-opened history and cloud doc —
    // only songs the user actually chose to open (a list tap, or tapping the
    // NowPlaying banner) are recorded.
    if (recordLatest) {
      const cur = get().latest.filter((id) => id !== song.id);
      cur.unshift(song.id);
      if (cur.length > LATEST_CAP) cur.length = LATEST_CAP;
      set({ latest: cur });
      saveJSON("latest", cur);
      csMod?.pushUpdate({ latest: cur });
    }
    // Reflect the open song in the URL so deep-links / refresh / shared
    // notifications all land back on this exact view.
    pushUrl(get().roomCode, song.id);
    // broadcast to room — `pickerViewing: true` signals to receivers that
    // the picker is currently in fullscreen, so their auto-open should
    // fire (and stay open until the picker explicitly closes).
    if (broadcast) {
      const sync = get().sync;
      const clientId = get().clientId;
      sync?.publish({
        songId: song.id,
        songName: song.name,
        pickedBy: clientId,
        pickedAt: Date.now(),
        pickerViewing: true,
      });
    }
  },

  close() {
    const prevViewing = get().viewing;
    set({ viewing: null });
    // Strip the songId segment back off the URL when fullscreen closes.
    pushUrl(get().roomCode, null);
    // Only the room's picker broadcasts a close. Receivers closing locally
    // is a private action — it shouldn't drag the picker (or other
    // receivers) out of fullscreen. We also gate on "I'm closing the song
    // the room is on" so closing a stale local view (after the picker
    // already moved on) doesn't fire a misleading broadcast.
    const room = get().room;
    const myClientId = get().clientId;
    const sync = get().sync;
    if (
      sync &&
      room &&
      room.songId !== null &&
      room.pickedBy === myClientId &&
      room.pickerViewing !== false &&
      prevViewing &&
      prevViewing.id === room.songId
    ) {
      sync
        .publish({ ...room, pickerViewing: false })
        .catch((err) => console.error("close broadcast failed:", err));
    }
  },

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
    // Each member edits only their OWN playlists. If `playlistId` isn't in
    // our local list it belongs to another member and is read-only here.
    if (!get().playlists.some((p) => p.id === playlistId)) return;
    const now = Date.now();
    commitPlaylists(
      get().playlists.map((p) =>
        p.id === playlistId && !p.songIds.includes(id)
          ? { ...p, songIds: [...p.songIds, id], updatedAt: now }
          : p,
      ),
    );
  },

  removeFromPlaylist(playlistId, id) {
    if (!get().playlists.some((p) => p.id === playlistId)) return;
    const now = Date.now();
    commitPlaylists(
      get().playlists.map((p) =>
        p.id === playlistId
          ? { ...p, songIds: p.songIds.filter((x) => x !== id), updatedAt: now }
          : p,
      ),
    );
  },

  reorderPlaylist(playlistId, songIds) {
    if (!get().playlists.some((p) => p.id === playlistId)) return;
    const now = Date.now();
    commitPlaylists(
      get().playlists.map((p) =>
        p.id === playlistId ? { ...p, songIds: [...songIds], updatedAt: now } : p,
      ),
    );
  },

  createPlaylist(name) {
    // Anyone in the room can create a playlist — it becomes theirs.
    const id = Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    const p: Playlist = { id, name, songIds: [], createdAt: now, updatedAt: now };
    commitPlaylists([...get().playlists, p]);
    set({ activePlaylistId: id });
    return id;
  },

  renamePlaylist(id, name) {
    if (!get().playlists.some((p) => p.id === id)) return;
    const now = Date.now();
    commitPlaylists(
      get().playlists.map((p) =>
        p.id === id ? { ...p, name, updatedAt: now } : p,
      ),
    );
  },

  deletePlaylist(id) {
    if (!get().playlists.some((p) => p.id === id)) return;
    const prev = get();
    const playlists = prev.playlists.filter((p) => p.id !== id);
    // Record a tombstone so the delete sticks across devices / re-login
    // instead of a stale copy resurrecting it on the next merge.
    const tombstones = { ...prev.playlistTombstones, [id]: Date.now() };
    const stillValidActive =
      prev.activePlaylistId === id ? null : prev.activePlaylistId;
    commitPlaylists(playlists, tombstones);
    set({
      activePlaylistId: resolveActivePlaylistId(playlists, stillValidActive, prev.tab),
    });
  },

  setActivePlaylist(id) {
    set({ activePlaylistId: id });
  },

  toggleAutoOpen() {
    const next = !get().autoOpen;
    set({ autoOpen: next });
    saveLocal("autoOpen", next);
  },

  toggleInvertImages() {
    const next = !get().invertImages;
    set({ invertImages: next });
    saveLocal("invertImages", next);
  },

  async signOutLocal() {
    if (!authMod) return;
    try {
      // After this resolves Firebase fires onAuthStateChanged(null), which
      // our subscribeAuth handler picks up and switches cloud sync back to
      // clients/{clientId}. Local state (favorites/latest/playlists/etc.)
      // stays as-is on this device — signing out doesn't wipe data.
      await authMod.signOutNow();
    } catch (err) {
      console.error("[auth] signOut failed:", err);
    }
  },
  };
});

export const useIsRoomOwner = (): boolean =>
  useApp((s) => isRoomOwner(s));

/**
 * Owner-first merged playlist view for UI consumption. Each entry carries
 * its `ownerClientId`, an `isMine` flag (so the UI knows whether to show
 * edit affordances), and a `displayName` with `(2)/(3)…` suffixes applied
 * to dedupe collisions across members.
 *
 * The selector intentionally allocates a new array each render — useMemo'd
 * inside this hook so it only recomputes when the underlying state slices
 * actually change.
 */
export function useMergedPlaylists(): MergedPlaylist[] {
  const playlists = useApp((s) => s.playlists);
  const othersPlaylists = useApp((s) => s.othersPlaylists);
  const clientId = useApp((s) => s.clientId);
  const roomOwnerClientId = useApp((s) => s.roomOwnerClientId);
  return useMemo(
    () =>
      mergePlaylistsFromState({
        playlists,
        othersPlaylists,
        clientId,
        roomOwnerClientId,
      }),
    [playlists, othersPlaylists, clientId, roomOwnerClientId],
  );
}
