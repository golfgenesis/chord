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
  getFirestore,
  doc,
  type Firestore,
  type DocumentReference,
} from "firebase/firestore";
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
  firestore = getFirestore(app);
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

// ---- Room sync (Realtime DB) -----------------------------------------------

export interface RoomSync {
  // Current song selection
  publish(state: RoomState): Promise<void>;
  subscribe(cb: (state: RoomState | null) => void): () => void;
  // Playlists (authored by the room owner, visible to everyone)
  publishPlaylists(playlists: Playlist[]): Promise<void>;
  subscribePlaylists(cb: (playlists: Playlist[] | null) => void): () => void;
  // Ownership. The first user in a room atomically claims it; subsequent
  // joiners just observe. Owner must explicitly release on leaving.
  claimOwner(clientId: string): Promise<boolean>;
  releaseOwner(clientId: string): Promise<void>;
  subscribeOwner(cb: (owner: RoomOwner | null) => void): () => void;
}

function firebaseRoom(roomCode: string): RoomSync {
  const roomRef = ref(db!, `rooms/${roomCode}`);
  const currentRef = ref(db!, `rooms/${roomCode}/current`);
  const playlistsRef = ref(db!, `rooms/${roomCode}/playlists`);
  const ownerRef = ref(db!, `rooms/${roomCode}/owner`);

  // When we own a room, register an onDisconnect to remove the whole room
  // node if our connection drops (closed tab, network down, killed by iOS).
  // Combined with releaseOwner (called on explicit room-switch), this keeps
  // abandoned rooms from accumulating in RTDB.
  let disconnectHandle: OnDisconnect | null = null;

  async function armDisconnect() {
    if (disconnectHandle) {
      // Re-arming on the same room — drop the prior handle first.
      await disconnectHandle.cancel();
    }
    disconnectHandle = onDisconnect(roomRef);
    await disconnectHandle.remove();
  }

  async function disarmDisconnect() {
    if (!disconnectHandle) return;
    await disconnectHandle.cancel();
    disconnectHandle = null;
  }

  return {
    publish: (state) => rtdbSet(currentRef, state),
    subscribe: (cb) => {
      const handler = (snap: { val: () => RoomState | null }) =>
        cb(snap.val());
      onValue(currentRef, handler);
      return () => off(currentRef, "value", handler);
    },
    publishPlaylists: (playlists) => rtdbSet(playlistsRef, playlists),
    subscribePlaylists: (cb) => {
      const handler = (snap: { val: () => Playlist[] | null }) =>
        cb(snap.val());
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
        await armDisconnect();
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
        // We were the owner. Cancel the pending disconnect-cleanup and wipe
        // the whole room node — nobody's left to maintain it.
        await disarmDisconnect();
        await remove(roomRef).catch((err) =>
          console.error("room cleanup failed:", err),
        );
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
    publishPlaylists: async (playlists) => {
      try {
        localStorage.setItem(plKey, JSON.stringify(playlists));
        new BroadcastChannel(channelName).postMessage({ kind: "pl", payload: playlists });
      } catch {
        // storage / channel unavailable — best-effort in dev fallback
      }
    },
    subscribePlaylists: (cb) => {
      const ch = new BroadcastChannel(channelName);
      ch.onmessage = (e) => {
        if (e.data?.kind === "pl") cb(e.data.payload as Playlist[]);
      };
      const initial = localStorage.getItem(plKey);
      if (initial) {
        try {
          cb(JSON.parse(initial));
        } catch {
          // corrupt JSON — skip the seed
        }
      } else {
        cb(null);
      }
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
      // Mirror the firebase impl: wipe the whole room (state + playlists +
      // owner) when the owner leaves, so nothing lingers in localStorage.
      try {
        localStorage.removeItem(ownerKey);
        localStorage.removeItem(stateKey);
        localStorage.removeItem(plKey);
        const ch = new BroadcastChannel(channelName);
        ch.postMessage({ kind: "owner", payload: null });
        ch.postMessage({ kind: "state", payload: null });
        ch.postMessage({ kind: "pl", payload: null });
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
