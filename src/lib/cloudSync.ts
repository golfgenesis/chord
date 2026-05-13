// Cross-device sync of user data (favorites, latest, playlists) via Firestore
// under users/{uid}. Uses Firebase Anonymous Auth — no sign-in UI needed.
//
//   Local action -> store update -> saveJSON (IndexedDB) + pushUpdate (debounced)
//   Remote change -> onSnapshot -> onRemoteUpdate (caller merges into store)
//
// Self-write feedback is filtered via snap.metadata.hasPendingWrites.
import { onSnapshot, setDoc } from "firebase/firestore";
import {
  firebaseEnabled,
  getCurrentUser,
  userDocRef,
} from "./firebase";

// Per-user data. Playlists are now per-room (see room sync in firebase.ts),
// not per-user, so they're not in here.
export interface UserData {
  favorites: number[];
  latest: number[];
  roomCode?: string;
}

let uid: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDelta: Partial<UserData> = {};
let ready = false;

/**
 * Initialize cloud sync. Resolves to the user's uid once the first snapshot
 * has been received (so callers know cloud is in sync with local UI).
 *
 * - If the user has no remote doc yet, the provided `initialLocal` is pushed up.
 * - If a remote doc exists, `onRemoteUpdate` is called immediately and again
 *   whenever the remote changes from another device.
 */
export async function startCloudSync(
  initialLocal: UserData,
  onRemoteUpdate: (data: UserData) => void,
): Promise<string | null> {
  if (!firebaseEnabled) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  uid = user.uid;

  const ref = userDocRef(uid);
  if (!ref) return null;

  let isFirst = true;
  // No teardown — the subscription lives for the page lifetime.
  onSnapshot(
    ref,
    (snap) => {
      // Ignore optimistic local writes; we'll get the server-confirmed snapshot next.
      if (snap.metadata.hasPendingWrites) return;
      if (isFirst) {
        isFirst = false;
        if (snap.exists()) {
          onRemoteUpdate(snap.data() as UserData);
        } else {
          setDoc(ref, initialLocal).catch((err) =>
            console.error("cloudSync init write failed:", err),
          );
        }
        ready = true;
      } else if (snap.exists()) {
        onRemoteUpdate(snap.data() as UserData);
      }
    },
    (err) => console.error("cloudSync subscription error:", err),
  );

  return uid;
}

/** Queue a partial update to the remote doc. Coalesces writes within 400ms. */
export function pushUpdate(delta: Partial<UserData>) {
  if (!uid || !ready) return;
  Object.assign(pendingDelta, delta);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flush, 400);
}

async function flush() {
  pendingTimer = null;
  if (!uid) return;
  const ref = userDocRef(uid);
  if (!ref) return;
  const delta = pendingDelta;
  pendingDelta = {};
  if (Object.keys(delta).length === 0) return;
  try {
    await setDoc(ref, delta, { merge: true });
  } catch (err) {
    console.error("cloudSync write failed:", err);
  }
}

