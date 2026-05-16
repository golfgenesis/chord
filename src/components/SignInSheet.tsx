import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store";
import { XIcon } from "./icons";

// Dynamic import so the auth SDK is only fetched when this sheet opens.
type AuthMod = typeof import("../lib/auth");
type PendingLink = import("../lib/auth").PendingLink;
let authModCache: AuthMod | null = null;
function loadAuthMod(): Promise<AuthMod> {
  if (authModCache) return Promise.resolve(authModCache);
  return import("../lib/auth").then((m) => {
    authModCache = m;
    return m;
  });
}

type Mode = "signIn" | "signUp" | "forgot";

interface Props {
  onClose: () => void;
}

export function SignInSheet({ onClose }: Props) {
  const user = useApp((s) => s.user);
  const [pending, setPending] = useState<PendingLink | null>(null);
  // After a sign-in that successfully linked the pending credential, briefly
  // surface a confirmation toast before auto-dismissing the sheet.
  const [linkedJustNow, setLinkedJustNow] = useState(false);

  // When the user state flips to a real user, check if we have a pending
  // credential to link. If so, link it before dismissing.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const mod = await loadAuthMod();
      if (mod.getPendingLink()) {
        const ok = await mod.consumePendingLink();
        if (cancelled) return;
        if (ok) {
          setPending(null);
          setLinkedJustNow(true);
          window.setTimeout(() => {
            if (!cancelled) onClose();
          }, 1400);
          return;
        }
      }
      if (!cancelled) onClose();
    })();
    return () => {
      cancelled = true;
    };
  }, [user, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-strong w-full max-w-md animate-slide-up rounded-3xl border border-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <SheetBody
          onClose={onClose}
          pending={pending}
          setPending={setPending}
          linkedJustNow={linkedJustNow}
        />
      </div>
    </div>,
    document.body,
  );
}

function SheetBody({
  onClose,
  pending,
  setPending,
  linkedJustNow,
}: {
  onClose: () => void;
  pending: PendingLink | null;
  setPending: (v: PendingLink | null) => void;
  linkedJustNow: boolean;
}) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [busy, setBusy] = useState<null | "google" | "facebook" | "email">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function withBusy(
    kind: "google" | "facebook" | "email",
    fn: () => Promise<unknown>,
  ) {
    setError(null);
    setInfo(null);
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      const mod = await loadAuthMod();
      // If the error was an account-exists conflict, auth.ts has already
      // stashed the pending credential. Surface a banner so the user knows
      // what to do next instead of just showing the raw error message.
      const p = mod.getPendingLink();
      if (p) setPending(p);
      setError(mod.describeAuthError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-[20px] font-semibold leading-[1.3] tracking-tight text-ink">
            {mode === "signUp"
              ? "สมัครบัญชีใหม่"
              : mode === "forgot"
                ? "ลืมรหัสผ่าน"
                : "เข้าสู่ระบบ"}
          </h3>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-mute">
            เพื่อเก็บเพลงโปรด / playlist ข้ามเครื่อง ไม่ login ก็ยังใช้แอปได้ปกติ
          </p>
        </div>
        <button
          onClick={onClose}
          className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-mute transition hover:bg-bg-hover hover:text-ink"
          aria-label="ปิด"
        >
          <XIcon className="size-[18px]" />
        </button>
      </div>

      {linkedJustNow && (
        <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-3 text-[13px] leading-[1.5] text-emerald-300">
          เชื่อมต่อบัญชีสำเร็จ — ครั้งหน้า login ด้วยวิธีไหนก็ได้
        </div>
      )}
      {pending && !linkedJustNow && (
        <PendingLinkBanner
          pending={pending}
          onDismiss={() => setPending(null)}
        />
      )}
      {error && !pending && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] leading-[1.5] text-red-300">
          {error}
        </div>
      )}
      {info && (
        <div className="mb-4 rounded-xl border border-brand/30 bg-brand-soft px-3.5 py-2.5 text-[13px] leading-[1.5] text-brand">
          {info}
        </div>
      )}

      {mode !== "forgot" && (
        <>
          <div className="space-y-2.5">
            <ProviderButton
              kind="google"
              busy={busy === "google"}
              disabled={busy != null}
              onClick={() =>
                withBusy("google", async () => {
                  const m = await loadAuthMod();
                  await m.signInWithGoogle();
                })
              }
            />
            <ProviderButton
              kind="facebook"
              busy={busy === "facebook"}
              disabled={busy != null}
              onClick={() =>
                withBusy("facebook", async () => {
                  const m = await loadAuthMod();
                  await m.signInWithFacebook();
                })
              }
            />
          </div>

          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-ink-mute">
            <div className="h-px flex-1 bg-line/60" />
            หรือ
            <div className="h-px flex-1 bg-line/60" />
          </div>
        </>
      )}

      <EmailForm
        mode={mode}
        busy={busy === "email"}
        disabledAll={busy != null}
        onSubmit={async (email, password) => {
          await withBusy("email", async () => {
            const m = await loadAuthMod();
            if (mode === "signIn") {
              await m.signInWithEmail(email, password);
            } else if (mode === "signUp") {
              await m.signUpWithEmail(email, password);
            } else {
              await m.sendResetEmail(email);
              setInfo(`ส่งลิงก์รีเซ็ตไปที่ ${email} แล้ว — เช็คเมลด้วย`);
            }
          });
        }}
      />

      <div className="mt-5 space-y-2 text-center text-[13px] text-ink-mute">
        {mode === "signIn" && (
          <>
            <div>
              ยังไม่มีบัญชี?{" "}
              <button
                className="font-semibold text-brand hover:underline"
                onClick={() => {
                  setMode("signUp");
                  setError(null);
                  setInfo(null);
                }}
              >
                สมัครใหม่
              </button>
            </div>
            <div>
              <button
                className="text-ink-dim hover:text-ink hover:underline"
                onClick={() => {
                  setMode("forgot");
                  setError(null);
                  setInfo(null);
                }}
              >
                ลืมรหัสผ่าน?
              </button>
            </div>
          </>
        )}
        {mode === "signUp" && (
          <div>
            มีบัญชีอยู่แล้ว?{" "}
            <button
              className="font-semibold text-brand hover:underline"
              onClick={() => {
                setMode("signIn");
                setError(null);
                setInfo(null);
              }}
            >
              เข้าสู่ระบบ
            </button>
          </div>
        )}
        {mode === "forgot" && (
          <div>
            <button
              className="font-semibold text-brand hover:underline"
              onClick={() => {
                setMode("signIn");
                setError(null);
                setInfo(null);
              }}
            >
              ← กลับไปเข้าสู่ระบบ
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function EmailForm({
  mode,
  busy,
  disabledAll,
  onSubmit,
}: {
  mode: Mode;
  busy: boolean;
  disabledAll: boolean;
  onSubmit: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function canSubmit() {
    if (busy || disabledAll) return false;
    if (!email.trim()) return false;
    if (mode !== "forgot" && password.length < 6) return false;
    return true;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit()) onSubmit(email, password);
      }}
      className="space-y-2.5"
    >
      <input
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="อีเมล"
        className="h-12 w-full rounded-xl border border-line/80 bg-bg-card/60 px-4 text-[15px] text-ink placeholder:text-ink-mute focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-4 focus:ring-brand/15"
      />
      {mode !== "forgot" && (
        <input
          type="password"
          autoComplete={mode === "signUp" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="รหัสผ่าน (อย่างน้อย 6 ตัว)"
          className="h-12 w-full rounded-xl border border-line/80 bg-bg-card/60 px-4 text-[15px] text-ink placeholder:text-ink-mute focus:border-brand/60 focus:bg-bg-card focus:outline-none focus:ring-4 focus:ring-brand/15"
        />
      )}
      <button
        type="submit"
        disabled={!canSubmit()}
        className="h-12 w-full rounded-xl bg-brand-grad text-[15px] font-semibold text-white shadow-glow-sm ring-1 ring-white/10 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? "กำลังดำเนินการ..."
          : mode === "signUp"
            ? "สมัครและเข้าสู่ระบบ"
            : mode === "forgot"
              ? "ส่งลิงก์รีเซ็ต"
              : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}

function PendingLinkBanner({
  pending,
  onDismiss,
}: {
  pending: PendingLink;
  onDismiss: () => void;
}) {
  // Translate Firebase's provider IDs into a Thai instruction tailored to
  // the existing method. Each Firebase auth method string lives in
  // `pending.existingMethods` — common values: "password", "google.com",
  // "facebook.com".
  const methods = pending.existingMethods;
  const has = (m: string) => methods.includes(m);
  const lines: string[] = [];
  if (has("google.com")) lines.push("• กดปุ่ม Google ด้านล่าง");
  if (has("facebook.com")) lines.push("• กดปุ่ม Facebook ด้านล่าง");
  if (has("password")) lines.push(`• กรอกอีเมล (${pending.email}) + รหัสผ่านเดิมด้านล่าง`);

  const attempted =
    pending.providerLabel === "google"
      ? "Google"
      : pending.providerLabel === "facebook"
        ? "Facebook"
        : "Email";

  return (
    <div className="mb-4 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[13px] leading-[1.5] text-amber-200">
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold">
          อีเมล {pending.email} เคยสมัครด้วยวิธีอื่นแล้ว
        </div>
        <button
          onClick={onDismiss}
          className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-amber-300/70 transition hover:bg-amber-500/20 hover:text-amber-200"
          aria-label="ปิด"
        >
          <XIcon className="size-[14px]" />
        </button>
      </div>
      <div className="text-amber-100/90">
        เข้าด้วยวิธีเดิมก่อน แล้ว {attempted} จะถูกเชื่อมต่อให้อัตโนมัติ —
        ครั้งหน้าใช้วิธีไหน login ก็ได้
      </div>
      {lines.length > 0 && (
        <div className="space-y-0.5 pt-0.5 text-amber-100/80">
          {lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderButton({
  kind,
  busy,
  disabled,
  onClick,
}: {
  kind: "google" | "facebook";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label =
    kind === "google" ? "ต่อด้วย Google" : "ต่อด้วย Facebook";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-line/80 bg-bg-card/60 text-[15px] font-semibold text-ink transition hover:border-brand/40 hover:bg-bg-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {kind === "google" ? <GoogleIcon /> : <FacebookIcon />}
      <span>{busy ? "กำลังเปิด..." : label}</span>
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.44c-.28 1.48-1.12 2.73-2.39 3.57v2.97h3.85c2.26-2.09 3.59-5.17 3.59-8.78Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.85-2.97c-1.07.72-2.44 1.16-4.08 1.16-3.14 0-5.8-2.12-6.75-4.97H1.27v3.07A11.997 11.997 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.25 14.31a7.21 7.21 0 0 1-.38-2.31c0-.8.14-1.58.38-2.31V6.62H1.27a12 12 0 0 0 0 10.76l3.98-3.07Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.59 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.69 1.27 6.62l3.98 3.07C6.2 6.87 8.86 4.75 12 4.75Z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path
        fill="#1877F2"
        d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07c0 6.03 4.39 11.02 10.13 11.93v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z"
      />
    </svg>
  );
}
