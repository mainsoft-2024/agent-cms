// agent-cms registry: cms-people (0.16.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// People of the CMS's own sign-in (`createAuth`), for admins: who has an
// account, how they sign in, when they last did, their role; invitations
// waiting to be accepted; and the "two-step for everyone" policy. Invite by
// email (several at once, pasted from anywhere), pick the role they start
// with, and send the mail or copy the links. Changing someone's admin rights
// or switching an account off asks you to confirm it is you first.
"use client";

import * as React from "react";
import { Ban, Copy, KeyRound, LogOut, Mail, MoreHorizontal, RotateCcw, Search, Send, ShieldCheck, ShieldOff, UserPlus, X } from "lucide-react";
import type { AuthInvite, AuthUser, CmsRole } from "@mainsoft/agent-cms/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useReauth } from "./cms-auth-kit";
import { errorMessage } from "./cms-messages";
import { CodeBox, ConfirmDialog, DIALOG, PageHeader, PersonMark, Segmented, StatusText, copyText, relativeTimeShort } from "./cms-parts";
import { useCms } from "./use-cms";

type Tab = "all" | "active" | "invited" | "disabled";
type Data = Awaited<ReturnType<ReturnType<typeof useCms>["client"]["people"]["list"]>>;
const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

export function CmsPeople({ className }: { className?: string }) {
  const { client, t, locale, toast, me } = useCms();
  const [data, setData] = React.useState<Data | null>(null);
  const [roles, setRoles] = React.useState<CmsRole[]>([]);
  const [error, setError] = React.useState<unknown>(null);
  const [tab, setTab] = React.useState<Tab>("all");
  const [q, setQ] = React.useState("");
  const [inviting, setInviting] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | { title: string; text: string; ok: string; destructive?: boolean; run: () => Promise<void> }>(null);
  const [link, setLink] = React.useState<null | { title: string; text: string; url: string }>(null);
  const reauth = useReauth();
  const myId = me?.actor?.kind === "user" ? me.actor.id : null;

  const load = React.useCallback(() => {
    setError(null);
    Promise.all([client.people.list(), client.roles().then((r) => r.roles, () => [] as CmsRole[])]).then(([d, r]) => (setData(d), setRoles(r)), setError);
  }, [client]);
  React.useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await reauth.run(fn);
      if (done) toast(done, { tone: "ok" });
      load();
    } catch (e) {
      toast(errorMessage(e, t), { tone: "error" });
    }
  };

  const users = data?.users ?? [];
  const invites = data?.invites ?? [];
  const needle = q.trim().toLowerCase();
  const match = (s: string | null | undefined) => !needle || (s ?? "").toLowerCase().includes(needle);
  const shownUsers = users.filter((u) => (tab === "all" || (tab === "active" && !u.disabled) || (tab === "disabled" && u.disabled)) && (match(u.name) || match(u.email)));
  const shownInvites = tab === "all" || tab === "invited" ? invites.filter((i) => match(i.email)) : [];
  const passwordOnly = users.filter((u) => !u.disabled && !u.totp && !u.passkeys && !u.sso).length;
  const count = { all: users.length + invites.length, active: users.filter((u) => !u.disabled).length, invited: invites.length, disabled: users.filter((u) => u.disabled).length };
  const time = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <PageHeader title={t("people_title")}>
        <Button type="button" className="gap-1.5" disabled={!data} onClick={() => setInviting(true)}>
          <UserPlus aria-hidden className="h-4 w-4" />
          {t("people_invite")}
        </Button>
      </PageHeader>
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6">
        {data && !data.policy.requireMfa && passwordOnly > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <ShieldCheck aria-hidden className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{t("people_mfa_banner", { n: passwordOnly })}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-background"
              onClick={() =>
                setConfirm({
                  title: t("people_mfa_title"),
                  text: t("people_mfa_text"),
                  ok: t("people_mfa_on"),
                  run: () => act(() => client.auth.setPolicy(true), t("people_mfa_done")),
                })
              }
            >
              {t("people_mfa_on")}
            </Button>
          </div>
        ) : data?.policy.requireMfa ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm">
            <ShieldCheck aria-hidden className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1">{t("people_mfa_is_on")}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm({ title: t("people_mfa_off_title"), text: t("people_mfa_off_text"), ok: t("people_mfa_off"), destructive: true, run: () => act(() => client.auth.setPolicy(false), t("people_mfa_off_done")) })}>
              {t("people_mfa_off")}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label={t("people_filter")}
            value={tab}
            onChange={setTab}
            options={(["all", "active", "invited", "disabled"] as Tab[]).map((v) => ({
              value: v,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {t(`people_tab_${v}` as never)}
                  <span className="tabular-nums text-muted-foreground">{data ? count[v] : ""}</span>
                </span>
              ),
            }))}
          />
          <div className="relative ml-auto w-full sm:w-64">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("people_search")} placeholder={t("people_search")} className="h-9 pl-8" />
          </div>
        </div>

        {error ? (
          <div className="flex items-center gap-3">
            <StatusText tone="error">{errorMessage(error, t)}</StatusText>
            <Button type="button" variant="outline" size="sm" onClick={load}>
              {t("retry")}
            </Button>
          </div>
        ) : !data ? (
          <ul aria-label={t("loading")} className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="h-14 animate-pulse rounded-md bg-muted" />
            ))}
          </ul>
        ) : !shownUsers.length && !shownInvites.length ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{needle ? t("no_results") : tab === "invited" ? t("people_no_invites") : tab === "disabled" ? t("people_no_disabled") : t("people_empty")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
            {shownUsers.map((u) => (
              <PersonRow
                key={u.id}
                u={u}
                me={u.id === myId}
                roles={roles}
                time={time}
                onRole={(roleId) => act(() => client.people.update(u.id, { roleId }), t("people_role_set", { name: u.name || u.email }))}
                onAction={(kind) => {
                  const name = u.name || u.email;
                  if (kind === "reset")
                    return void reauth
                      .run(() => client.people.resetLink(u.id))
                      .then((r) => (r.sent ? toast(t("people_reset_sent", { email: u.email }), { tone: "ok" }) : setLink({ title: t("people_reset_link_title", { name }), text: t("people_reset_link_text"), url: r.link })), (e) => toast(errorMessage(e, t), { tone: "error" }));
                  if (kind === "signout") return setConfirm({ title: t("people_signout_title", { name }), text: t("people_signout_text"), ok: t("people_signout_ok"), run: () => act(() => client.people.endSessions(u.id), t("people_signout_done", { name })) });
                  if (kind === "admin") return setConfirm({ title: u.isAdmin ? t("people_unadmin_title", { name }) : t("people_admin_title", { name }), text: u.isAdmin ? t("people_unadmin_text") : t("people_admin_text"), ok: u.isAdmin ? t("people_unadmin_ok") : t("people_admin_ok"), destructive: u.isAdmin, run: () => act(() => client.people.update(u.id, { admin: !u.isAdmin }), t("saved")) });
                  if (kind === "disable") return setConfirm({ title: u.disabled ? t("people_enable_title", { name }) : t("people_disable_title", { name }), text: u.disabled ? t("people_enable_text") : t("people_disable_text"), ok: u.disabled ? t("people_enable_ok") : t("people_disable_ok"), destructive: !u.disabled, run: () => act(() => client.people.update(u.id, { disabled: !u.disabled }), u.disabled ? t("people_enabled", { name }) : t("people_disabled", { name })) });
                }}
              />
            ))}
            {shownInvites.map((i) => (
              <InviteRow
                key={i.id}
                i={i}
                roles={roles}
                time={time}
                mail={data.mail}
                onResend={() =>
                  void client.people.resendInvite(i.id).then(
                    (r) => (r.sent ? toast(t("people_resent", { email: i.email }), { tone: "ok" }) : setLink({ title: t("people_invite_link_title", { email: i.email }), text: t("people_invite_link_text"), url: r.link }), load()),
                    (e) => toast(errorMessage(e, t), { tone: "error" })
                  )
                }
                onRevoke={() => setConfirm({ title: t("people_revoke_title", { email: i.email }), text: t("people_revoke_text"), ok: t("people_revoke_ok"), destructive: true, run: () => act(() => client.people.revokeInvite(i.id), t("people_revoked", { email: i.email })) })}
              />
            ))}
          </ul>
        )}
        {data ? <p className="text-xs text-muted-foreground">{data.sso ? t("people_foot_sso", { name: data.sso.label }) : t("people_foot")}</p> : null}
      </div>

      <InviteDialog open={inviting} onOpenChange={setInviting} roles={roles} mail={!!data?.mail} taken={users.map((u) => u.email.toLowerCase())} onDone={load} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.title ?? ""}
        description={confirm?.text}
        confirmLabel={confirm?.ok ?? ""}
        destructive={confirm?.destructive}
        onConfirm={async () => {
          const c = confirm;
          setConfirm(null);
          await c?.run();
        }}
      />
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent className={DIALOG.md}>
          <DialogHeader>
            <DialogTitle>{link?.title}</DialogTitle>
            <DialogDescription>{link?.text}</DialogDescription>
          </DialogHeader>
          {link ? <CodeBox value={link.url} label={t("copy_link")} /> : null}
          <DialogFooter>
            <Button type="button" onClick={() => setLink(null)}>
              {t("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {reauth.dialog}
    </div>
  );
}

function Methods({ u }: { u: AuthUser }) {
  const { t } = useCms();
  const chips: { key: string; label: string; strong?: boolean }[] = [];
  if (u.passkeys) chips.push({ key: "pk", label: t("people_m_passkey", { n: u.passkeys }), strong: true });
  if (u.sso) chips.push({ key: "sso", label: t("people_m_sso"), strong: true });
  if (u.password) chips.push({ key: "pw", label: u.totp ? t("people_m_password_2fa") : t("people_m_password"), strong: u.totp });
  if (!chips.length) chips.push({ key: "none", label: t("people_m_none") });
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.key} className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]", c.strong ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-muted text-muted-foreground")}>
          {c.label}
        </span>
      ))}
    </span>
  );
}

function PersonRow({ u, me, roles, time, onRole, onAction }: { u: AuthUser; me: boolean; roles: CmsRole[]; time: (iso: string) => string; onRole: (roleId: string | null) => void; onAction: (k: "reset" | "signout" | "admin" | "disable") => void }) {
  const { t, locale } = useCms();
  const role = u.roles[0]?.id ?? "";
  return (
    <li className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.1fr)_7rem_auto]", u.disabled && "opacity-60")}>
      <span className="flex min-w-0 items-center gap-3">
        <PersonMark id={u.id} label={u.name || u.email} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <bdi className="truncate text-sm font-medium">{u.name || u.email}</bdi>
            {me ? <span className="shrink-0 text-xs text-muted-foreground">{t("role_you")}</span> : null}
            {u.isAdmin ? <span className="shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">{t("people_admin")}</span> : null}
            {u.disabled ? <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("people_off")}</span> : null}
          </span>
          {u.name ? <span className="truncate text-xs text-muted-foreground">{u.email}</span> : null}
        </span>
      </span>
      <span className="order-last col-span-2 flex min-w-0 md:order-none md:col-span-1">
        {u.isAdmin ? (
          <span className="text-xs text-muted-foreground">{t("people_admin_all")}</span>
        ) : (
          <select aria-label={t("people_role_of", { name: u.name || u.email })} className={cn(SELECT, "w-full max-w-[12rem]")} value={role} disabled={u.disabled} onChange={(e) => onRole(e.target.value || null)}>
            <option value="">{t("people_no_role")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </span>
      <span className="hidden min-w-0 md:flex">
        <Methods u={u} />
      </span>
      <span className="hidden text-xs text-muted-foreground md:block" title={u.lastLoginAt ? time(u.lastLoginAt) : undefined}>
        {u.lastLoginAt ? relativeTimeShort(u.lastLoginAt, locale) : t("people_never")}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "sm", className: "h-8 w-8 p-0" })} aria-label={t("people_actions", { name: u.name || u.email })}>
          <MoreHorizontal aria-hidden className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {u.password || !u.sso ? (
            <DropdownMenuItem onClick={() => onAction("reset")}>
              <KeyRound aria-hidden className="mr-2 h-4 w-4" />
              {t("people_reset")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => onAction("signout")} disabled={u.disabled}>
            <LogOut aria-hidden className="mr-2 h-4 w-4" />
            {t("people_signout")}
          </DropdownMenuItem>
          {!me ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAction("admin")} disabled={u.disabled}>
                {u.isAdmin ? <ShieldOff aria-hidden className="mr-2 h-4 w-4" /> : <ShieldCheck aria-hidden className="mr-2 h-4 w-4" />}
                {u.isAdmin ? t("people_unadmin") : t("people_make_admin")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAction("disable")} className={u.disabled ? undefined : "text-destructive focus:text-destructive"}>
                {u.disabled ? <RotateCcw aria-hidden className="mr-2 h-4 w-4" /> : <Ban aria-hidden className="mr-2 h-4 w-4" />}
                {u.disabled ? t("people_enable") : t("people_disable")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function InviteRow({ i, roles, time, mail, onResend, onRevoke }: { i: AuthInvite; roles: CmsRole[]; time: (iso: string) => string; mail: boolean; onResend: () => void; onRevoke: () => void }) {
  const { t, locale } = useCms();
  const expired = Date.parse(i.expiresAt) < Date.now();
  const role = i.isAdmin ? t("people_admin") : roles.find((r) => r.id === i.roleId)?.name ?? t("people_no_role");
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 bg-muted/20 px-4 py-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.1fr)_7rem_auto]">
      <span className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground">
          <Mail className="h-3.5 w-3.5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <bdi className="truncate text-sm font-medium">{i.email}</bdi>
          <span className="truncate text-xs text-muted-foreground">{t("people_invited_by", { who: i.invitedBy })}</span>
        </span>
      </span>
      <span className="order-last col-span-2 truncate text-xs text-muted-foreground md:order-none md:col-span-1">{role}</span>
      <span className="hidden md:block">
        <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]", expired ? "bg-destructive/10 text-destructive" : "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200")}>{expired ? t("people_invite_expired") : t("people_invite_waiting")}</span>
      </span>
      <span className="hidden text-xs text-muted-foreground md:block" title={time(i.expiresAt)}>
        {expired ? "" : t("people_until", { time: relativeTimeShort(i.expiresAt, locale) })}
      </span>
      <span className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2" onClick={onResend} title={mail ? t("people_resend_hint") : t("people_newlink_hint")}>
          {mail ? <Send aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{mail ? t("people_resend") : t("people_newlink")}</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" aria-label={t("people_revoke_of", { email: i.email })} onClick={onRevoke}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </span>
    </li>
  );
}

/** Emails as chips (paste a list from anywhere), the role they start with, mail or links. */
function InviteDialog({ open, onOpenChange, roles, mail, taken, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; roles: CmsRole[]; mail: boolean; taken: string[]; onDone: () => void }) {
  const { client, t } = useCms();
  const [emails, setEmails] = React.useState<string[]>([]);
  const [text, setText] = React.useState("");
  const [roleId, setRoleId] = React.useState<string>("");
  const [admin, setAdmin] = React.useState(false);
  const [send, setSend] = React.useState<"mail" | "link">("mail");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<{ email: string; link: string; sent: boolean }[] | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setEmails([]);
    setText("");
    setRoleId(roles.find((r) => !r.admin)?.id ?? "");
    setAdmin(false);
    setSend(mail ? "mail" : "link");
    setError(null);
    setResults(null);
    // Only when it opens: the list reloading behind it must not wipe the links just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const take = (raw: string) => {
    const found = raw.split(/[\s,;<>()"]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!found.length) return raw;
    const ok = found.filter((e) => EMAIL_RE.test(e));
    setEmails((cur) => [...cur, ...ok.filter((e) => !cur.includes(e))].slice(0, 50));
    return found.filter((e) => !EMAIL_RE.test(e)).join(" ");
  };
  const all = [...emails, ...(EMAIL_RE.test(text.trim().toLowerCase()) ? [text.trim().toLowerCase()] : [])];
  const already = all.filter((e) => taken.includes(e));
  const role = roles.find((r) => r.id === roleId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!all.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.people.invite(all.filter((x) => !taken.includes(x)), { roleId: admin ? null : roleId || null, admin });
      onDone();
      if (send === "mail" && out.every((r) => r.sent)) onOpenChange(false);
      else setResults(out);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={DIALOG.lg}>
        {results ? (
          <div className="grid min-w-0 gap-4">
            <DialogHeader>
              <DialogTitle>{t("people_links_title", { n: results.length })}</DialogTitle>
              <DialogDescription>{t("people_links_text")}</DialogDescription>
            </DialogHeader>
            <ul className="grid min-w-0 gap-3">
              {results.map((r) => (
                <li key={r.email} className="grid min-w-0 gap-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <bdi className="truncate">{r.email}</bdi>
                    {r.sent ? <span className="text-xs font-normal text-emerald-700 dark:text-emerald-400">{t("people_mail_sent")}</span> : null}
                  </span>
                  <CodeBox value={r.link} label={t("copy_link")} />
                </li>
              ))}
            </ul>
            <DialogFooter>
              {results.length > 1 ? (
                <Button type="button" variant="outline" className="gap-1.5" onClick={() => void copyText(results.map((r) => `${r.email}\t${r.link}`).join("\n"))}>
                  <Copy aria-hidden className="h-4 w-4" />
                  {t("people_copy_all")}
                </Button>
              ) : null}
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid min-w-0 gap-4">
            <DialogHeader>
              <DialogTitle>{t("people_invite_title")}</DialogTitle>
              <DialogDescription>{t("people_invite_text")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="cms-invite-emails">{t("people_emails")}</Label>
              <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring" onClick={() => document.getElementById("cms-invite-emails")?.focus()}>
                {emails.map((e) => (
                  <span key={e} className={cn("inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs", taken.includes(e) ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" : "bg-muted")}>
                    <bdi className="truncate">{e}</bdi>
                    <button type="button" aria-label={t("people_remove_email", { email: e })} className="grid h-4 w-4 shrink-0 place-items-center rounded-full hover:bg-background" onClick={() => setEmails((c) => c.filter((x) => x !== e))}>
                      <X aria-hidden className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  id="cms-invite-emails"
                  autoFocus
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  placeholder={emails.length ? "" : t("people_emails_placeholder")}
                  aria-describedby="cms-invite-emails-hint"
                  className="h-7 min-w-[10rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(e) => setText(/[\s,;]/.test(e.target.value) ? take(e.target.value) : e.target.value)}
                  onPaste={(e) => {
                    e.preventDefault();
                    setText(take(text + " " + e.clipboardData.getData("text")));
                  }}
                  onBlur={() => setText(take(text))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && text.trim()) (e.preventDefault(), setText(take(text)));
                    else if (e.key === "Backspace" && !text && emails.length) setEmails((c) => c.slice(0, -1));
                  }}
                />
              </div>
              <p id="cms-invite-emails-hint" className={cn("text-xs", already.length ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                {already.length ? t("people_already", { emails: already.join(", ") }) : t("people_emails_hint")}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cms-invite-role">{t("people_start_role")}</Label>
              <select id="cms-invite-role" className={cn(SELECT, "h-9 w-full")} disabled={admin} value={admin ? "" : roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">{t("people_no_role")}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{admin ? t("people_admin_all") : role ? t("people_role_summary", { name: role.name, n: Object.values(role.permissions).filter((p) => p.write || p.publish).length }) : t("people_no_role_hint")}</p>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <Checkbox checked={admin} onCheckedChange={(v) => setAdmin(v === true)} />
                {t("people_invite_admin")}
              </label>
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("people_send_how")}</span>
              <Segmented
                label={t("people_send_how")}
                value={send}
                onChange={setSend}
                options={[
                  { value: "mail", label: t("people_send_mail"), disabled: !mail },
                  { value: "link", label: t("people_send_link") },
                ]}
              />
              <p className="text-xs text-muted-foreground">{!mail ? t("people_no_mail") : t("people_link_rules")}</p>
            </div>
            <StatusText tone="error" className="text-sm [overflow-wrap:anywhere]">
              {error ?? ""}
            </StatusText>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" className="gap-1.5" disabled={busy || !all.filter((x) => !taken.includes(x)).length}>
                {send === "mail" ? <Send aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
                {busy ? t("saving_now") : send === "mail" ? t("people_send_n", { n: all.filter((x) => !taken.includes(x)).length }) : t("people_make_links_n", { n: all.filter((x) => !taken.includes(x)).length })}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
