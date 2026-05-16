// Cross-device sync of per-identity data via Firestore.
//
// Two identity sources, same doc schema:
//   - { kind: "client", clientId } → `clients/{clientId}`
//     Anonymous-mode sync (no Firebase Auth). clientId is a random 8-char
//     string in localStorage. Used when the user is signed out — backward
//     compatible with what prod did before auth was added.
//   - { kind: "user", uid } → `users/{uid}`
//     Signed-in sync. Same shape but also carries `playlists` so the user's
//     playlists travel across devices (anonymous mode never persisted
//     playlists to cloud — they were room-only).
//
//   Local action  -> store update -> saveJSON (IndexedDB) + pushUpdate (debounced)
//   Remote change -> onSnapshot   -> onRemoteUpdate (caller merges into store)
//
// Self-write feedback is filtered via snap.metadata.hasPendingWrites.
import {
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { clientDocRef, firebaseEnabled, userDocRef } from "./firebase";
import type { Playlist } from "../types";

export interface UserData {
  favorites: number[];
  latest: number[];
  roomCode?: string;
  // Only present for `{ kind: "user" }` syncs. Anonymous client docs leave
  // this undefined (playlists for anon clients are room-scoped only).
  playlists?: Playlist[];
}

export type SyncSource =
  | { kind: "client"; clientId: string }
  | { kind: "user"; uid: string };

function refFor(source: SyncSource) {
  return source.kind === "client"
    ? clientDocRef(source.clientId)
    : userDocRef(source.uid);
}

interface ActiveSync {
  source: SyncSource;
  unsubscribe: () => void;
  ready: boolean;
  pendingDelta: Partial<UserData>;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

// Only one active sync at a time. switching sources (sign-in/sign-out) tears
// down the previous one before installing the new one.
let active: ActiveSync | null = null;

/**
 * Initialize cloud sync for a given identity source.
 *
 * - If no remote doc exists, the provided `initialLocal` is pushed up.
 * - If a remote doc exists, `onRemoteUpdate` is called once with its contents
 *   and again whenever the remote changes from another device.
 *
 * Returns a teardown function. Calling it stops the subscription and flushes
 * any pending writes. Safe to call before sign-out / source switch.
 */
export function startCloudSync(
  source: SyncSource,
  initialLocal: UserData,
  onRemoteUpdate: (data: UserData) => void,
): () => void {
  if (!firebaseEnabled) return () => {};
  const ref = refFor(source);
  if (!ref) return () => {};

  // Build the new sync entry before tearing down the old one — keeps the
  // local pending-write state isolated per source.
  const entry: ActiveSync = {
    source,
    unsubscribe: () => {},
    ready: false,
    pendingDelta: {},
    pendingTimer: null,
  };

  let isFirst = true;
  const unsub = onSnapshot(
    ref,
    (snap) => {
      // Ignore optimistic local writes; we'll get the server-confirmed snapshot next.
      if (snap.metadata.hasPendingWrites) return;
      if (isFirst) {
        isFirst = false;
        // Set ready BEFORE invoking the caller's handler — the handler may
        // itself call pushUpdate (e.g. when a URL-forced room needs to be
        // written up to override a stale cloud value), and pushUpdate is
        // a no-op while !ready.
        entry.ready = true;
        if (snap.exists()) {
          onRemoteUpdate(snap.data() as UserData);
        } else {
          setDoc(ref, { ...initialLocal, updatedAt: serverTimestamp() }).catch(
            (err) => console.error("[cloudSync] init write failed:", err),
          );
        }
      } else if (snap.exists()) {
        onRemoteUpdate(snap.data() as UserData);
      }
    },
    (err) => console.error("[cloudSync] subscription error:", err),
  );
  entry.unsubscribe = unsub;

  // Replace the previous sync atomically.
  if (active) teardown(active);
  active = entry;

  return () => {
    if (active === entry) {
      teardown(entry);
      active = null;
    }
  };
}

function teardown(entry: ActiveSync) {
  if (entry.pendingTimer) {
    clearTimeout(entry.pendingTimer);
    entry.pendingTimer = null;
  }
  // Best-effort flush of anything pending — synchronous so a sign-out that
  // immediately rotates sources doesn't lose the last write.
  if (Object.keys(entry.pendingDelta).length > 0) {
    flushEntry(entry).catch(() => {});
  }
  try {
    entry.unsubscribe();
  } catch (err) {
    console.error("[cloudSync] unsubscribe error:", err);
  }
}

/** Queue a partial update to the remote doc. Coalesces writes within 400ms. */
export function pushUpdate(delta: Partial<UserData>) {
  if (!active || !active.ready) return;
  Object.assign(active.pendingDelta, delta);
  if (active.pendingTimer) clearTimeout(active.pendingTimer);
  active.pendingTimer = setTimeout(() => {
    if (active) flushEntry(active).catch(() => {});
  }, 400);
}

async function flushEntry(entry: ActiveSync) {
  entry.pendingTimer = null;
  const ref = refFor(entry.source);
  if (!ref) return;
  const delta = entry.pendingDelta;
  entry.pendingDelta = {};
  if (Object.keys(delta).length === 0) return;
  try {
    await setDoc(
      ref,
      { ...delta, updatedAt: serverTimestamp() },
      { merge: true },
    );
  } catch (err) {
    console.error("[cloudSync] write failed:", err);
  }
}

/**
 * One-shot read of the remote doc for a given source. Used by the sign-in
 * migration flow to decide whether to merge or push fresh — we can't rely
 * on onSnapshot's first emit because we need the value BEFORE we wire up
 * the subscription (the subscription's onRemoteUpdate would clobber local
 * data with whatever was on the server).
 */
export async function readRemoteOnce(
  source: SyncSource,
): Promise<UserData | null> {
  if (!firebaseEnabled) return null;
  const ref = refFor(source);
  if (!ref) return null;
  try {
    const snap = await getDoc(ref);
    return snap.exists() ? (snap.data() as UserData) : null;
  } catch (err) {
    console.error("[cloudSync] readRemoteOnce failed:", err);
    return null;
  }
}

/**
 * Direct write to a source's doc. Used by the sign-in migration to push the
 * merged blob in one shot before normal sync takes over.
 */
export async function writeRemote(
  source: SyncSource,
  data: UserData,
): Promise<void> {
  if (!firebaseEnabled) return;
  const ref = refFor(source);
  if (!ref) return;
  try {
    await setDoc(
      ref,
      { ...data, updatedAt: serverTimestamp() },
      { merge: true },
    );
  } catch (err) {
    console.error("[cloudSync] writeRemote failed:", err);
    throw err;
  }
}
