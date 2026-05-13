// Firebase Realtime DB sync. Falls back to a local BroadcastChannel mock when
// VITE_FIREBASE_* env vars are not set — useful for local dev with no Firebase.
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getDatabase,
  ref,
  onValue,
  set as rtdbSet,
  off,
  runTransaction,
  type Database,
} from "firebase/database";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";
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

let app: FirebaseApp | null = null;
let db: Database | null = null;
let auth: Auth | null = null;
let firestore: Firestore | null = null;
export const firebaseEnabled = Boolean(cfg.apiKey && cfg.databaseURL);

if (firebaseEnabled) {
  app = initializeApp(cfg as Required<typeof cfg>);
  db = getDatabase(app);
  auth = getAuth(app);
  firestore = getFirestore(app);
}

/** Resolve the current user, signing in anonymously if needed. */
export function getCurrentUser(): Promise<User | null> {
  if (!auth) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (auth!.currentUser) return resolve(auth!.currentUser);
    const unsub = onAuthStateChanged(auth!, (user) => {
      unsub();
      if (user) return resolve(user);
      signInAnonymously(auth!)
        .then((cred) => resolve(cred.user))
        .catch((err) => {
          console.error("Anonymous sign-in failed:", err);
          resolve(null);
        });
    });
  });
}

export function userDocRef(uid: string): DocumentReference | null {
  if (!firestore) return null;
  return doc(firestore, "users", uid);
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
  const currentRef = ref(db!, `rooms/${roomCode}/current`);
  const playlistsRef = ref(db!, `rooms/${roomCode}/playlists`);
  const ownerRef = ref(db!, `rooms/${roomCode}/owner`);
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
        if (current && current.clientId) return; // abort: someone already owns it
        return { clientId, claimedAt: Date.now() };
      });
      const snap = result.snapshot.val() as RoomOwner | null;
      return result.committed && snap?.clientId === clientId;
    },
    releaseOwner: async (clientId) => {
      await runTransaction(ownerRef, (current: RoomOwner | null) => {
        if (!current) return current; // nothing to release
        if (current.clientId !== clientId) return; // not ours, abort
        return null; // delete the owner key
      });
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
      } catch {}
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
        } catch {}
      }
      return () => ch.close();
    },
    publishPlaylists: async (playlists) => {
      try {
        localStorage.setItem(plKey, JSON.stringify(playlists));
        new BroadcastChannel(channelName).postMessage({ kind: "pl", payload: playlists });
      } catch {}
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
        } catch {}
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
      try {
        localStorage.removeItem(ownerKey);
        new BroadcastChannel(channelName).postMessage({ kind: "owner", payload: null });
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
