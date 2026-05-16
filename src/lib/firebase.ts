// Firebase Realtime DB sync. Falls back to a local BroadcastChannel mock when
// VITE_FIREBASE_* env vars are not set — useful for local dev with no Firebase.
import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  onValue,
  set as rtdbSet,
  off,
  onDisconnect,
  remove,
  runTransaction,
  type Database,
  type OnDisconnect,
} from "firebase/database";
import {
  initializeFirestore,
  persistentLocalCache,
  doc,
  type Firestore,
  type DocumentReference,
} from "firebase/firestore";
import { initAuth } from "./auth";
import type { Playlist, RoomOwner, RoomState } from "../types";

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DB_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let db: Database | null = null;
let firestore: Firestore | null = null;
export const firebaseEnabled = Boolean(cfg.apiKey && cfg.databaseURL);

if (firebaseEnabled) {
  const app = initializeApp(cfg as Required<typeof cfg>);
  db = getDatabase(app);
  // persistentLocalCache lets Firestore reads work offline (from IndexedDB
  // backed cache) and queues writes while disconnected — pairs with the
  // app's broader "IndexedDB is source of truth, Firebase is sync" model.
  // Single-tab mode (default) is fine; we don't expect multi-tab use.
  try {
    firestore = initializeFirestore(app, {
      localCache: persistentLocalCache(),
    });
  } catch (err) {
    // initializeFirestore throws if a Firestore instance already exists
    // for this app — shouldn't happen given module-load ordering, but
    // bail gracefully if it does (Firestore stays null → cloudSync
    // becomes a no-op, app keeps working from local state).
    console.error("[firebase] initializeFirestore failed:", err);
    firestore = null;
  }
  // Initialize Auth lazily — initAuth() itself is idempotent and does the
  // minimum work (getAuth + getRedirectResult). Components that don't
  // touch auth never trigger the Auth SDK code path because we only
  // subscribe / call sign-in methods from inside auth-aware code.
  initAuth();
}

/**
 * Per-client Firestore doc. We DON'T use Firebase Anonymous Auth — that
 * created an orphan auth record every time someone cleared their browser
 * cache. Instead we key off `clientId`, an 8-char random string persisted in
 * localStorage (see store.ts). Trade-off: anyone who knows a clientId can
 * read/write that doc, so Firestore rules must allow open access to
 * `clients/{clientId}`. Acceptable for this band-internal tool — the data
 * is just favorites/latest, non-sensitive, and clientId is hard to guess.
 */
export function clientDocRef(clientId: string): DocumentReference | null {
  if (!firestore) return null;
  return doc(firestore, "clients", clientId);
}

/**
 * Per-user Firestore doc — used by cloud sync when the user is signed in.
 * Schema mirrors `clients/{clientId}` so the same sync code path can target
 * either source: `{ favorites, latest, roomCode, playlists?, updatedAt? }`.
 *
 * Rules guard this so only the signed-in owner of `uid` can read/write.
 */
export function userDocRef(uid: string): DocumentReference | null {
  if (!firestore) return null;
  return doc(firestore, "users", uid);
}

// ---- Room sync (Realtime DB) -----------------------------------------------

export interface RoomSync {
  // Current song selection
  publish(state: RoomState): Promise<void>;
  subscribe(cb: (state: RoomState | null) => void): () => void;
  // Playlists are per-client now: each member publishes their own list
  // under their clientId. Subscribers get a `{ clientId → Playlist[] }`
  // map so the UI can split "mine" from "everyone else's", show owner
  // attribution, and grant edit rights only on entries the local user
  // owns.
  publishMyPlaylists(clientId: string, playlists: Playlist[]): Promise<void>;
  removeMyPlaylists(clientId: string): Promise<void>;
  subscribePlaylists(
    cb: (byClient: Record<string, Playlist[]> | null) => void,
  ): () => void;
  // Ownership. The first user in a room atomically claims it; subsequent
  // joiners just observe. Owner must explicitly release on leaving.
  claimOwner(clientId: string): Promise<boolean>;
  releaseOwner(clientId: string): Promise<void>;
  subscribeOwner(cb: (owner: RoomOwner | null) => void): () => void;
}

function firebaseRoom(roomCode: string): RoomSync {
  const currentRef = ref(db!, `rooms/${roomCode}/current`);
  const playlistsRef = ref(db!, `rooms/${roomCode}/playlists`);
  const ownerRef = ref(db!, `rooms/${roomCode}/owner`);

  // Per-client owner-onDisconnect for `/owner`. We used to wipe the whole
  // room on owner disconnect, but with per-client playlist publishing that
  // would also nuke every guest's entry — so we now only clear the owner
  // pointer. Guests' `/playlists/{theirId}` keys are managed by their own
  // onDisconnect handlers below.
  let ownerDisconnect: OnDisconnect | null = null;

  async function armOwnerDisconnect() {
    if (ownerDisconnect) await ownerDisconnect.cancel();
    ownerDisconnect = onDisconnect(ownerRef);
    await ownerDisconnect.remove();
  }

  async function disarmOwnerDisconnect() {
    if (!ownerDisconnect) return;
    await ownerDisconnect.cancel();
    ownerDisconnect = null;
  }

  // Per-client playlist node + its onDisconnect cleanup, keyed by clientId.
  // Realistically only one clientId per session, but keying lets a single
  // tab handle re-arming idempotently.
  const playlistDisconnects = new Map<string, OnDisconnect>();
  function myPlaylistRef(clientId: string) {
    return ref(db!, `rooms/${roomCode}/playlists/${clientId}`);
  }

  return {
    publish: (state) => rtdbSet(currentRef, state),
    subscribe: (cb) => {
      const handler = (snap: { val: () => RoomState | null }) =>
        cb(snap.val());
      onValue(currentRef, handler);
      return () => off(currentRef, "value", handler);
    },
    publishMyPlaylists: async (clientId, playlists) => {
      const r = myPlaylistRef(clientId);
      await rtdbSet(r, playlists);
      // Arm onDisconnect once per (room, clientId) so a closed tab cleans
      // up its key automatically. Re-arming is a no-op so we only do the
      // first time.
      if (!playlistDisconnects.has(clientId)) {
        const od = onDisconnect(r);
        await od.remove();
        playlistDisconnects.set(clientId, od);
      }
    },
    removeMyPlaylists: async (clientId) => {
      const od = playlistDisconnects.get(clientId);
      if (od) {
        await od.cancel();
        playlistDisconnects.delete(clientId);
      }
      await remove(myPlaylistRef(clientId)).catch((err) =>
        console.error("playlist cleanup failed:", err),
      );
    },
    subscribePlaylists: (cb) => {
      const handler = (snap: {
        val: () => Record<string, Playlist[]> | null;
      }) => cb(snap.val());
      onValue(playlistsRef, handler);
      return () => off(playlistsRef, "value", handler);
    },
    claimOwner: async (clientId) => {
      const result = await runTransaction(ownerRef, (current: RoomOwner | null) => {
        if (current && current.clientId === clientId) return; // already ours
        if (current && current.clientId) return; // someone else's — abort
        return { clientId, claimedAt: Date.now() };
      });
      const snap = result.snapshot.val() as RoomOwner | null;
      if (snap?.clientId === clientId) {
        await armOwnerDisconnect();
        return true;
      }
      return false;
    },
    releaseOwner: async (clientId) => {
      const result = await runTransaction(ownerRef, (current: RoomOwner | null) => {
        if (!current) return current; // nothing to release
        if (current.clientId !== clientId) return; // not ours, abort
        return null; // delete the owner key
      });
      if (result.committed) {
        // Only the owner pointer is ours to clear — guests' playlist keys
        // and the room's current selection belong to whoever's still in
        // here, so we leave them alone.
        await disarmOwnerDisconnect();
      }
    },
    subscribeOwner: (cb) => {
      const handler = (snap: { val: () => RoomOwner | null }) =>
        cb(snap.val());
      onValue(ownerRef, handler);
      return () => off(ownerRef, "value", handler);
    },
  };
}

function localRoom(roomCode: string): RoomSync {
  const channelName = `chordroom:${roomCode}`;
  const stateKey = `chordroom:state:${roomCode}`;
  // Playlists are now per-client: store the whole `{ clientId → Playlist[] }`
  // map under a single key so the BroadcastChannel mock can deliver the same
  // shape as the real Firebase RTDB layer.
  const plKey = `chordroom:pl:${roomCode}`;
  const ownerKey = `chordroom:owner:${roomCode}`;
  function readOwner(): RoomOwner | null {
    const raw = localStorage.getItem(ownerKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.clientId === "string") return parsed as RoomOwner;
    } catch {
      // corrupt JSON — fall through to null
    }
    return null;
  }
  function readPlaylistMap(): Record<string, Playlist[]> {
    const raw = localStorage.getItem(plKey);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, Playlist[]>) : {};
    } catch {
      return {};
    }
  }
  function writePlaylistMap(map: Record<string, Playlist[]>) {
    try {
      localStorage.setItem(plKey, JSON.stringify(map));
      new BroadcastChannel(channelName).postMessage({ kind: "pl", payload: map });
    } catch {
      // storage unavailable — best-effort in dev fallback
    }
  }
  return {
    publish: async (state) => {
      try {
        localStorage.setItem(stateKey, JSON.stringify(state));
        new BroadcastChannel(channelName).postMessage({ kind: "state", payload: state });
      } catch {
        // storage / channel unavailable — best-effort in dev fallback
      }
    },
    subscribe: (cb) => {
      const ch = new BroadcastChannel(channelName);
      ch.onmessage = (e) => {
        if (e.data?.kind === "state") cb(e.data.payload as RoomState);
      };
      const initial = localStorage.getItem(stateKey);
      if (initial) {
        try {
          cb(JSON.parse(initial));
        } catch {
          // corrupt JSON — skip the seed
        }
      }
      return () => ch.close();
    },
    publishMyPlaylists: async (clientId, playlists) => {
      const map = readPlaylistMap();
      map[clientId] = playlists;
      writePlaylistMap(map);
    },
    removeMyPlaylists: async (clientId) => {
      const map = readPlaylistMap();
      if (!(clientId in map)) return;
      delete map[clientId];
      writePlaylistMap(map);
    },
    subscribePlaylists: (cb) => {
      const ch = new BroadcastChannel(channelName);
      ch.onmessage = (e) => {
        if (e.data?.kind === "pl") cb(e.data.payload as Record<string, Playlist[]> | null);
      };
      const seed = readPlaylistMap();
      cb(Object.keys(seed).length ? seed : null);
      return () => ch.close();
    },
    claimOwner: async (clientId) => {
      const existing = readOwner();
      if (existing) return existing.clientId === clientId;
      const owner: RoomOwner = { clientId, claimedAt: Date.now() };
      try {
        localStorage.setItem(ownerKey, JSON.stringify(owner));
        new BroadcastChannel(channelName).postMessage({ kind: "owner", payload: owner });
      } catch {
        // storage unavailable — claim is best-effort in dev fallback
      }
      return true;
    },
    releaseOwner: async (clientId) => {
      const existing = readOwner();
      if (existing && existing.clientId !== clientId) return;
      // Only clear the owner pointer; other clients' playlists and the
      // shared `/current` selection keep going.
      try {
        localStorage.removeItem(ownerKey);
        const ch = new BroadcastChannel(channelName);
        ch.postMessage({ kind: "owner", payload: null });
        ch.close();
      } catch {
        // storage unavailable — release is best-effort in dev fallback
      }
    },
    subscribeOwner: (cb) => {
      const ch = new BroadcastChannel(channelName);
      ch.onmessage = (e) => {
        if (e.data?.kind === "owner") cb(e.data.payload as RoomOwner | null);
      };
      cb(readOwner());
      return () => ch.close();
    },
  };
}

export function getRoomSync(roomCode: string): RoomSync {
  return firebaseEnabled ? firebaseRoom(roomCode) : localRoom(roomCode);
}
