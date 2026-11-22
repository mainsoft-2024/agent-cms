// agent-cms registry: cms-account (0.16.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// "My account" for the CMS's own sign-in (`createAuth`): name, theme and
// language; passkeys (add, rename, remove); password; two-step sign-in with
// an authenticator app (QR code, then 10 recovery codes to keep); and the
// devices where you are signed in, each with its own sign-out. Changing how
// you sign in asks you to confirm it is you (password or passkey) first.
// Sections have ids (#profile, #sign-in, #two-step, #devices) to link to.
"use client";

import * as React from "react";
import { Check, Copy, Download, Fingerprint, KeyRound, Laptop, LogOut, Monitor, Moon, Pencil, ShieldCheck, Smartphone, Sun, Trash2 } from "lucide-react";
import type { AuthAccount, AuthDevice, AuthPasskey } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PasswordInput, PasswordMeter, createPasskey, passkeysSupported, useReauth } from "./cms-auth-kit";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, DIALOG, PageHeader, PersonMark, Segmented, StatusText, copyText, relativeTimeShort } from "./cms-parts";
import { applyTheme, useCms, type CmsTheme } from "./use-cms";

export function CmsAccount({ className, onLocale, onSignedOut }: { className?: string; /** The person picked a language; switch the admin's messages. */ onLocale?: (locale: "en" | "ko") => void; /** After signing out of this device. Default: reload. */ onSignedOut?: () => void }) {
  const { client, t, toast } = useCms();
  const [acc, setAcc] = React.useState<AuthAccount | null>(null);
  const [devices, setDevices] = React.useState<AuthDevice[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const reauth = useReauth();

  const load = React.useCallback(() => {
    setError(null);
    client.auth.account().then(setAcc, setError);
    client.auth.sessions().then(setDevices, () => setDevices([]));
  }, [client]);
  React.useEffect(load, [load]);
  // Opened from a link to a section (#two-step): scroll there once it is drawn.
  React.useEffect(() => {
    if (acc && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [acc]);

  const run = async <T,>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
    try {
      const r = await reauth.run(fn);
      if (done) toast(done, { tone: "ok" });
      return r;
    } catch (e) {
      // The browser's own refusals (wrong site, no authenticator) say what happened.
      const browser = e instanceof DOMException || (e as { code?: string })?.code === "passkey_exists";
      toast((e as { code?: string })?.code === "passkey_exists" ? t("account_pk_exists") : browser ? t("account_pk_browser", { reason: (e as Error).message }) : errorMessage(e, t), { tone: "error" });
      return null;
    }
  };

  if (error)
    return (
      <div className={cn("flex flex-col", className)}>
        <PageHeader title={t("account_title")} />
        <div className="flex items-center gap-3 px-4 py-6 md:px-6">
          <StatusText tone="error">{errorMessage(error, t)}</StatusText>
          <Button type="button" variant="outline" size="sm" onClick={load}>
            {t("retry")}
          </Button>
        </div>
      </div>
    );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <PageHeader title={t("account_title")} />
      <div className="flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
        {!acc ? (
          <div aria-label={t("loading")} className="grid gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <>
            {acc.mfaSetup ? (
              <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("account_mfa_required")}</span>
              </div>
            ) : null}
            <Profile acc={acc} onSaved={(user) => setAcc({ ...acc, user })} />
            <Appearance acc={acc} onLocale={onLocale} onSaved={(prefs) => setAcc({ ...acc, prefs })} />
            <Section id="sign-in" title={t("account_signin")} text={t("account_signin_text")}>
              <Passkeys list={acc.passkeys} run={run} onChange={(passkeys) => setAcc({ ...acc, passkeys, user: { ...acc.user, passkeys: passkeys.length } })} />
              <Password acc={acc} run={run} onChanged={load} />
            </Section>
            <TwoStep acc={acc} run={run} onChanged={load} />
            <Devices list={devices} run={run} onChanged={() => client.auth.sessions().then(setDevices)} onSignedOut={onSignedOut} />
          </>
        )}
      </div>
      {reauth.dialog}
    </div>
  );
}

type Run = <T>(fn: () => Promise<T>, done?: string) => Promise<T | null>;

function Section({ id, title, text, children, action }: { id: string; title: string; text?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 rounded-lg border">
      <header className="flex flex-wrap items-start gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={`${id}-h`} className="text-sm font-semibold">
            {title}
          </h2>
          {text ? <p className="text-xs text-muted-foreground">{text}</p> : null}
        </div>
        {action}
      </header>
      <div className="flex min-w-0 flex-col divide-y">{children}</div>
    </section>
  );
}

function Row({ icon, title, text, children }: { icon: React.ReactNode; title: React.ReactNode; text?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        {text ? <span className="text-xs text-muted-foreground">{text}</span> : null}
      </span>
      {children ? <span className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</span> : null}
    </div>
  );
}

function Profile({ acc, onSaved }: { acc: AuthAccount; onSaved: (u: AuthAccount["user"]) => void }) {
  const { client, t, toast } = useCms();
  const [name, setName] = React.useState(acc.user.name ?? "");
  const [busy, setBusy] = React.useState(false);
  const dirty = name.trim() !== (acc.user.name ?? "");
  return (
    <Section id="profile" title={t("account_profile")}>
      <form
        className="flex min-w-0 flex-wrap items-end gap-4 px-4 py-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onSaved((await client.auth.updateAccount({ name: name.trim() || null })).user);
            toast(t("saved"), { tone: "ok" });
          } catch (err) {
            toast(errorMessage(err, t), { tone: "error" });
          } finally {
            setBusy(false);
          }
        }}
      >
        <PersonMark id={acc.user.id} label={acc.user.name || acc.user.email} className="h-11 w-11 text-sm" />
        <div className="grid min-w-[12rem] flex-1 gap-1.5">
          <Label htmlFor="cms-acc-name">{t("auth_name")}</Label>
          <Input id="cms-acc-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid min-w-[12rem] flex-1 gap-1.5">
          <Label htmlFor="cms-acc-email">{t("auth_email")}</Label>
          <Input id="cms-acc-email" value={acc.user.email} readOnly className="bg-muted/50" aria-describedby="cms-acc-email-hint" />
        </div>
        <Button type="submit" disabled={busy || !dirty}>
          {busy ? t("saving_now") : t("save")}
        </Button>
        <p id="cms-acc-email-hint" className="basis-full text-xs text-muted-foreground">
          {acc.user.isAdmin ? t("account_is_admin") : acc.user.roles.length ? t("account_roles", { roles: acc.user.roles.map((r) => r.name).join(", ") }) : t("account_no_role")} · {t("account_email_fixed")}
        </p>
      </form>
    </Section>
  );
}

function Appearance({ acc, onSaved, onLocale }: { acc: AuthAccount; onSaved: (p: AuthAccount["prefs"]) => void; onLocale?: (l: "en" | "ko") => void }) {
  const { client, t, locale } = useCms();
  const [theme, setTheme] = React.useState<CmsTheme>(acc.prefs.theme ?? "system");
  const save = (prefs: AuthAccount["prefs"]) => void client.auth.updateAccount({ prefs: { ...acc.prefs, ...prefs } }).then((r) => onSaved(r.prefs), () => undefined);
  return (
    <Section id="appearance" title={t("account_look")}>
      <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
        <span className="min-w-[8rem] flex-1 text-sm">{t("account_theme")}</span>
        <Segmented
          label={t("account_theme")}
          value={theme}
          onChange={(v) => {
            setTheme(v);
            applyTheme(v);
            save({ theme: v });
          }}
          options={[
            { value: "light", label: <span className="inline-flex items-center gap-1.5"><Sun aria-hidden className="h-3.5 w-3.5" />{t("theme_light")}</span> },
            { value: "dark", label: <span className="inline-flex items-center gap-1.5"><Moon aria-hidden className="h-3.5 w-3.5" />{t("theme_dark")}</span> },
            { value: "system", label: <span className="inline-flex items-center gap-1.5"><Monitor aria-hidden className="h-3.5 w-3.5" />{t("theme_system")}</span> },
          ]}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
        <span className="min-w-[8rem] flex-1 text-sm">{t("account_language")}</span>
        <Segmented
          label={t("account_language")}
          value={(acc.prefs.locale ?? locale) === "ko" ? "ko" : "en"}
          onChange={(v) => {
            save({ locale: v });
            try {
              window.localStorage.setItem("cms-locale", v);
            } catch {
              /* ignore */
            }
            onLocale?.(v);
          }}
          options={[
            { value: "ko", label: "한국어" },
            { value: "en", label: "English" },
          ]}
        />
      </div>
    </Section>
  );
}

function Passkeys({ list, run, onChange }: { list: AuthPasskey[]; run: Run; onChange: (l: AuthPasskey[]) => void }) {
  const { client, t, locale } = useCms();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState("");
  const [removing, setRemoving] = React.useState<AuthPasskey | null>(null);
  const [adding, setAdding] = React.useState(false);
  const supported = passkeysSupported();
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" });

  async function add() {
    setAdding(true);
    try {
      const r = await run(async () => {
        const o = await client.auth.passkeyOptions("register");
        const cred = await createPasskey(o.publicKey);
        if (!cred) return null;
        return client.auth.passkeyVerify(o.challengeId, cred, guessDevice());
      }, undefined);
      if (r && "passkeys" in r && r.passkeys) {
        onChange(r.passkeys);
        const added = r.passkeys[r.passkeys.length - 1];
        if (added) (setEditing(added.id), setLabel(added.label));
      }
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      {list.map((p) => (
        <Row key={p.id} icon={<Fingerprint className="h-4 w-4" />} title={editing === p.id ? <span className="sr-only">{p.label}</span> : <bdi>{p.label}</bdi>} text={t("account_pk_meta", { added: date(p.createdAt), used: p.lastUsedAt ? relativeTimeShort(p.lastUsedAt, locale) : t("account_never_used") }) + (p.synced ? ` · ${t("account_pk_synced")}` : "")}>
          {editing === p.id ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run(() => client.auth.renamePasskey(p.id, label.trim()));
                if (r) (onChange(r), setEditing(null));
              }}
            >
              <Input autoFocus aria-label={t("account_pk_name")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} className="h-8 w-44" />
              <Button type="submit" size="sm" variant="outline" className="h-8 px-2" aria-label={t("save")} disabled={!label.trim()}>
                <Check aria-hidden className="h-4 w-4" />
              </Button>
            </form>
          ) : (
            <>
              <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label={t("account_pk_rename", { name: p.label })} onClick={() => (setEditing(p.id), setLabel(p.label))}>
                <Pencil aria-hidden className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" aria-label={t("account_pk_remove", { name: p.label })} onClick={() => setRemoving(p)}>
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </Row>
      ))}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={!supported || adding} onClick={() => void add()}>
          <Fingerprint aria-hidden className="h-4 w-4" />
          {adding ? t("auth_waiting_passkey") : t("account_pk_add")}
        </Button>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{supported ? (list.length ? t("account_pk_more") : t("account_pk_why")) : t("account_pk_unsupported")}</span>
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("account_pk_remove_title", { name: removing?.label ?? "" })}
        description={t("account_pk_remove_text")}
        confirmLabel={t("action_delete")}
        destructive
        onConfirm={async () => {
          const p = removing;
          setRemoving(null);
          if (!p) return;
          const r = await run(() => client.auth.removePasskey(p.id), t("account_pk_removed", { name: p.label }));
          if (r) onChange(r);
        }}
      />
    </>
  );
}

/** A name for a new passkey from the browser's own description ("Mac", "iPhone", "Windows"). */
function guessDevice(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || "Passkey";
}

function Password({ acc, run, onChanged }: { acc: AuthAccount; run: Run; onChanged: () => void }) {
  const { client, t } = useCms();
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const has = acc.user.password;
  React.useEffect(() => {
    if (open) (setCurrent(""), setNext(""), setError(null));
  }, [open]);
  return (
    <>
      <Row icon={<KeyRound className="h-4 w-4" />} title={t("auth_password")} text={has ? t("account_pw_set") : t("account_pw_none")}>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          {has ? t("account_pw_change") : t("account_pw_add")}
        </Button>
      </Row>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className={DIALOG.sm}>
          <form
            className="grid min-w-0 gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const r = await run(() => client.auth.changePassword(next, has ? current : undefined));
                if (r) {
                  setOpen(false);
                  onChanged();
                }
              } catch (err) {
                setError(errorMessage(err, t));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{has ? t("account_pw_change") : t("account_pw_add")}</DialogTitle>
              <DialogDescription>{t("account_pw_text")}</DialogDescription>
            </DialogHeader>
            <input type="email" autoComplete="username" value={acc.user.email} readOnly hidden />
            {has ? (
              <div className="grid gap-1.5">
                <Label htmlFor="cms-pw-current">{t("account_pw_current")}</Label>
                <PasswordInput id="cms-pw-current" autoComplete="current-password" autoFocus required value={current} onChange={setCurrent} />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="cms-pw-next">{t("auth_new_password")}</Label>
              <PasswordInput id="cms-pw-next" autoComplete="new-password" autoFocus={!has} required value={next} onChange={setNext} describedBy="cms-pw-meter" />
              <PasswordMeter id="cms-pw-meter" value={next} email={acc.user.email} />
            </div>
            <StatusText tone="error" className="text-sm">
              {error ?? ""}
            </StatusText>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy || next.length < 12 || (has && !current)}>
                {busy ? t("saving_now") : t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useCms();
  const [kept, setKept] = React.useState(false);
  const text = codes.join("\n");
  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{t("account_codes_title")}</DialogTitle>
        <DialogDescription>{t("account_codes_text")}</DialogDescription>
      </DialogHeader>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-muted/40 px-4 py-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="tabular-nums">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void copyText(text).then((ok) => ok && setKept(true))}>
          <Copy aria-hidden className="h-3.5 w-3.5" />
          {t("copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([`${t("account_codes_file")}\n\n${text}\n`], { type: "text/plain" }));
            a.download = "recovery-codes.txt";
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            setKept(true);
          }}
        >
          <Download aria-hidden className="h-3.5 w-3.5" />
          {t("account_codes_download")}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={kept} onChange={(e) => setKept(e.target.checked)} />
        {t("account_codes_kept")}
      </label>
      <DialogFooter>
        <Button type="button" disabled={!kept} onClick={onDone}>
          {t("done")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function TwoStep({ acc, run, onChanged }: { acc: AuthAccount; run: Run; onChanged: () => void }) {
  const { client, t } = useCms();
  const [setup, setSetup] = React.useState<{ secret: string; svg: string; uri: string } | null>(null);
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [off, setOff] = React.useState(false);
  const on = acc.user.totp;

  async function start() {
    setError(null);
    setCode("");
    const r = await run(() => client.auth.startTotp());
    if (r) setSetup(r);
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await client.auth.confirmTotp(code);
      setSetup(null);
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err, t));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="two-step" title={t("account_2fa")} text={t("account_2fa_text")}>
      <Row icon={<Smartphone className="h-4 w-4" />} title={t("account_2fa_app")} text={on ? t("account_2fa_on") : t("account_2fa_off")}>
        {on ? (
          <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setOff(true)}>
            {t("account_2fa_turn_off")}
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => void start()}>
            {t("account_2fa_set_up")}
          </Button>
        )}
      </Row>
      {on ? (
        <Row icon={<ShieldCheck className="h-4 w-4" />} title={t("account_codes")} text={acc.recoveryLeft <= 3 ? <span className="text-amber-700 dark:text-amber-400">{t("account_codes_low", { n: acc.recoveryLeft })}</span> : t("account_codes_left", { n: acc.recoveryLeft })}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={async () => {
              const r = await run(() => client.auth.newRecoveryCodes());
              if (r) setCodes(r.recoveryCodes);
            }}
          >
            {t("account_codes_new")}
          </Button>
        </Row>
      ) : null}
      <Dialog open={!!setup || !!codes} onOpenChange={(o) => !o && !busy && !codes && setSetup(null)}>
        <DialogContent className={DIALOG.md}>
          {codes ? (
            <RecoveryCodes codes={codes} onDone={() => (setCodes(null), onChanged())} />
          ) : setup ? (
            <form onSubmit={confirm} className="grid min-w-0 gap-4">
              <DialogHeader>
                <DialogTitle>{t("account_2fa_set_up")}</DialogTitle>
                <DialogDescription>{t("account_2fa_steps")}</DialogDescription>
              </DialogHeader>
              <div className="flex min-w-0 flex-wrap items-center gap-4">
                <div aria-label={t("account_2fa_qr")} role="img" className="h-40 w-40 shrink-0 rounded-md border bg-white p-2 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: setup.svg }} />
                <div className="grid min-w-0 flex-1 gap-1.5 text-xs text-muted-foreground">
                  <span>{t("account_2fa_manual")}</span>
                  <code className="break-all rounded bg-muted px-2 py-1.5 font-mono text-[13px] tracking-wider text-foreground">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                  <a href={setup.uri} className="underline underline-offset-2">
                    {t("account_2fa_open_app")}
                  </a>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cms-totp-code">{t("account_2fa_enter")}</Label>
                <Input id="cms-totp-code" autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="h-11 text-center font-mono text-lg tracking-[0.5em]" aria-describedby="cms-totp-error" />
                <StatusText id="cms-totp-error" tone="error" className="text-sm">
                  {error ?? ""}
                </StatusText>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setSetup(null)}>
                  {t("cancel")}
                </Button>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {busy ? t("saving_now") : t("account_2fa_turn_on")}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={off}
        onOpenChange={setOff}
        title={t("account_2fa_off_title")}
        description={acc.user.passkeys ? t("account_2fa_off_text") : t("account_2fa_off_text_weak")}
        confirmLabel={t("account_2fa_turn_off")}
        destructive
        onConfirm={async () => {
          setOff(false);
          if (await run(() => client.auth.disableTotp(), t("account_2fa_off_done"))) onChanged();
        }}
      />
    </Section>
  );
}

function Devices({ list, run, onChanged, onSignedOut }: { list: AuthDevice[] | null; run: Run; onChanged: () => void; onSignedOut?: () => void }) {
  const { client, t, locale } = useCms();
  const [all, setAll] = React.useState(false);
  const others = (list ?? []).filter((d) => !d.current).length;
  const icon = (d: AuthDevice) => (/iPhone|Android|Mobile/i.test(d.device) ? <Smartphone className="h-4 w-4" /> : <Laptop className="h-4 w-4" />);
  return (
    <Section
      id="devices"
      title={t("account_devices")}
      text={t("account_devices_text")}
      action={
        others ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setAll(true)}>
            {t("account_devices_others")}
          </Button>
        ) : null
      }
    >
      {!list ? (
        <div className="m-4 h-12 animate-pulse rounded bg-muted" />
      ) : (
        list.map((d) => (
          <Row
            key={d.id}
            icon={icon(d)}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                <bdi className="truncate">{d.device || t("account_device_unknown")}</bdi>
                {d.current ? <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-px text-[11px] font-normal text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{t("account_this_device")}</span> : null}
              </span>
            }
            text={[d.ip, t(`account_via_${d.method}` as never) || d.method, `${t("account_last_active")} ${relativeTimeShort(d.lastSeenAt, locale)}`, `${t("account_since")} ${new Date(d.createdAt).toLocaleDateString(locale, { dateStyle: "medium" })}`].filter(Boolean).join(" · ")}
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={async () => {
                const r = await run(() => client.auth.endSession(d.id), d.current ? undefined : t("account_device_out"));
                if (r?.signedOut) (onSignedOut ?? (() => window.location.reload()))();
                else onChanged();
              }}
            >
              <LogOut aria-hidden className="h-3.5 w-3.5" />
              {d.current ? t("account_sign_out_here") : t("account_sign_out")}
            </Button>
          </Row>
        ))
      )}
      <ConfirmDialog
        open={all}
        onOpenChange={setAll}
        title={t("account_devices_others_title", { n: others })}
        description={t("account_devices_others_text")}
        confirmLabel={t("account_devices_others")}
        onConfirm={async () => {
          setAll(false);
          if (await run(() => client.auth.endOtherSessions(), t("account_devices_others_done"))) onChanged();
        }}
      />
    </Section>
  );
}
