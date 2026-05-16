// Firebase Auth wrapper. Lazy-imported so the Auth SDK (~40KB gzipped) only
// lands in the bundle when the user actually opens the sign-in sheet.
//
// We expose providers Google / Facebook / Email-Password. Apple is intentionally
// out — needs paid Apple Developer membership.
//
// Identity model:
//   - signed out (default) → app keeps using `clientId` (random 8-char string
//     in localStorage). cloud sync writes to `clients/{clientId}`.
//   - signed in            → cloud sync switches to `users/{uid}`. The clientId
//     stays around as the *session* identity inside a room (so two devices of
//     the same user in one room still appear as two separate session entries
//     in `rooms/{code}/playlists/{clientId}`).
//
// Auth state lives behind subscribeAuth() — store.ts wires this into its
// re-init flow. All entry points return Promises that reject on failure so
// the UI can show errors.
import {
  browserLocalPersistence,
  EmailAuthProvider,
  fetchSignInMethodsForEmail,
  getAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  linkWithCredential,
  linkWithPopup,
  linkWithRedirect,
  unlink,
  signOut,
  GoogleAuthProvider,
  FacebookAuthProvider,
  updateProfile,
  type Auth,
  type AuthCredential,
  type User,
  type UserCredential,
} from "firebase/auth";
import { isIOS } from "./platform";
import { isInstalledPWA } from "./platform";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string | null;
}

export type AuthProviderKind = "google" | "facebook";

let auth: Auth | null = null;
let initialized = false;

// Which provider the user actively signed in with this session — persisted
// so it survives refresh. Used by toAuthUser() to pick which provider's
// displayName/photoURL to show. Without this we'd have to guess (and would
// guess wrong for users with multiple linked providers).
const ACTIVE_PROVIDER_KEY = "chord/active-provider";

function setActiveProvider(providerId: string | null): void {
  try {
    if (providerId) localStorage.setItem(ACTIVE_PROVIDER_KEY, providerId);
    else localStorage.removeItem(ACTIVE_PROVIDER_KEY);
  } catch {
    // localStorage unavailable (private mode / quota) — fall back to default
    // priority order in toAuthUser. Not fatal.
  }
}

function getActiveProvider(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROVIDER_KEY);
  } catch {
    return null;
  }
}

/**
 * Initialize Auth against an already-initialized Firebase App. firebase.ts
 * calls this when the Firebase chunk loads — auth.ts itself doesn't
 * initialize the app, that's firebase.ts's job.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function initAuth(): Auth | null {
  if (initialized) return auth;
  initialized = true;
  try {
    auth = getAuth();
  } catch (err) {
    console.error("[auth] getAuth failed:", err);
    auth = null;
    return null;
  }
  // Sequence setPersistence → getRedirectResult deliberately.
  //
  // Why: both are async. If we fire-and-forget setPersistence and then
  // immediately call getRedirectResult, the SDK may process the redirect
  // credential and write it to the DEFAULT persistence (localStorage)
  // before our switch to IndexedDB takes effect. On the next page load
  // the SDK looks in IndexedDB and finds nothing → user appears
  // signed out even though OAuth succeeded. This was the symptom on
  // iOS PWA where signInWithRedirect is the only viable flow.
  //
  // initAuth itself stays sync (returns Auth immediately) — the async
  // work runs in a fire-and-forget IIFE. The first onAuthStateChanged
  // emission is what subscribeAuth wires the rest of the app to, so
  // ordering inside this IIFE is what matters.
  const authNN = auth;
  (async () => {
    try {
      await setPersistence(authNN, indexedDBLocalPersistence);
    } catch {
      try {
        await setPersistence(authNN, browserLocalPersistence);
      } catch (err) {
        console.error("[auth] setPersistence fallback failed:", err);
      }
    }
    // Now safe to process the redirect callback — any user the SDK
    // creates here lands in the persistence we just locked in.
    try {
      const cred = await getRedirectResult(authNN);
      if (cred?.providerId) setActiveProvider(cred.providerId);
    } catch (err) {
      if ((err as { code?: string })?.code !== "auth/no-auth-event") {
        console.error("[auth] getRedirectResult error:", err);
      }
    }
  })();
  return auth;
}

// Fallback order if the user hasn't signed in this session (no active
// provider stored) AND root displayName/photoURL is null. Google URLs are
// persistent; Facebook URLs expire (~30 days, signed `ext` param); password
// never has a photo or real name.
const PROVIDER_PRIORITY = ["google.com", "facebook.com", "password"];

function toAuthUser(u: User | null): AuthUser | null {
  if (!u) return null;
  // Prefer the provider the user just signed in with — that's what the user
  // expects to see (login with Facebook → Facebook's avatar). The active
  // provider is captured at sign-in time and remembered in localStorage.
  const active = getActiveProvider();
  const activeEntry = active
    ? u.providerData.find((p) => p.providerId === active)
    : null;
  // Then fall back to the priority-ordered walk, which catches:
  //   - First-time sign-in before setActiveProvider was called (rare race)
  //   - Active provider has no data (e.g. signed in with email — pull from
  //     a linked OAuth provider's avatar instead)
  //   - localStorage was wiped
  const sortedProviders = [...u.providerData].sort((a, b) => {
    const ai = PROVIDER_PRIORITY.indexOf(a.providerId);
    const bi = PROVIDER_PRIORITY.indexOf(b.providerId);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const displayName =
    activeEntry?.displayName ||
    u.displayName ||
    pickFromProviders(sortedProviders, "displayName");
  const photoURL =
    activeEntry?.photoURL ||
    u.photoURL ||
    pickFromProviders(sortedProviders, "photoURL");
  // providerId reflects the currently-active sign-in method when available.
  // This is what the Profile sheet shows as "เข้าผ่าน X" — the user expects
  // it to match the provider they just used.
  const providerId =
    activeEntry?.providerId ?? sortedProviders[0]?.providerId ?? null;
  return {
    uid: u.uid,
    email: u.email,
    displayName,
    photoURL,
    providerId,
  };
}

function pickFromProviders(
  providers: { displayName: string | null; photoURL: string | null }[],
  field: "displayName" | "photoURL",
): string | null {
  for (const p of providers) {
    const v = p[field];
    if (v) return v;
  }
  return null;
}

/** Subscribe to auth state changes. cb fires immediately with current state. */
export function subscribeAuth(cb: (u: AuthUser | null) => void): () => void {
  if (!auth) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (u) => cb(toAuthUser(u)));
}

/**
 * Pick the right OAuth flow per platform.
 *
 * Popup is preferred on desktop/Chrome Android — it returns the credential
 * synchronously and we don't lose page state. But popup is blocked on:
 *   - iOS Safari (always, even with a user gesture in some versions)
 *   - PWA standalone mode (Safari) — `window.open` of cross-origin URLs is
 *     blocked outright in installed PWAs
 *   - Some embedded webviews
 * In those, we fall back to signInWithRedirect, which navigates the page
 * away to the provider and back. getRedirectResult() picks it up in initAuth.
 */
function shouldUseRedirect(): boolean {
  if (isInstalledPWA()) return true;
  if (isIOS()) return true;
  return false;
}

async function signInWithProvider(
  provider: GoogleAuthProvider | FacebookAuthProvider,
): Promise<UserCredential | null> {
  if (!auth) throw new Error("auth not initialized");
  if (shouldUseRedirect()) {
    await signInWithRedirect(auth, provider);
    return null; // result is picked up by getRedirectResult after redirect
  }
  return signInWithPopup(auth, provider);
}

// Helper: run a sign-in operation with active-provider tracking. We set
// the active provider BEFORE awaiting because Firebase's onAuthStateChanged
// fires synchronously inside signInWithPopup/signInWithEmail (before the
// outer promise resolves). If we set it after the await, our store's
// subscribeAuth callback reads stale localStorage and the UI renders with
// the OLD provider's avatar until the next refresh. On failure we restore.
async function runSignIn<T>(
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = getActiveProvider();
  setActiveProvider(providerId);
  try {
    return await fn();
  } catch (err) {
    // Restore — auth.currentUser didn't change so onAuthStateChanged didn't
    // re-fire with the new identity. Putting the active back to what it
    // was keeps the displayed avatar consistent.
    setActiveProvider(prev);
    throw err;
  }
}

export function signInWithGoogle(): Promise<UserCredential | null> {
  const p = new GoogleAuthProvider();
  // Force account selector so users on shared machines can switch identities.
  p.setCustomParameters({ prompt: "select_account" });
  return runSignIn("google.com", () => signInWithProviderCapturing(p, "google"));
}

export function signInWithFacebook(): Promise<UserCredential | null> {
  const p = new FacebookAuthProvider();
  return runSignIn("facebook.com", () =>
    signInWithProviderCapturing(p, "facebook"),
  );
}

/** Sign in with existing email + password. Throws if account doesn't exist. */
export function signInWithEmail(
  email: string,
  password: string,
): Promise<UserCredential> {
  if (!auth) throw new Error("auth not initialized");
  const authNN = auth;
  return runSignIn("password", () =>
    signInWithEmailAndPassword(authNN, email.trim(), password),
  );
}

/** Create a new email/password account. Caller should validate inputs first. */
export function signUpWithEmail(
  email: string,
  password: string,
  displayName?: string,
): Promise<UserCredential> {
  if (!auth) throw new Error("auth not initialized");
  const authNN = auth;
  return runSignIn("password", async () => {
    const cred = await createUserWithEmailAndPassword(
      authNN,
      email.trim(),
      password,
    );
    if (displayName && cred.user) {
      try {
        await updateProfile(cred.user, { displayName });
      } catch (err) {
        console.warn("[auth] updateProfile failed (non-fatal):", err);
      }
    }
    return cred;
  });
}

export async function sendResetEmail(email: string): Promise<void> {
  if (!auth) throw new Error("auth not initialized");
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOutNow(): Promise<void> {
  if (!auth) return;
  setActiveProvider(null);
  await signOut(auth);
}

// ─── Account linking ────────────────────────────────────────────────────
//
// Firebase by default rejects sign-in when the email is already in use by a
// different provider — throws `auth/account-exists-with-different-credential`.
// To merge, the user must first prove they own the existing account (sign in
// with the original provider) and THEN we call linkWithCredential() to attach
// the rejected credential to the now-active user.
//
// We stash the pending credential + email + first provider list in module
// state when the error fires, so the next successful sign-in can pull it
// back out and finish the link. The stash is single-slot and short-lived
// (cleared after a successful link or after a different user signs in).

export interface PendingLink {
  email: string;
  providerLabel: AuthProviderKind | "email";  // the one we just tried that got rejected
  existingMethods: string[];                  // which provider(s) the user already has
}

interface PendingLinkInternal extends PendingLink {
  credential: AuthCredential;
}

let pendingLink: PendingLinkInternal | null = null;

export function getPendingLink(): PendingLink | null {
  if (!pendingLink) return null;
  return {
    email: pendingLink.email,
    providerLabel: pendingLink.providerLabel,
    existingMethods: pendingLink.existingMethods,
  };
}

export function clearPendingLink(): void {
  pendingLink = null;
}

/**
 * Extract the rejected credential + email from an "account-exists" error and
 * stash it. Returns the public-facing summary so the UI can prompt the user
 * to sign in with the existing provider.
 *
 * Each provider has its own `credentialFromError` static — we try both
 * because the caller doesn't always know which one threw.
 */
async function stashPendingFromError(
  err: unknown,
  attemptedProvider: AuthProviderKind | "email",
): Promise<PendingLink | null> {
  if (!auth) return null;
  const e = err as { code?: string; customData?: { email?: string } };
  if (e?.code !== "auth/account-exists-with-different-credential") return null;
  const email = e.customData?.email;
  if (!email) return null;
  // The credential is stamped on the error by Firebase. Either provider's
  // static method can decode it — we try Google first, then Facebook.
  const credential =
    GoogleAuthProvider.credentialFromError(err as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]) ??
    FacebookAuthProvider.credentialFromError(err as Parameters<typeof FacebookAuthProvider.credentialFromError>[0]);
  if (!credential) return null;
  let methods: string[] = [];
  try {
    methods = await fetchSignInMethodsForEmail(auth, email);
  } catch {
    // Best-effort; UI can still proceed without the methods list.
  }
  pendingLink = {
    email,
    providerLabel: attemptedProvider,
    existingMethods: methods,
    credential,
  };
  return getPendingLink();
}

/**
 * After a user has signed in (with the provider that owns this email), call
 * this to attach the previously-rejected credential. Returns true on success.
 */
export async function consumePendingLink(): Promise<boolean> {
  if (!auth || !auth.currentUser || !pendingLink) return false;
  try {
    await linkWithCredential(auth.currentUser, pendingLink.credential);
    pendingLink = null;
    return true;
  } catch (err) {
    console.error("[auth] consumePendingLink failed:", err);
    return false;
  }
}

// Wrap the sign-in helpers so they capture pending credentials on conflict.
async function signInWithProviderCapturing(
  provider: GoogleAuthProvider | FacebookAuthProvider,
  kind: AuthProviderKind,
): Promise<UserCredential | null> {
  try {
    return await signInWithProvider(provider);
  } catch (err) {
    await stashPendingFromError(err, kind);
    throw err;
  }
}

// ─── Linking against the CURRENT signed-in user ──────────────────────────
//
// Used by the Profile sheet's "Connect Google/Facebook" buttons — the user
// is already signed in and wants to attach another provider to the same uid.

export async function linkProvider(
  kind: AuthProviderKind,
): Promise<UserCredential | null> {
  if (!auth || !auth.currentUser) throw new Error("not signed in");
  const provider =
    kind === "google" ? new GoogleAuthProvider() : new FacebookAuthProvider();
  if (kind === "google") {
    (provider as GoogleAuthProvider).setCustomParameters({ prompt: "select_account" });
  }
  if (shouldUseRedirect()) {
    await linkWithRedirect(auth.currentUser, provider);
    return null;
  }
  return linkWithPopup(auth.currentUser, provider);
}

/** Attach an email/password credential to the current signed-in user. */
export async function linkEmailPassword(
  email: string,
  password: string,
): Promise<UserCredential> {
  if (!auth || !auth.currentUser) throw new Error("not signed in");
  const credential = EmailAuthProvider.credential(email.trim(), password);
  return linkWithCredential(auth.currentUser, credential);
}

/**
 * Detach a provider from the current user. Firebase refuses if it's the
 * only one (user would be locked out) — we surface that as an error string
 * the UI can display.
 */
export async function unlinkProvider(providerId: string): Promise<void> {
  if (!auth || !auth.currentUser) throw new Error("not signed in");
  await unlink(auth.currentUser, providerId);
}

/** List the linked provider IDs of the current user (e.g. `google.com`). */
export function getLinkedProviderIds(): string[] {
  if (!auth || !auth.currentUser) return [];
  return auth.currentUser.providerData.map((p) => p.providerId);
}

/** Friendly Thai-language error messages for the UI. */
export function describeAuthError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "อีเมลไม่ถูกต้อง";
    case "auth/missing-password":
    case "auth/weak-password":
      return "รหัสผ่านอย่างน้อย 6 ตัวอักษร";
    case "auth/email-already-in-use":
      return "อีเมลนี้มีบัญชีอยู่แล้ว ลองเข้าสู่ระบบแทน";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
    case "auth/user-not-found":
      return "ไม่พบบัญชีนี้ — สมัครใหม่ก่อน";
    case "auth/too-many-requests":
      return "ลองมากเกินไป รอสักครู่แล้วลองใหม่";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "ปิดหน้าต่างก่อนเข้าสู่ระบบเสร็จ";
    case "auth/account-exists-with-different-credential":
      return "อีเมลนี้เคยสมัครด้วยวิธีอื่น — ดูคำแนะนำด้านล่างเพื่อเชื่อมต่อบัญชี";
    case "auth/provider-already-linked":
      return "บัญชีนี้เชื่อมต่อกับวิธีนี้อยู่แล้ว";
    case "auth/credential-already-in-use":
      return "บัญชี provider นี้ถูกใช้กับ user อื่นแล้ว เชื่อมต่อไม่ได้";
    case "auth/no-such-provider":
      return "ไม่ได้เชื่อมต่อกับวิธีนี้ ไม่ต้องลบ";
    case "auth/requires-recent-login":
      return "ต้อง login ใหม่ก่อนทำรายการนี้";
    case "auth/network-request-failed":
      return "เน็ตมีปัญหา ลองใหม่อีกครั้ง";
    default:
      return "เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง";
  }
}
