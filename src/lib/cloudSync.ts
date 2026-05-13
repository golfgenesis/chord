// Cross-device sync of per-client data (favorites, latest, roomCode) via
// Firestore under clients/{clientId}. NO Firebase Auth — the clientId is a
// random 8-char string persisted in localStorage (see store.ts), so no
// anonymous auth user records accumulate in the Firebase Console.
//
//   Local action -> store update -> saveJSON (IndexedDB) + pushUpdate (debounced)
//   Remote change -> onSnapshot -> onRemoteUpdate (caller merges into store)
//
// Self-write feedback is filtered via snap.metadata.hasPendingWrites.
import { onSnapshot, setDoc } from "firebase/firestore";
import { firebaseEnabled, clientDocRef } from "./firebase";

// Per-client data. Playlists are now per-room (see room sync in firebase.ts),
// not per-client, so they're not in here.
export interface UserData {
  favorites: number[];
  latest: number[];
  roomCode?: string;
}

let activeClientId: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDelta: Partial<UserData> = {};
let ready = false;

/**
 * Initialize cloud sync for a given clientId.
 *
 * - If the client has no remote doc yet, the provided `initialLocal` is pushed up.
 * - If a remote doc exists, `onRemoteUpdate` is called immediately and again
 *   whenever the remote changes from another device using the same clientId.
 */
export async function startCloudSync(
  clientId: string,
  initialLocal: UserData,
  onRemoteUpdate: (data: UserData) => void,
): Promise<string | null> {
  if (!firebaseEnabled) return null;
  const ref = clientDocRef(clientId);
  if (!ref) return null;
  activeClientId = clientId;

  let isFirst = true;
  // No teardown — the subscription lives for the page lifetime.
  onSnapshot(
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
        ready = true;
        if (snap.exists()) {
          onRemoteUpdate(snap.data() as UserData);
        } else {
          setDoc(ref, initialLocal).catch((err) =>
            console.error("cloudSync init write failed:", err),
          );
        }
      } else if (snap.exists()) {
        onRemoteUpdate(snap.data() as UserData);
      }
    },
    (err) => console.error("cloudSync subscription error:", err),
  );

  return clientId;
}

/** Queue a partial update to the remote doc. Coalesces writes within 400ms. */
export function pushUpdate(delta: Partial<UserData>) {
  if (!activeClientId || !ready) return;
  Object.assign(pendingDelta, delta);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flush, 400);
}

async function flush() {
  pendingTimer = null;
  if (!activeClientId) return;
  const ref = clientDocRef(activeClientId);
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
