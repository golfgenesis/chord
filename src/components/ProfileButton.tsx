import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { SignInSheet } from "./SignInSheet";
import { CheckIcon, XIcon } from "./icons";
import {
  clearImageCache,
  getCachedUrlSet,
  subscribeCacheChange,
} from "../lib/offlineDownload";

/**
 * TopBar entry point for auth. Shows:
 *   - generic avatar icon when signed out → tap opens SignInSheet
 *   - user photo / initial when signed in → tap opens ProfileSheet
 *     (info + sign-out)
 *
 * Hidden entirely when VITE_AUTH_ENABLED isn't truthy, so we can ship the
 * code without enabling the feature for end users yet.
 */
export function ProfileButton() {
  const user = useApp((s) => s.user);
  const authReady = useApp((s) => s.authReady);
  const [showSignIn, setShowSignIn] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  if (!authReady) {
    // Skeleton placeholder keeps the TopBar layout stable while we wait
    // for Firebase to tell us if there's a cached user. Cached state
    // resolves synchronously after the SDK loads, so this is short-lived.
    return (
      <div
        className="grid size-10 place-items-center rounded-xl border border-line/70 bg-bg-card/60 opacity-60"
        aria-hidden
      >
        <Avatar user={null} />
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => (user ? setShowProfile(true) : setShowSignIn(true))}
        className="grid size-10 place-items-center overflow-hidden rounded-xl border border-line/70 bg-bg-card/60 text-ink-dim shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition hover:border-brand/40 hover:bg-bg-hover hover:text-ink active:scale-95"
        title={user ? user.displayName || user.email || "บัญชี" : "เข้าสู่ระบบ"}
        aria-label={user ? "Profile" : "Sign in"}
      >
        <Avatar user={user} />
      </button>
      {showSignIn && <SignInSheet onClose={() => setShowSignIn(false)} />}
      {showProfile && user && (
        <ProfileSheet user={user} onClose={() => setShowProfile(false)} />
      )}
    </>
  );
}

function Avatar({
  user,
}: {
  user: { photoURL: string | null; displayName: string | null; email: string | null } | null;
}) {
  // Track per-URL image-load failures. Facebook photo URLs expire after ~30
  // days (the `ext` query param is a signed expiry) so an `<img>` with a
  // stale URL just shows the browser's broken-image icon. Catch onError and
  // flip to the initial-letter fallback instead.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = user?.photoURL && user.photoURL !== failedUrl;
  if (showImage) {
    return (
      <img
        src={user.photoURL!}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(user.photoURL)}
        className="size-full object-cover"
      />
    );
  }
  if (user) {
    const initial = (user.displayName || user.email || "?").charAt(0).toUpperCase();
    return (
      <div className="grid size-full place-items-center bg-brand-grad text-[14px] font-bold text-white">
        {initial}
      </div>
    );
  }
  return <UserIcon />;
}

// Bigger variant for the ProfileSheet header card. Same fallback logic as
// the TopBar Avatar (catches expired photo URLs via onError) but renders
// a 20px initial instead of 14px.
function BigAvatar({
  user,
}: {
  user: { photoURL: string | null; displayName: string | null; email: string | null };
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = user.photoURL && user.photoURL !== failedUrl;
  if (showImage) {
    return (
      <img
        src={user.photoURL!}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(user.photoURL)}
        className="size-full object-cover"
      />
    );
  }
  return (
    <div className="grid size-full place-items-center bg-brand-grad text-[20px] font-bold text-white">
      {(user.displayName || user.email || "?").charAt(0).toUpperCase()}
    </div>
  );
}

function UserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px]"
      aria-hidden
    >
      <path d="M20 21a8 8 0 1 0-16 0" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function ProfileSheet({
  user,
  onClose,
}: {
  user: { displayName: string | null; email: string | null; photoURL: string | null; providerId: string | null };
  onClose: () => void;
}) {
  const signOutLocal = useApp((s) => s.signOutLocal);
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOutLocal();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const providerLabel = providerName(user.providerId);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="glass-strong flex h-full w-full animate-slide-up flex-col border border-white/10 sm:h-auto sm:max-h-[90dvh] sm:max-w-md sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-start justify-between gap-4 border-b border-line/40 px-6 py-5"
          style={{ paddingTop: "calc(var(--safe-top) + 1.25rem)" }}
        >
          <h3 className="font-display text-[20px] font-semibold leading-[1.3] tracking-tight text-ink">
            บัญชีของฉัน
          </h3>
          <button
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-mute transition hover:bg-bg-hover hover:text-ink"
            aria-label="ปิด"
          >
            <XIcon className="size-[18px]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="flex items-center gap-4 rounded-2xl border border-line/60 bg-bg-card/40 p-4">
            <div className="size-14 shrink-0 overflow-hidden rounded-full ring-1 ring-white/10">
              <BigAvatar user={user} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-ink">
                {user.displayName || user.email || "ไม่ระบุชื่อ"}
              </div>
              {user.email && (
                <div className="truncate text-[13px] text-ink-mute">
                  {user.email}
                </div>
              )}
              {providerLabel && (
                <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-ink-mute">
                  เข้าผ่าน {providerLabel}
                </div>
              )}
            </div>
          </div>

          <p className="text-[12px] leading-[1.55] text-ink-mute">
            เพลงโปรด / playlist / ลำดับเพลงล่าสุด จะ sync ข้ามเครื่องอัตโนมัติเมื่อ
            login ด้วยบัญชีนี้
          </p>

          <SettingsSection />
          <ConnectionsSection />
          <OfflineSection />
        </div>

        <div
          className="shrink-0 border-t border-line/40 px-6 py-4"
          style={{ paddingBottom: "calc(var(--safe-bottom) + 1rem)" }}
        >
          <button
            onClick={handleSignOut}
            disabled={busy}
            className="h-12 w-full rounded-xl border border-red-500/30 bg-red-500/10 text-[14px] font-semibold text-red-300 transition hover:bg-red-500/20 active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "กำลังออก..." : "ออกจากระบบ"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-mute">
      {children}
    </div>
  );
}

function ToggleRow({
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="flex w-full items-center gap-4 rounded-2xl border border-line/60 bg-bg-card/40 p-4 text-left transition hover:border-brand/40 hover:bg-bg-hover active:scale-[0.99]"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-mute">
          {description}
        </div>
      </div>
      <Switch on={value} />
    </button>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
        on ? "bg-brand-grad shadow-glow-sm" : "bg-bg-soft"
      }`}
      aria-hidden
    >
      <span
        className={`absolute top-1 size-5 rounded-full bg-white shadow-md transition ${
          on ? "left-[26px]" : "left-1"
        }`}
      />
    </span>
  );
}

function SettingsSection() {
  const autoOpen = useApp((s) => s.autoOpen);
  const toggleAutoOpen = useApp((s) => s.toggleAutoOpen);
  const invertImages = useApp((s) => s.invertImages);
  const toggleInvertImages = useApp((s) => s.toggleInvertImages);

  return (
    <div>
      <SectionHeader>การตั้งค่า</SectionHeader>
      <div className="space-y-2.5">
        <ToggleRow
          title="เด้งดูเพลงตามวงโดยอัตโนมัติ"
          description="เมื่อเพื่อนในห้องเปิดเพลง หน้าจะเด้งมาให้เห็นทันที"
          value={autoOpen}
          onChange={toggleAutoOpen}
        />
        <ToggleRow
          title="โหมดมืดของกระดาษคอร์ด"
          description="สลับสีกระดาษเป็นพื้นดำตัวขาว (ปุ่มในหน้าดูเพลงปรับได้ด้วย)"
          value={invertImages}
          onChange={toggleInvertImages}
        />
      </div>
    </div>
  );
}

// Provider catalogue. The Firebase provider IDs ("google.com" etc.) come
// from currentUser.providerData[].providerId.
const PROVIDERS: Array<{
  kind: "google" | "facebook" | "email";
  id: string;            // Firebase providerId
  label: string;         // display name
}> = [
  { kind: "google", id: "google.com", label: "Google" },
  { kind: "facebook", id: "facebook.com", label: "Facebook" },
  { kind: "email", id: "password", label: "อีเมล + รหัสผ่าน" },
];

type AuthMod = typeof import("../lib/auth");
let authModCacheLocal: AuthMod | null = null;
function loadAuthModLocal(): Promise<AuthMod> {
  if (authModCacheLocal) return Promise.resolve(authModCacheLocal);
  return import("../lib/auth").then((m) => {
    authModCacheLocal = m;
    return m;
  });
}

function ConnectionsSection() {
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [busyKind, setBusyKind] = useState<null | "google" | "facebook" | "email">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showEmailForm, setShowEmailForm] = useState(false);

  // Subscribe to auth-state changes. onAuthStateChanged fires on sign-in /
  // sign-out, and we also pump it manually after link/unlink (auth.ts
  // exports linkProvider/unlinkProvider, but those don't auto-trigger the
  // observer — so we refresh explicitly inside `runWithBusy` too).
  useEffect(() => {
    let active = true;
    let unsub: (() => void) | null = null;
    loadAuthModLocal().then((m) => {
      if (!active) return;
      unsub = m.subscribeAuth(() => {
        setLinkedIds(m.getLinkedProviderIds());
      });
    });
    return () => {
      active = false;
      if (unsub) unsub();
    };
  }, []);

  // Force a fresh read from auth.currentUser.providerData. Used after link
  // / unlink actions because those don't fire onAuthStateChanged.
  async function refresh() {
    const mod = await loadAuthModLocal();
    setLinkedIds(mod.getLinkedProviderIds());
  }

  async function runWithBusy(
    kind: "google" | "facebook" | "email",
    fn: (m: AuthMod) => Promise<unknown>,
  ) {
    setError(null);
    setInfo(null);
    setBusyKind(kind);
    try {
      const m = await loadAuthModLocal();
      await fn(m);
      await refresh();
    } catch (err) {
      const m = await loadAuthModLocal();
      setError(m.describeAuthError(err));
    } finally {
      setBusyKind(null);
    }
  }

  async function handleLink(kind: "google" | "facebook") {
    await runWithBusy(kind, async (m) => {
      await m.linkProvider(kind);
      setInfo(`เชื่อมต่อ ${kind === "google" ? "Google" : "Facebook"} แล้ว`);
    });
  }

  async function handleUnlink(providerId: string, label: string) {
    if (linkedIds.length <= 1) {
      setError("ต้องเชื่อมต่ออย่างน้อย 1 วิธี ไม่สามารถลบวิธีสุดท้ายได้");
      return;
    }
    if (!window.confirm(`ยกเลิกการเชื่อมต่อ ${label}?`)) return;
    await runWithBusy(
      // map providerId → kind for the busy-state UI
      providerId === "google.com"
        ? "google"
        : providerId === "facebook.com"
          ? "facebook"
          : "email",
      async (m) => {
        await m.unlinkProvider(providerId);
        setInfo(`ยกเลิกการเชื่อมต่อ ${label} แล้ว`);
      },
    );
  }

  return (
    <div>
      <SectionHeader>วิธีเข้าสู่ระบบที่เชื่อมต่อ</SectionHeader>
      {error && (
        <div className="mb-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] leading-[1.5] text-red-300">
          {error}
        </div>
      )}
      {info && (
        <div className="mb-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-[12px] leading-[1.5] text-emerald-300">
          {info}
        </div>
      )}
      <div className="space-y-2">
        {PROVIDERS.map((p) => {
          const linked = linkedIds.includes(p.id);
          const isBusy = busyKind === p.kind;
          return (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-2xl border border-line/60 bg-bg-card/40 p-3.5"
            >
              <ProviderGlyph kind={p.kind} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink">{p.label}</div>
                <div className="text-[11px] text-ink-mute">
                  {linked ? "เชื่อมต่อแล้ว" : "ยังไม่ได้เชื่อมต่อ"}
                </div>
              </div>
              {linked ? (
                <button
                  onClick={() => handleUnlink(p.id, p.label)}
                  disabled={isBusy || linkedIds.length <= 1}
                  className="h-9 rounded-lg border border-line/70 px-3 text-[12px] font-semibold text-ink-dim transition hover:border-red-500/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                  title={linkedIds.length <= 1 ? "ต้องมีอย่างน้อย 1 วิธี" : undefined}
                >
                  {isBusy ? "..." : "ยกเลิก"}
                </button>
              ) : p.kind === "email" ? (
                <button
                  onClick={() => setShowEmailForm((v) => !v)}
                  disabled={isBusy}
                  className="h-9 rounded-lg bg-brand-grad px-3 text-[12px] font-semibold text-white shadow-glow-sm transition hover:brightness-110 disabled:opacity-50"
                >
                  {showEmailForm ? "ปิดฟอร์ม" : "เชื่อมต่อ"}
                </button>
              ) : (
                <button
                  onClick={() =>
                    handleLink(p.kind as "google" | "facebook")
                  }
                  disabled={isBusy}
                  className="h-9 rounded-lg bg-brand-grad px-3 text-[12px] font-semibold text-white shadow-glow-sm transition hover:brightness-110 disabled:opacity-50"
                >
                  {isBusy ? "..." : "เชื่อมต่อ"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {showEmailForm && !linkedIds.includes("password") && (
        <EmailLinkForm
          busy={busyKind === "email"}
          onSubmit={async (email, password) => {
            await runWithBusy("email", async (m) => {
              await m.linkEmailPassword(email, password);
              setInfo("เชื่อมต่อ Email + รหัสผ่าน แล้ว");
              setShowEmailForm(false);
            });
          }}
        />
      )}
    </div>
  );
}

function EmailLinkForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const ok = email.trim().length > 0 && password.length >= 6 && !busy;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(email, password);
      }}
      className="mt-2.5 space-y-2 rounded-2xl border border-line/60 bg-bg-card/40 p-3.5"
    >
      <input
        type="email"
        autoComplete="email"
        placeholder="อีเมล"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="h-10 w-full rounded-lg border border-line/70 bg-bg-card/60 px-3 text-[14px] text-ink placeholder:text-ink-mute focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-brand/20"
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="รหัสผ่าน (อย่างน้อย 6 ตัว)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-10 w-full rounded-lg border border-line/70 bg-bg-card/60 px-3 text-[14px] text-ink placeholder:text-ink-mute focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-brand/20"
      />
      <button
        type="submit"
        disabled={!ok}
        className="h-10 w-full rounded-lg bg-brand-grad text-[13px] font-semibold text-white shadow-glow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "กำลังเชื่อมต่อ..." : "เชื่อมต่อ Email + รหัสผ่าน"}
      </button>
    </form>
  );
}

function ProviderGlyph({ kind }: { kind: "google" | "facebook" | "email" }) {
  if (kind === "google") {
    return (
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.44c-.28 1.48-1.12 2.73-2.39 3.57v2.97h3.85c2.26-2.09 3.59-5.17 3.59-8.78Z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.85-2.97c-1.07.72-2.44 1.16-4.08 1.16-3.14 0-5.8-2.12-6.75-4.97H1.27v3.07A11.997 11.997 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.25 14.31a7.21 7.21 0 0 1-.38-2.31c0-.8.14-1.58.38-2.31V6.62H1.27a12 12 0 0 0 0 10.76l3.98-3.07Z" />
        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.59 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.69 1.27 6.62l3.98 3.07C6.2 6.87 8.86 4.75 12 4.75Z" />
      </svg>
    );
  }
  if (kind === "facebook") {
    return (
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
        <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.03 4.39 11.02 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z" />
      </svg>
    );
  }
  return (
    <div className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-grad text-white">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    </div>
  );
}

function OfflineSection() {
  const [cacheCount, setCacheCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [justCleared, setJustCleared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const set = await getCachedUrlSet();
        if (!cancelled) setCacheCount(set.size);
      } catch {
        if (!cancelled) setCacheCount(null);
      }
    }
    refresh();
    const unsub = subscribeCacheChange(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  async function handleClear() {
    if (busy) return;
    // No native confirm() in PWAs feels nicer here, but a single-click wipe
    // is too dangerous given users may have hundreds of cached sheets they
    // viewed offline. Use confirm() — it's a hard primitive but matches the
    // weight of the action.
    if (!window.confirm("ล้าง cache รูปคอร์ดออฟไลน์ทั้งหมด?")) return;
    setBusy(true);
    try {
      await clearImageCache();
      setJustCleared(true);
      window.setTimeout(() => setJustCleared(false), 1800);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader>ข้อมูลออฟไลน์</SectionHeader>
      <div className="rounded-2xl border border-line/60 bg-bg-card/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink">
              รูปคอร์ดที่ cache ไว้
            </div>
            <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-mute">
              เปิดเพลงไหนแล้วจะดูได้แม้ไม่มีเน็ต
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-[20px] font-bold leading-none text-ink tabular-nums">
              {cacheCount == null ? "—" : cacheCount.toLocaleString()}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              รูป
            </div>
          </div>
        </div>
        <button
          onClick={handleClear}
          disabled={busy || cacheCount === 0}
          className="mt-3.5 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-line/70 bg-bg-soft text-[13px] font-semibold text-ink-dim transition hover:border-brand/40 hover:text-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {justCleared ? (
            <>
              <CheckIcon className="size-4" />
              ล้างแล้ว
            </>
          ) : busy ? (
            "กำลังล้าง..."
          ) : (
            "ล้าง cache"
          )}
        </button>
      </div>
    </div>
  );
}

function providerName(id: string | null): string | null {
  if (!id) return null;
  if (id.startsWith("google")) return "Google";
  if (id.startsWith("facebook")) return "Facebook";
  if (id === "password") return "Email";
  return id;
}
