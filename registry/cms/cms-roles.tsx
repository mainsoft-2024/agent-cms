// agent-cms registry: cms-roles (0.16.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Roles: the list, and for the selected one its name, what it may do in each
// collection (write, publish, delete, HTML) and the people in it. Admins only.
// People are found by name or email; someone who has not signed in yet is
// added by email and joins at their first sign-in. A new role starts from a
// template (viewer, editor, publisher, admin) and asks for its name first.
// Collections whose access is decided in code show "Set in code" instead of a box.
"use client";

import * as React from "react";
import { Check, Plus, Search, Shield, ShieldCheck, X } from "lucide-react";
import type { CmsRole, RoleOp, RolePermissions } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, DIALOG, PageHeader, PersonMark, PersonPicker, StatusText } from "./cms-parts";
import { useAsync, useCms } from "./use-cms";

/** The columns, in the order a person grows into them. */
const OPS: RoleOp[] = ["write", "publish", "delete", "html"];
type Target = { slug: string; label: string; coded: RoleOp[]; media?: boolean };
/** A media store takes "upload and edit" (`write`) and "move and delete" (`delete`) only. */
const applies = (tg: Target, op: RoleOp) => !tg.media || op === "write" || op === "delete";
type Template = "viewer" | "editor" | "publisher" | "admin" | "empty";
const TEMPLATES: { id: Template; ops: RoleOp[]; admin?: boolean }[] = [
  { id: "editor", ops: ["write"] },
  { id: "publisher", ops: ["write", "publish", "delete"] },
  { id: "viewer", ops: ["read"] },
  { id: "admin", ops: [], admin: true },
  { id: "empty", ops: [] },
];

function permsFor(targets: Target[], ops: RoleOp[]): RolePermissions {
  const out: RolePermissions = {};
  for (const tg of targets) out[tg.slug] = Object.fromEntries(ops.filter((op) => !tg.coded.includes(op) && applies(tg, op)).map((op) => [op, true]));
  return out;
}
const samePerms = (a: RolePermissions, b: RolePermissions) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) for (const op of [...OPS, "read" as RoleOp]) if (!!a[k]?.[op] !== !!b[k]?.[op]) return false;
  return true;
};

export function CmsRoles({ className }: { className?: string }) {
  const { client, t } = useCms();
  const data = useAsync(() => client.roles(), [client]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const dirty = React.useRef(false);
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const roles = data.data?.roles ?? [];
  const open = roles.find((r) => r.id === openId) ?? roles[0] ?? null;
  const shown = q.trim() ? roles.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase())) : roles;

  const pick = (id: string) => {
    if (id === open?.id) return;
    if (dirty.current) setLeaving(id);
    else setOpenId(id);
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("roles_title")}>
        <Button type="button" className="gap-1.5" onClick={() => setCreating(true)} disabled={!data.data}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("role_new")}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav aria-label={t("roles_title")} className="flex shrink-0 flex-col gap-2 border-b p-3 lg:w-60 lg:border-b-0 lg:border-r">
          {roles.length > 6 ? (
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("role_find")} placeholder={t("role_find")} className="h-8 pl-8 text-sm" />
            </div>
          ) : null}
          {data.error ? (
            <div className="flex flex-col items-start gap-2 px-1">
              <StatusText tone="error" className="text-xs">
                {errorMessage(data.error, t)}
              </StatusText>
              <Button type="button" size="sm" variant="outline" onClick={data.reload}>
                {t("retry")}
              </Button>
            </div>
          ) : data.loading && !data.data ? (
            <ul aria-hidden className="flex flex-col gap-1">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-8 animate-pulse rounded-md bg-muted" />
              ))}
            </ul>
          ) : null}
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {shown.map((r) => (
              <li key={r.id} className="min-w-0 shrink-0 lg:shrink">
                <button type="button" aria-current={r.id === open?.id ? "true" : undefined} onClick={() => pick(r.id)} className={cn("flex h-9 w-full max-w-[16rem] items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring lg:max-w-none", r.id === open?.id && "bg-accent font-medium")}>
                  {r.admin ? <ShieldCheck aria-hidden className="h-4 w-4 shrink-0 text-primary" /> : <Shield aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <bdi className="min-w-0 flex-1 truncate text-left">{r.name}</bdi>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={t("role_people", { n: r.members.length })}>
                    {r.members.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {q && !shown.length ? <p className="px-1 text-xs text-muted-foreground">{t("role_find_none")}</p> : null}
        </nav>
        <div className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {data.data && !roles.length ? (
            <div className="flex max-w-prose flex-col items-start gap-3 rounded-lg border border-dashed p-6">
              <ShieldCheck aria-hidden className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("roles_empty_title")}</p>
              <p className="text-sm text-muted-foreground">{t("roles_empty")}</p>
              <Button type="button" className="gap-1.5" onClick={() => setCreating(true)}>
                <Plus aria-hidden className="h-4 w-4" />
                {t("role_new")}
              </Button>
            </div>
          ) : null}
          {open && data.data ? <RoleForm key={open.id} role={open} targets={data.data.targets} dirtyRef={dirty} onChanged={data.reload} onDeleted={() => (setOpenId(null), data.reload())} /> : null}
        </div>
      </div>
      <NewRoleDialog
        open={creating}
        onOpenChange={setCreating}
        taken={roles.map((r) => r.name.toLowerCase())}
        targets={data.data?.targets ?? []}
        onCreated={(r) => {
          dirty.current = false;
          setOpenId(r.id);
          data.reload();
        }}
      />
      <ConfirmDialog
        open={!!leaving}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={t("role_unsaved_title")}
        description={t("role_unsaved_text")}
        confirmLabel={t("role_unsaved_leave")}
        destructive
        onConfirm={() => {
          dirty.current = false;
          setOpenId(leaving);
          setLeaving(null);
        }}
      />
    </div>
  );
}

/** Name first, and a starting point, so a role is never created as "New role 3". */
function NewRoleDialog({ open, onOpenChange, taken, targets, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; taken: string[]; targets: Target[]; onCreated: (r: CmsRole) => void }) {
  const { client, t, toast } = useCms();
  const [name, setName] = React.useState("");
  const [template, setTemplate] = React.useState<Template>("editor");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) (setName(""), setTemplate("editor"), setError(null));
  }, [open]);
  const clash = !!name.trim() && taken.includes(name.trim().toLowerCase());

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || clash) return;
    setBusy(true);
    setError(null);
    try {
      const tpl = TEMPLATES.find((x) => x.id === template)!;
      const r = await client.createRole({ name: name.trim(), admin: !!tpl.admin, permissions: permsFor(targets, tpl.ops) });
      onOpenChange(false);
      toast(t("role_created", { name: r.name }), { tone: "ok" });
      onCreated(r);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={DIALOG.md}>
        <form onSubmit={create} className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>{t("role_new")}</DialogTitle>
            <DialogDescription>{t("role_new_text")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cms-new-role-name">{t("role_name")}</Label>
            <Input id="cms-new-role-name" autoFocus value={name} maxLength={60} placeholder={t("role_name_example")} aria-invalid={clash || undefined} aria-describedby="cms-new-role-hint" onChange={(e) => setName(e.target.value)} />
            <StatusText id="cms-new-role-hint" tone={clash ? "error" : "muted"} className="text-xs">
              {clash ? t("role_name_taken") : ""}
            </StatusText>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t("role_start_from")}</legend>
            {TEMPLATES.map((tpl) => (
              <label key={tpl.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", template === tpl.id && "border-primary bg-primary/5")}>
                <input type="radio" name="cms-role-template" className="mt-0.5 h-4 w-4 accent-primary" checked={template === tpl.id} onChange={() => setTemplate(tpl.id)} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{t(`role_tpl_${tpl.id}` as never)}</span>
                  <span className="text-xs text-muted-foreground">{t(`role_tpl_${tpl.id}_text` as never)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <StatusText tone="error" className="text-sm">
            {error ?? ""}
          </StatusText>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || clash}>
              {busy ? t("saving_now") : t("role_create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleForm({ role, targets, dirtyRef, onChanged, onDeleted }: { role: CmsRole; targets: Target[]; dirtyRef: React.MutableRefObject<boolean>; onChanged: () => void; onDeleted: () => void }) {
  const { client, t, toast, me } = useCms();
  const [name, setName] = React.useState(role.name);
  const [admin, setAdmin] = React.useState(role.admin);
  const [perms, setPerms] = React.useState<RolePermissions>(role.permissions);
  const [saved, setSaved] = React.useState({ name: role.name, admin: role.admin, perms: role.permissions });
  const [members, setMembers] = React.useState(role.members);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [removing, setRemoving] = React.useState<CmsRole["members"][number] | null>(null);
  const search = React.useCallback((q: string) => client.searchUsers(q), [client]);
  const dirty = name.trim() !== saved.name || admin !== saved.admin || !samePerms(perms, saved.perms);
  dirtyRef.current = dirty;
  React.useEffect(() => () => void (dirtyRef.current = false), [dirtyRef]);
  const myId = me?.actor?.kind === "user" ? me.actor.id : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.updateRole(role.id, { name: name.trim(), admin, permissions: perms });
      setSaved({ name: r.name, admin: r.admin, perms: r.permissions });
      toast(t("role_saved"), { tone: "ok" });
      onChanged();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function members_(fn: () => Promise<CmsRole>, done: (r: CmsRole) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setMembers(r.members);
      done(r);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }
  const addMember = (m: { id?: string; email?: string; label?: string }) =>
    members_(
      () => client.addRoleMember(role.id, m),
      (r) => {
        const added = r.members[r.members.length - 1];
        toast(added?.pending ? t("role_person_pending_added", { email: added.email ?? "" }) : t("role_person_added", { name: added?.label ?? "" }), { tone: "ok" });
      }
    );
  const removeMember = (m: CmsRole["members"][number]) =>
    members_(
      () => client.removeRoleMember(role.id, m.id),
      () =>
        toast(t("role_person_removed", { name: m.label }), {
          tone: "ok",
          action: { label: t("undo"), run: () => void addMember(m.pending ? { email: m.email ?? "" } : { id: m.id, label: m.label }) },
        })
    );

  const set = (slug: string, op: RoleOp, on: boolean) =>
    setPerms((p) => {
      const row = { ...p[slug], [op]: on };
      // Publishing, deleting and HTML all start with writing; writing without them is fine.
      if (on && op !== "write") row.write = true;
      if (!on && op === "write") (row.publish = false), (row.delete = false), (row.html = false);
      return { ...p, [slug]: row };
    });
  const editable = (op: RoleOp) => targets.filter((tg) => !tg.coded.includes(op) && applies(tg, op));
  const docTargets = targets.filter((tg) => !tg.media);
  const mediaTargets = targets.filter((tg) => tg.media);
  const column = (op: RoleOp) => {
    const list = editable(op);
    const n = list.filter((tg) => perms[tg.slug]?.[op]).length;
    return { all: list.length > 0 && n === list.length, some: n > 0 && n < list.length, none: !list.length };
  };
  const setColumn = (op: RoleOp, on: boolean) => {
    for (const tg of editable(op)) set(tg.slug, op, on);
  };

  return (
    <form className="flex max-w-3xl flex-col gap-6" onSubmit={save}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="cms-role-name">{t("role_name")}</Label>
          <Input id="cms-role-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} className="max-w-xs" />
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs text-muted-foreground">
            {dirty ? t("role_unsaved") : ""}
          </span>
          <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirming(true)}>
            {t("action_delete")}
          </Button>
          <Button type="submit" disabled={busy || !dirty || !name.trim()}>
            {busy ? t("saving_now") : t("save")}
          </Button>
        </div>
      </div>

      <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3", admin && "border-primary bg-primary/5")}>
        <Checkbox className="mt-0.5" checked={admin} onCheckedChange={(on) => setAdmin(on === true)} />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{t("role_admin_title")}</span>
          <span className="text-xs text-muted-foreground">{t("role_admin")}</span>
        </span>
      </label>

      <StatusText tone="error" className="text-sm">
        {error ?? ""}
      </StatusText>

      {admin ? null : (
        <section className="flex flex-col gap-2" aria-labelledby="cms-role-perms">
          <div className="flex flex-col gap-0.5">
            <h2 id="cms-role-perms" className="text-sm font-medium">
              {t("role_perms_title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("role_perms_text")}</p>
          </div>
          {targets.length ? (
            <div className="relative overflow-x-auto rounded-md border">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t("role_target")}
                    </th>
                    {OPS.map((op) => {
                      const c = column(op);
                      return (
                        <th key={op} scope="col" className="w-24 px-2 py-2 text-left align-top font-medium">
                          <span className="flex flex-col gap-1">
                            <span title={t(`role_${op}_hint` as never)}>{t(`role_${op}` as never)}</span>
                            {c.none ? null : <Checkbox aria-label={t("role_all_column", { op: t(`role_${op}` as never) })} checked={c.all} aria-checked={c.all ? "true" : c.some ? "mixed" : "false"} onCheckedChange={(on) => setColumn(op, on === true)} />}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {[...docTargets, ...mediaTargets].map((tg, i) => (
                    <React.Fragment key={tg.slug}>
                    {tg.media && i === docTargets.length ? (
                      <tr className="border-b bg-muted/20">
                        <th scope="rowgroup" colSpan={OPS.length + 1} className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">
                          {t("role_media_group")} <span className="font-normal">· {t("role_media_hint")}</span>
                        </th>
                      </tr>
                    ) : null}
                    <tr className="border-b last:border-0">
                      <th scope="row" className="max-w-[14rem] truncate px-3 py-2 text-left font-normal">
                        <bdi>{tg.label}</bdi>
                      </th>
                      {OPS.map((op) => (
                        <td key={op} className="px-2 py-2">
                          {!applies(tg, op) ? (
                            <span className="text-xs text-muted-foreground" title={t("role_not_for_media")}>
                              <span aria-hidden>—</span>
                              <span className="sr-only">{t("role_not_for_media")}</span>
                            </span>
                          ) : tg.coded.includes(op) ? (
                            <span className="whitespace-nowrap text-xs text-muted-foreground" title={t("role_coded_hint")}>
                              {t("role_coded")}
                            </span>
                          ) : (
                            <Checkbox aria-label={`${tg.label}: ${tg.media ? t(op === "write" ? "role_media_write" : "role_media_delete") : t(`role_${op}` as never)}`} checked={!!perms[tg.slug]?.[op]} onCheckedChange={(on) => set(tg.slug, op, on === true)} />
                          )}
                        </td>
                      ))}
                    </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("role_no_targets")}</p>
          )}
          <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            {OPS.map((op) => (
              <li key={op} className="flex gap-1.5">
                <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  <b className="font-medium text-foreground">{t(`role_${op}` as never)}</b> {t(`role_${op}_hint` as never)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="cms-role-people">
        <div className="flex flex-col gap-0.5">
          <h2 id="cms-role-people" className="text-sm font-medium">
            {t("role_people", { n: members.length })}
          </h2>
          <p className="text-xs text-muted-foreground">{t("role_people_now")}</p>
        </div>
        <PersonPicker label={t("role_person")} placeholder={t("role_person_placeholder")} search={search} exclude={members.map((m) => m.id)} disabled={busy} onPick={(p) => addMember({ id: p.id, label: p.label })} onEmail={(email) => addMember({ email })} emailLabel={(email) => t("role_person_by_email", { email })} />
        {members.length ? (
          <ul className="flex max-w-xl flex-col divide-y rounded-md border">
            {members.map((m) => (
              <li key={m.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <PersonMark id={m.id} label={m.label} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <bdi className="truncate text-sm font-medium">
                    {m.label}
                    {m.id === myId ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("role_you")}</span> : null}
                  </bdi>
                  {m.email && m.email !== m.label ? <span className="truncate text-xs text-muted-foreground">{m.email}</span> : null}
                </span>
                {m.pending ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200" title={t("role_person_pending_hint")}>
                    {t("role_person_pending")}
                  </span>
                ) : null}
                <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-muted-foreground hover:text-destructive" aria-label={t("role_remove_person", { name: m.label })} disabled={busy} onClick={() => (m.id === myId && role.admin ? setRemoving(m) : void removeMember(m))}>
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="max-w-prose text-sm text-muted-foreground">{t("role_no_people_hint")}</p>
        )}
      </section>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("role_delete_title", { name: role.name })}
        description={t("role_delete_text", { n: members.length })}
        confirmLabel={t("action_delete")}
        destructive
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await client.removeRole(role.id);
            toast(t("role_deleted", { name: role.name }), { tone: "ok" });
            dirtyRef.current = false;
            onDeleted();
          } catch (err) {
            setError(errorMessage(err, t));
          } finally {
            setBusy(false);
            setConfirming(false);
          }
        }}
      />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={t("role_remove_self_title")} description={t("role_remove_self_text")} confirmLabel={t("role_remove_self_ok")} destructive onConfirm={() => (removing ? void removeMember(removing) : undefined, setRemoving(null))} />
    </form>
  );
}
