// agent-cms registry: cms-roles (0.13.0). Copied into your app by `npx @mainsoft/agent-cms add`; edit freely.
//
// Roles: the list, and for the selected one its name, what it may do in each
// collection (read, write, publish, delete) and the people in it. Admins only.
// Collections whose access is decided in code show "Set in code" instead of a box.
"use client";

import * as React from "react";
import { Plus, Shield, X } from "lucide-react";
import type { CmsRole, RoleOp, RolePermissions } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessage } from "./cms-messages";
import { ConfirmDialog, PageHeader, StatusText } from "./cms-parts";
import { useAsync, useCms } from "./use-cms";

const OPS: RoleOp[] = ["write", "publish", "delete"];

export function CmsRoles({ className }: { className?: string }) {
  const { client, t } = useCms();
  const data = useAsync(() => client.roles(), [client]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const roles = data.data?.roles ?? [];
  const open = roles.find((r) => r.id === openId) ?? roles[0] ?? null;
  const [busy, setBusy] = React.useState(false);

  async function add() {
    setBusy(true);
    try {
      const r = await client.createRole({ name: `${t("role_new")} ${roles.length + 1}` });
      setOpenId(r.id);
      data.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader title={t("roles_title")}>
        <Button type="button" className="gap-1.5" disabled={busy} onClick={add}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("role_new")}
        </Button>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("roles_title")} className="shrink-0 border-b p-3 md:w-52 md:border-b-0 md:border-r">
          <StatusText tone={data.error ? "error" : "muted"} className="px-1 text-xs">
            {data.error ? errorMessage(data.error, t) : data.loading && !data.data ? t("loading") : ""}
          </StatusText>
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {roles.map((r) => (
              <li key={r.id} className="shrink-0">
                <button type="button" aria-current={r.id === open?.id ? "true" : undefined} onClick={() => setOpenId(r.id)} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", r.id === open?.id && "bg-accent font-medium")}>
                  <Shield aria-hidden className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate text-left">{r.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{r.members.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {data.data && !roles.length ? <p className="max-w-prose text-sm text-muted-foreground">{t("roles_empty")}</p> : null}
          {open && data.data ? <RoleForm key={open.id} role={open} targets={data.data.targets} users={data.data.users} onChanged={data.reload} onDeleted={() => (setOpenId(null), data.reload())} /> : null}
        </div>
      </div>
    </div>
  );
}

function RoleForm({ role, targets, users, onChanged, onDeleted }: { role: CmsRole; targets: { slug: string; label: string; coded: RoleOp[] }[]; users: boolean; onChanged: () => void; onDeleted: () => void }) {
  const { client, t } = useCms();
  const [name, setName] = React.useState(role.name);
  const [admin, setAdmin] = React.useState(role.admin);
  const [perms, setPerms] = React.useState<RolePermissions>(role.permissions);
  const [members, setMembers] = React.useState(role.members);
  const [person, setPerson] = React.useState("");
  const [found, setFound] = React.useState<{ id: string; label: string }[]>([]);
  const [status, setStatus] = React.useState<{ text: string; tone: "ok" | "error" | "muted" }>({ text: "", tone: "muted" });
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (!users || person.trim().length < 1) return setFound([]);
    let live = true;
    const timer = setTimeout(() => client.searchUsers(person).then((u) => live && setFound(u.filter((x) => !members.some((m) => m.id === x.id))), () => undefined), 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, users, person, members]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setStatus({ text: await fn(), tone: "ok" });
      onChanged();
    } catch (e) {
      setStatus({ text: errorMessage(e, t), tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const set = (slug: string, op: RoleOp, on: boolean) => setPerms((p) => ({ ...p, [slug]: { ...p[slug], [op]: on } }));
  const addMember = (m: { id: string; label?: string }) =>
    run(async () => {
      setMembers((await client.addRoleMember(role.id, m)).members);
      setPerson("");
      return "";
    });

  return (
    <form className="flex max-w-3xl flex-col gap-5" onSubmit={(e) => (e.preventDefault(), void run(async () => (await client.updateRole(role.id, { name, admin, permissions: perms }), t("role_saved"))))}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="cms-role-name">{t("role_name")}</Label>
          <Input id="cms-role-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} className="max-w-xs" />
        </div>
        <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirming(true)}>
          {t("action_delete")}
        </Button>
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={admin} onCheckedChange={(on) => setAdmin(on === true)} />
        {t("role_admin")}
      </label>
      <StatusText tone={status.tone} className="text-xs">
        {status.text}
      </StatusText>
      {admin ? null : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("role_target")}</TableHead>
                {OPS.map((op) => (
                  <TableHead key={op} className="w-20">
                    {t(`role_${op}` as never)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {targets.map((tg) => (
                <TableRow key={tg.slug}>
                  <TableCell className="font-medium">{tg.label}</TableCell>
                  {OPS.map((op) => (
                    <TableCell key={op}>
                      {tg.coded.includes(op) ? <span className="whitespace-nowrap text-xs text-muted-foreground">{t("role_coded")}</span> : <Checkbox aria-label={`${tg.label}: ${t(`role_${op}` as never)}`} checked={!!perms[tg.slug]?.[op]} onCheckedChange={(on) => set(tg.slug, op, on === true)} />}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <section className="flex flex-col gap-2" aria-labelledby="cms-role-people">
        <h2 id="cms-role-people" className="text-xs font-medium text-muted-foreground">
          {t("role_people", { n: members.length })}
        </h2>
        <ul className="flex flex-wrap gap-1.5">
          {members.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-sm">
              {m.label}
              <button type="button" aria-label={t("role_remove_person", { name: m.label })} className="rounded outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring" onClick={() => run(async () => (setMembers((await client.removeRoleMember(role.id, m.id)).members), ""))}>
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {members.length ? null : <li className="text-sm text-muted-foreground">{t("role_no_people")}</li>}
        </ul>
        <div className="flex max-w-sm items-center gap-2">
          <Input aria-label={users ? t("role_person") : t("role_person_id")} placeholder={users ? t("role_person") : t("role_person_id")} value={person} onChange={(e) => setPerson(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !users && person.trim() && (e.preventDefault(), void addMember({ id: person.trim() }))} />
          {users ? null : (
            <Button type="button" variant="outline" disabled={!person.trim() || busy} onClick={() => addMember({ id: person.trim() })}>
              {t("role_add_person")}
            </Button>
          )}
        </div>
        {found.length ? (
          <ul className="flex max-w-sm flex-col rounded-md border p-1" aria-label={t("role_person")}>
            {found.map((u) => (
              <li key={u.id}>
                <button type="button" className="flex h-8 w-full items-center rounded px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent" onClick={() => addMember(u)}>
                  {u.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={t("role_delete_title", { name: role.name })} description={t("role_delete_text", { n: members.length })} confirmLabel={t("action_delete")} destructive busy={busy} onConfirm={() => run(async () => (await client.removeRole(role.id), onDeleted(), ""))} />
    </form>
  );
}
