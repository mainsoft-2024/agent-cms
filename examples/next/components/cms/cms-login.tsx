// agent-cms registry: cms-login (0.16.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// The pages of the CMS's own sign-in (`createAuth`), outside the admin frame:
//   <CmsLogin>      passkey, single sign-on, email + password, then the 6-digit code or a recovery code
//   <CmsSetup>      the first admin, with the one-time code the server printed in its terminal
//   <CmsInvite>     accepting an invitation (link `…/invite#token`): name and a password, or a passkey only
//   <CmsReset>      asking for a reset link, and setting a new password (`…/reset#token`)
// Each calls `onDone(next)` once the person is signed in; send them on with your router.
"use client";

import * as React from "react";
import { ArrowLeft, Building2, Fingerprint, LifeBuoy, Lock, Mail, ShieldCheck } from "lucide-react";
import { isCmsRemoteError, type AuthState } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AuthFrame, OrLine, PasswordInput, PasswordMeter, createPasskey, getPasskey, passkeysSupported } from "./cms-auth-kit";
import { errorMessage } from "./cms-messages";
import { StatusText } from "./cms-parts";
import { useCms } from "./use-cms";

export interface CmsAuthPageProps {
  /** Where to go after signing in (from `?next=`). Default: the admin. */
  next?: string;
  /** Called once signed in, with where to go. Default `location.assign`. */
  onDone?: (next: string) => void;
  /** Links between the pages. Defaults follow the admin path the server reports. */
  hrefs?: { login?: string; reset?: string };
  appName?: string;
  className?: string;
}

const go = (p: CmsAuthPageProps, adminPath: string, fallback?: string) => {
  // Only paths of this site: `?next=https://evil.example` goes to the admin instead.
  const next = p.next && /^\/(?!\/)/.test(p.next) ? p.next : fallback ?? adminPath;
  (p.onDone ?? ((h: string) => window.location.assign(h)))(next);
};
const hashToken = () => (typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, "")));

function useAuthState() {
  const { client } = useCms();
  const [state, setState] = React.useState<AuthState | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const load = React.useCallback(() => {
    setError(null);
    client.auth.state().then(setState, setError);
  }, [client]);
  React.useEffect(load, [load]);
  return { state, error, reload: load };
}

function Loading({ appName }: { appName?: string }) {
  const { t } = useCms();
  return (
    <AuthFrame title={t("loading")} appName={appName}>
      <div aria-hidden className="grid gap-3">
        <div className="h-9 animate-pulse rounded-md bg-muted" />
        <div className="h-9 animate-pulse rounded-md bg-muted" />
      </div>
    </AuthFrame>
  );
}
function Broken({ error, retry, appName }: { error: unknown; retry: () => void; appName?: string }) {
  const { t } = useCms();
  return (
    <AuthFrame title={t("auth_unavailable")} text={errorMessage(error, t)} appName={appName}>
      <Button type="button" variant="outline" onClick={retry}>
        {t("retry")}
      </Button>
    </AuthFrame>
  );
}

// ── sign in ──────────────────────────────────────────────────────────────────

export function CmsLogin(props: CmsAuthPageProps) {
  const { client, t } = useCms();
  const { state, error, reload } = useAuthState();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState<null | "password" | "passkey" | "sso">(null);
  const [problem, setProblem] = React.useState<{ text: string; locked?: boolean } | null>(null);
  const [ticket, setTicket] = React.useState<string | null>(null);
  const passkeys = passkeysSupported();

  // Errors single sign-on sends back in the address (`?error=oidc_domain&domain=…`).
  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get("error");
    if (!code) return;
    const p = Object.fromEntries(q.entries());
    setProblem({ text: code === "oidc_domain" ? t("auth_oidc_domain", { domain: p.domain ?? "" }) : code === "oidc_not_invited" ? t("auth_oidc_not_invited", { email: p.email ?? "" }) : t("auth_oidc_failed", { reason: p.reason ?? "" }) });
  }, [t]);

  React.useEffect(() => {
    if (state?.setup) window.location.replace(`${state.adminPath}/setup`);
    else if (state?.user) go(props, state.adminPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (error) return <Broken error={error} retry={reload} appName={props.appName} />;
  if (!state || state.setup || state.user) return <Loading appName={props.appName} />;
  const resetHref = props.hrefs?.reset ?? `${state.adminPath}/reset`;

  if (ticket) return <SecondStep ticket={ticket} props={props} adminPath={state.adminPath} onBack={() => (setTicket(null), setPassword(""))} />;

  const failed = (e: unknown) => {
    if (isCmsRemoteError(e) && e.code === "login_locked") setProblem({ text: errorMessage(e, t), locked: true });
    else if (isCmsRemoteError(e) && e.code === "login_failed") setProblem({ text: t("auth_wrong") });
    else setProblem({ text: errorMessage(e, t) });
  };

  async function withPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy("password");
    setProblem(null);
    try {
      const r = await client.auth.login(email.trim(), password);
      if ("mfa" in r) setTicket(r.ticket);
      else go(props, state!.adminPath, r.mfaSetup ? `${state!.adminPath}/account#two-step` : undefined);
    } catch (err) {
      failed(err);
      setPassword("");
    } finally {
      setBusy(null);
    }
  }
  async function withPasskey() {
    setBusy("passkey");
    setProblem(null);
    try {
      const o = await client.auth.passkeyOptions("login");
      const cred = await getPasskey(o.publicKey);
      if (!cred) return;
      const r = await client.auth.passkeyVerify(o.challengeId, cred);
      if ("ok" in r) go(props, state!.adminPath, r.mfaSetup ? `${state!.adminPath}/account#two-step` : undefined);
    } catch (err) {
      if (isCmsRemoteError(err) && err.code === "passkey_unknown") setProblem({ text: t("auth_passkey_unknown") });
      else failed(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <AuthFrame
      appName={props.appName}
      title={t("auth_login_title")}
      text={t("auth_login_text")}
      footer={
        <span className="inline-flex items-center gap-1.5">
          <Lock aria-hidden className="h-3 w-3" />
          {t("auth_invite_only")}
        </span>
      }
    >
      {problem ? (
        <div role="alert" className={cn("rounded-md border px-3 py-2 text-sm [overflow-wrap:anywhere]", problem.locked ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100" : "border-destructive/40 bg-destructive/5 text-destructive")}>
          {problem.text}
        </div>
      ) : null}
      {passkeys ? (
        <Button type="button" className="h-10 gap-2" disabled={!!busy} onClick={() => void withPasskey()}>
          <Fingerprint aria-hidden className="h-4 w-4" />
          {busy === "passkey" ? t("auth_waiting_passkey") : t("auth_with_passkey")}
        </Button>
      ) : null}
      {state.methods.sso ? (
        <a href={client.auth.ssoUrl(props.next)} onClick={() => setBusy("sso")} aria-disabled={!!busy || undefined} className={cn("inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", busy && "pointer-events-none opacity-60")}>
          <Building2 aria-hidden className="h-4 w-4" />
          {t("auth_with_sso", { name: state.methods.sso.label })}
        </a>
      ) : null}
      {state.methods.password ? (
        <>
          {passkeys || state.methods.sso ? <OrLine label={t("auth_or_email")} /> : null}
          <form onSubmit={withPassword} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="cms-login-email">{t("auth_email")}</Label>
              <Input id="cms-login-email" type="email" autoComplete="username webauthn" inputMode="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="cms-login-pw">{t("auth_password")}</Label>
                <a href={resetHref} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {t("auth_forgot")}
                </a>
              </div>
              <PasswordInput id="cms-login-pw" autoComplete="current-password" required value={password} onChange={setPassword} />
            </div>
            <Button type="submit" variant={passkeys ? "outline" : "default"} className="h-10" disabled={!!busy || problem?.locked}>
              {busy === "password" ? t("auth_signing_in") : t("auth_sign_in")}
            </Button>
          </form>
        </>
      ) : null}
    </AuthFrame>
  );
}

/** The 6-digit code from the authenticator app, or a recovery code. */
function SecondStep({ ticket, props, adminPath, onBack }: { ticket: string; props: CmsAuthPageProps; adminPath: string; onBack: () => void }) {
  const { client, t } = useCms();
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [remember, setRemember] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLInputElement>(null);

  async function send(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.auth.mfa(recovery ? { ticket, recovery: value.trim(), remember } : { ticket, code: value, remember });
      go(props, adminPath, typeof r.recoveryLeft === "number" && r.recoveryLeft <= 3 ? `${adminPath}/account#two-step` : undefined);
    } catch (err) {
      if (isCmsRemoteError(err) && err.code === "mfa_ticket_invalid") return onBack();
      setError(isCmsRemoteError(err) && err.code === "mfa_invalid" ? t(recovery ? "auth_recovery_wrong" : "auth_code_wrong") : errorMessage(err, t));
      setCode("");
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      appName={props.appName}
      title={recovery ? t("auth_recovery_title") : t("auth_code_title")}
      text={recovery ? t("auth_recovery_text") : t("auth_code_text")}
      footer={
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
          <ArrowLeft aria-hidden className="h-3 w-3" />
          {t("auth_other_account")}
        </button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(code);
        }}
        className="grid gap-4"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="cms-mfa-code">{recovery ? t("auth_recovery_code") : t("auth_code")}</Label>
          <Input
            ref={ref}
            id="cms-mfa-code"
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? "text" : "numeric"}
            pattern={recovery ? undefined : "[0-9]*"}
            maxLength={recovery ? 20 : 6}
            spellCheck={false}
            value={code}
            aria-invalid={!!error || undefined}
            aria-describedby="cms-mfa-error"
            className={cn("h-11 font-mono", !recovery && "text-center text-lg tracking-[0.5em]")}
            onChange={(e) => {
              const v = recovery ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              // Six digits in: sent without pressing anything (also when pasted).
              if (!recovery && v.length === 6) void send(v);
            }}
          />
          <StatusText id="cms-mfa-error" tone="error" className="text-sm">
            {error ?? ""}
          </StatusText>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
          {t("auth_remember")}
        </label>
        <Button type="submit" className="h-10" disabled={busy || (!recovery && code.length !== 6) || (recovery && !code.trim())}>
          {busy ? t("auth_signing_in") : t("auth_confirm")}
        </Button>
        <button type="button" onClick={() => (setRecovery((r) => !r), setCode(""), setError(null))} className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          <LifeBuoy aria-hidden className="h-3.5 w-3.5" />
          {recovery ? t("auth_use_code") : t("auth_use_recovery")}
        </button>
      </form>
    </AuthFrame>
  );
}

// ── first admin ──────────────────────────────────────────────────────────────

export function CmsSetup(props: CmsAuthPageProps) {
  const { client, t } = useCms();
  const { state, error, reload } = useAuthState();
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (state && !state.setup) window.location.replace(props.hrefs?.login ?? `${state.adminPath}/login`);
  }, [state, props.hrefs?.login]);
  if (error) return <Broken error={error} retry={reload} appName={props.appName} />;
  if (!state || !state.setup) return <Loading appName={props.appName} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await client.auth.setup({ code: code.trim(), email: email.trim(), name: name.trim() || undefined, password });
      go(props, state!.adminPath, `${state!.adminPath}/account#sign-in`);
    } catch (err) {
      setProblem(isCmsRemoteError(err) && err.code === "setup_invalid" ? t("auth_setup_code_wrong") : errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame appName={props.appName} title={t("auth_setup_title")} text={t("auth_setup_text")} footer={t("auth_setup_next")}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="cms-setup-code">{t("auth_setup_code")}</Label>
          <Input id="cms-setup-code" autoFocus autoComplete="off" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono tracking-widest" aria-describedby="cms-setup-code-hint" />
          <p id="cms-setup-code-hint" className="text-xs text-muted-foreground">
            {t("auth_setup_code_hint")}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cms-setup-name">{t("auth_name")}</Label>
          <Input id="cms-setup-name" autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cms-setup-email">{t("auth_email")}</Label>
          <Input id="cms-setup-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cms-setup-pw">{t("auth_password")}</Label>
          <PasswordInput id="cms-setup-pw" autoComplete="new-password" required value={password} onChange={setPassword} describedBy="cms-setup-meter" />
          <PasswordMeter id="cms-setup-meter" value={password} email={email} />
        </div>
        <StatusText tone="error" className="text-sm [overflow-wrap:anywhere]">
          {problem ?? ""}
        </StatusText>
        <Button type="submit" className="h-10 gap-2" disabled={busy || !code.trim() || !email.trim() || password.length < 12}>
          <ShieldCheck aria-hidden className="h-4 w-4" />
          {busy ? t("saving_now") : t("auth_setup_create")}
        </Button>
      </form>
    </AuthFrame>
  );
}

// ── accept an invitation ─────────────────────────────────────────────────────

export function CmsInvite(props: CmsAuthPageProps) {
  const { client, t, locale } = useCms();
  const { state } = useAuthState();
  const [token] = React.useState(hashToken);
  const [invite, setInvite] = React.useState<{ email: string; invitedBy: string | null; isAdmin: boolean; exists: boolean } | null>(null);
  const [bad, setBad] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const adminPath = state?.adminPath ?? "/admin";

  React.useEffect(() => {
    if (!token) return setBad(t("auth_invite_missing"));
    client.auth.invite(token).then(setInvite, (e) => setBad(isCmsRemoteError(e) && e.code === "invite_invalid" ? t("auth_invite_used") : errorMessage(e, t)));
  }, [client, token, t]);

  if (bad)
    return (
      <AuthFrame appName={props.appName} title={t("auth_invite_bad_title")} text={bad}>
        <a href={props.hrefs?.login ?? `${adminPath}/login`} className="text-sm underline underline-offset-2">
          {t("auth_to_login")}
        </a>
      </AuthFrame>
    );
  if (!invite) return <Loading appName={props.appName} />;

  async function accept(withPassword: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      await client.auth.acceptInvite(token, { name: name.trim() || undefined, password: withPassword ? password : undefined });
      // Remove the token from the address bar and history.
      window.history.replaceState(null, "", window.location.pathname);
      if (!withPassword) {
        const o = await client.auth.passkeyOptions("register");
        const cred = await createPasskey(o.publicKey);
        if (!cred) {
          setProblem(t("auth_passkey_cancelled_invite"));
          return go(props, adminPath, `${adminPath}/account#sign-in`);
        }
        await client.auth.passkeyVerify(o.challengeId, cred, t("auth_passkey_default_label"));
      }
      go(props, adminPath);
    } catch (err) {
      setProblem(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame appName={props.appName} title={t("auth_invite_title")} text={invite.invitedBy ? t(invite.isAdmin ? "auth_invite_text_admin" : "auth_invite_text", { who: invite.invitedBy }) : t("auth_invite_text_plain")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void accept(true);
        }}
        className="grid gap-4"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="cms-inv-email">{t("auth_email")}</Label>
          <Input id="cms-inv-email" value={invite.email} readOnly autoComplete="username" className="bg-muted/50" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cms-inv-name">{t("auth_name")}</Label>
          <Input id="cms-inv-name" autoFocus autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        {state?.methods.password !== false ? (
          <div className="grid gap-1.5">
            <Label htmlFor="cms-inv-pw">{t("auth_password")}</Label>
            <PasswordInput id="cms-inv-pw" autoComplete="new-password" value={password} onChange={setPassword} describedBy="cms-inv-meter" />
            <PasswordMeter id="cms-inv-meter" value={password} email={invite.email} />
          </div>
        ) : null}
        <StatusText tone="error" className="text-sm [overflow-wrap:anywhere]">
          {problem ?? ""}
        </StatusText>
        {state?.methods.password !== false ? (
          <Button type="submit" className="h-10" disabled={busy || password.length < 12}>
            {busy ? t("saving_now") : t("auth_invite_start")}
          </Button>
        ) : null}
        {passkeysSupported() ? (
          <>
            {state?.methods.password !== false ? <OrLine label={t("auth_or")} /> : null}
            <Button type="button" variant="outline" className="h-10 gap-2" disabled={busy} onClick={() => void accept(false)}>
              <Fingerprint aria-hidden className="h-4 w-4" />
              {t("auth_invite_passkey")}
            </Button>
          </>
        ) : null}
        <p className="text-center text-xs text-muted-foreground">{t("auth_invite_locale", { lang: locale === "ko" ? "한국어" : "English" })}</p>
      </form>
    </AuthFrame>
  );
}

// ── forgot / new password ────────────────────────────────────────────────────

export function CmsReset(props: CmsAuthPageProps) {
  const { client, t } = useCms();
  const { state } = useAuthState();
  const [token] = React.useState(hashToken);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [sent, setSent] = React.useState<null | { mail: boolean }>(null);
  const [forEmail, setForEmail] = React.useState<string | null>(null);
  const [bad, setBad] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const adminPath = state?.adminPath ?? "/admin";
  const loginHref = props.hrefs?.login ?? `${adminPath}/login`;

  React.useEffect(() => {
    if (token) client.auth.resetInfo(token).then((r) => setForEmail(r.email), () => setBad(true));
  }, [client, token]);

  const back = (
    <a href={loginHref} className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
      <ArrowLeft aria-hidden className="h-3 w-3" />
      {t("auth_to_login")}
    </a>
  );

  if (token) {
    if (bad) return <AuthFrame appName={props.appName} title={t("auth_reset_bad_title")} text={t("auth_reset_bad")} footer={back}>{null}</AuthFrame>;
    if (!forEmail) return <Loading appName={props.appName} />;
    return (
      <AuthFrame appName={props.appName} title={t("auth_reset_new_title")} text={t("auth_reset_new_text", { email: forEmail })} footer={back}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setProblem(null);
            try {
              const r = await client.auth.reset(token, password);
              window.history.replaceState(null, "", window.location.pathname);
              if ("mfa" in r) window.location.assign(loginHref);
              else go(props, adminPath);
            } catch (err) {
              setProblem(errorMessage(err, t));
            } finally {
              setBusy(false);
            }
          }}
          className="grid gap-4"
        >
          <input type="email" autoComplete="username" value={forEmail} readOnly hidden />
          <div className="grid gap-1.5">
            <Label htmlFor="cms-reset-pw">{t("auth_new_password")}</Label>
            <PasswordInput id="cms-reset-pw" autoFocus autoComplete="new-password" value={password} onChange={setPassword} describedBy="cms-reset-meter" />
            <PasswordMeter id="cms-reset-meter" value={password} email={forEmail} />
          </div>
          <p className="text-xs text-muted-foreground">{t("auth_reset_ends_sessions")}</p>
          <StatusText tone="error" className="text-sm [overflow-wrap:anywhere]">
            {problem ?? ""}
          </StatusText>
          <Button type="submit" className="h-10" disabled={busy || password.length < 12}>
            {busy ? t("saving_now") : t("auth_reset_save")}
          </Button>
        </form>
      </AuthFrame>
    );
  }

  if (sent)
    return (
      <AuthFrame appName={props.appName} title={t("auth_reset_sent_title")} text={sent.mail ? t("auth_reset_sent", { email }) : t("auth_reset_no_mail")} footer={back}>
        <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-3 text-sm">
          <Mail aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{sent.mail ? t("auth_reset_sent_hint") : t("auth_reset_ask_admin")}</span>
        </div>
      </AuthFrame>
    );

  return (
    <AuthFrame appName={props.appName} title={t("auth_reset_title")} text={t("auth_reset_text")} footer={back}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(null);
          try {
            setSent(await client.auth.requestReset(email.trim()));
          } catch (err) {
            setProblem(errorMessage(err, t));
          } finally {
            setBusy(false);
          }
        }}
        className="grid gap-4"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="cms-reset-email">{t("auth_email")}</Label>
          <Input id="cms-reset-email" type="email" autoFocus autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <StatusText tone="error" className="text-sm">
          {problem ?? ""}
        </StatusText>
        <Button type="submit" className="h-10" disabled={busy || !email.trim()}>
          {busy ? t("saving_now") : t("auth_reset_send")}
        </Button>
      </form>
    </AuthFrame>
  );
}
