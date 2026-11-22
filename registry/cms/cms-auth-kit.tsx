// agent-cms registry: cms-auth-kit (0.16.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Parts the sign-in screens share: passkeys in the browser (WebAuthn JSON ↔
// ArrayBuffer), the "confirm it is you" dialog that sensitive actions open
// when the server answers `reauth_required`, a password box with show/hide
// and a strength hint, and the centred frame of the sign-in pages.
"use client";

import * as React from "react";
import { Eye, EyeOff, Fingerprint, KeyRound } from "lucide-react";
import { isCmsRemoteError } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { DIALOG, StatusText } from "./cms-parts";
import { useCms } from "./use-cms";

// ── passkeys in the browser ──────────────────────────────────────────────────

const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64url = (buf: ArrayBuffer | null | undefined) => {
  if (!buf) return null;
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** True when this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

type Json = Record<string, unknown>;

/** Asks the browser for a passkey (sign-in or confirming it is you). Null when the person cancels. */
export async function getPasskey(publicKey: Json): Promise<Json | null> {
  const o = { ...publicKey, challenge: fromB64url(String(publicKey.challenge)) } as Json;
  if (Array.isArray(publicKey.allowCredentials)) o.allowCredentials = (publicKey.allowCredentials as Json[]).map((c) => ({ ...c, id: fromB64url(String(c.id)) }));
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({ publicKey: o as unknown as PublicKeyCredentialRequestOptions })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) return null;
    throw e;
  }
  if (!cred) return null;
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature), userHandle: toB64url(r.userHandle) },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: (cred as PublicKeyCredential & { authenticatorAttachment?: string | null }).authenticatorAttachment ?? null,
  };
}

/** Makes a new passkey. Null when the person cancels. */
export async function createPasskey(publicKey: Json): Promise<Json | null> {
  const user = publicKey.user as Json;
  const o = {
    ...publicKey,
    challenge: fromB64url(String(publicKey.challenge)),
    user: { ...user, id: fromB64url(String(user.id)) },
    excludeCredentials: ((publicKey.excludeCredentials as Json[] | undefined) ?? []).map((c) => ({ ...c, id: fromB64url(String(c.id)) })),
  };
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({ publicKey: o as unknown as PublicKeyCredentialCreationOptions })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) return null;
    if (e instanceof DOMException && e.name === "InvalidStateError") throw Object.assign(new Error("already"), { code: "passkey_exists" });
    throw e;
  }
  if (!cred) return null;
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), transports: r.getTransports?.() ?? [] },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

// ── confirm it is you ────────────────────────────────────────────────────────

/**
 * `run(fn)`: runs `fn`; when the server wants the person to confirm it is
 * them (`reauth_required`), asks for the password or a passkey and runs
 * `fn` once more. Render `dialog` somewhere in the screen.
 */
export function useReauth(): { run: <T>(fn: () => Promise<T>) => Promise<T>; dialog: React.ReactNode } {
  const { client, t } = useCms();
  const [waiting, setWaiting] = React.useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const hasPasskey = passkeysSupported();

  const ask = () =>
    new Promise<boolean>((resolve) => {
      setPassword("");
      setError(null);
      setWaiting({ resolve });
    });
  const done = (ok: boolean) => {
    waiting?.resolve(ok);
    setWaiting(null);
  };

  const run = React.useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (!(isCmsRemoteError(e) && e.code === "reauth_required")) throw e;
        if (!(await ask())) throw e;
        return fn();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  async function withPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.auth.reauth(password);
      done(true);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  async function withPasskey() {
    setBusy(true);
    setError(null);
    try {
      const o = await client.auth.passkeyOptions("reauth");
      const cred = await getPasskey(o.publicKey);
      if (!cred) return;
      await client.auth.passkeyVerify(o.challengeId, cred);
      done(true);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={!!waiting} onOpenChange={(o) => !o && !busy && done(false)}>
      <DialogContent className={DIALOG.sm}>
        <form onSubmit={withPassword} className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>{t("reauth_title")}</DialogTitle>
            <DialogDescription>{t("reauth_text")}</DialogDescription>
          </DialogHeader>
          {hasPasskey ? (
            <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={() => void withPasskey()}>
              <Fingerprint aria-hidden className="h-4 w-4" />
              {t("reauth_passkey")}
            </Button>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="cms-reauth-pw">{t("auth_password")}</Label>
            <PasswordInput id="cms-reauth-pw" autoComplete="current-password" autoFocus={!hasPasskey} value={password} onChange={setPassword} />
          </div>
          <StatusText tone="error" className="text-sm">
            {error ?? ""}
          </StatusText>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => done(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? t("saving_now") : t("reauth_ok")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { run, dialog };
}

// ── password box ─────────────────────────────────────────────────────────────

export function PasswordInput({ id, value, onChange, autoComplete, autoFocus, invalid, describedBy, required }: { id: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password"; autoFocus?: boolean; invalid?: boolean; describedBy?: string; required?: boolean }) {
  const { t } = useCms();
  const [shown, setShown] = React.useState(false);
  return (
    <div className="relative">
      <Input id={id} type={shown ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} required={required} spellCheck={false} autoCapitalize="none" value={value} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} className="pr-10" />
      <button type="button" aria-label={shown ? t("auth_hide_password") : t("auth_show_password")} aria-pressed={shown} onClick={() => setShown((v) => !v)} className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {shown ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** 0–4, a rough local guess; the server makes the real decision (length, common passwords, your email). */
export function passwordScore(pw: string, email = ""): number {
  if (!pw) return 0;
  if (pw.length < 12) return 1;
  const user = email.split("@")[0]?.toLowerCase();
  if (user && user.length > 2 && pw.toLowerCase().includes(user)) return 1;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  if (unique < 6) return 1;
  return Math.min(4, 1 + (pw.length >= 16 ? 2 : 1) + (kinds >= 3 ? 1 : 0));
}

export function PasswordMeter({ value, email, id }: { value: string; email?: string; id?: string }) {
  const { t } = useCms();
  const n = passwordScore(value, email);
  const label = !value ? t("auth_pw_rule") : n <= 1 ? t("auth_pw_weak") : n === 2 ? t("auth_pw_ok") : n === 3 ? t("auth_pw_good") : t("auth_pw_strong");
  return (
    <div id={id} className="grid gap-1.5">
      <div aria-hidden className="grid grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1 rounded-full bg-muted", value && i <= n && (n <= 1 ? "bg-destructive" : n === 2 ? "bg-amber-500" : "bg-emerald-600"))} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

// ── frame ────────────────────────────────────────────────────────────────────

/** The centred card the sign-in pages sit in. */
export function AuthFrame({ title, text, children, footer, appName = "agent-cms" }: { title: string; text?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; appName?: string }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
            {appName.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-sm font-medium">{appName}</span>
        </div>
        <section className="rounded-xl border bg-background p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {text ? <div className="mt-1.5 text-sm text-muted-foreground">{text}</div> : null}
          <div className="mt-6 grid gap-4">{children}</div>
        </section>
        {footer ? <div className="mt-5 text-center text-xs text-muted-foreground">{footer}</div> : null}
      </div>
    </main>
  );
}

export function OrLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export { KeyRound };
