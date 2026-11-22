/**
 * Roles: what a person may do, set on a screen instead of in code. A role lists, per collection,
 * read, write, publish and delete. People are found by name or email: from the app
 * (`createCms({ users })`), from the CMS's own sign-in, and from everyone who has used the
 * admin (the CMS remembers who it has seen). Someone who has never signed in is added by
 * email and joins the role at their first visit.
 *
 * Order of decisions: the system actor, then a collection's own `access` function (code wins; the
 * screen shows it as "set in code"), then roles, then the default (admins only). An app that
 * never makes a role behaves exactly as before.
 */
import type { CmsErrorCode, CmsErrorOptions, ErrorParams } from "./errors";
import type { CmsRepo } from "./repo";
import type { Actor, AuditAction, CmsRecord } from "./types";

/** `html`: add or change HTML. `html_scripts`: HTML that runs in an isolated frame (0.15.0). */
export const ROLE_OPS = ["read", "write", "publish", "delete", "html", "html_scripts"] as const;
export type RoleOp = (typeof ROLE_OPS)[number];
/** Target → what is allowed. A target is a collection slug. */
export type RolePermissions = Record<string, Partial<Record<RoleOp, boolean>>>;

export interface RoleMember {
  id: string;
  label: string;
  email?: string | null;
  /** Added by email and not seen yet: joins at the first visit with that email. */
  pending?: boolean;
}
/** Someone to pick: from the app, the CMS's sign-in or the people the CMS has seen. */
export interface PersonMatch extends RoleMember {
  /** When the CMS last saw them (null: only the app knows them). */
  lastSeenAt?: string | null;
}
export interface CmsRole {
  id: string;
  name: string;
  /** Everything, including keys, webhooks, automations and roles. `permissions` is not read. */
  admin: boolean;
  permissions: RolePermissions;
  members: RoleMember[];
  createdAt: string;
  updatedAt: string;
}
export interface RoleInput {
  name?: string;
  admin?: boolean;
  permissions?: RolePermissions;
}
/** Where the people come from: `createCms({ users })`. Without it members are added by id. */
export interface UsersOptions {
  search(q: string): Promise<RoleMember[]> | RoleMember[];
  get?(id: string): Promise<RoleMember | null> | RoleMember | null;
}

type RoleData = Omit<CmsRole, "id" | "createdAt" | "updatedAt">;
const KIND = "role";
/** People the CMS has seen (key: the user id). */
const PERSON = "person";
const SEEN_EVERY_MS = 10 * 60_000;
const emailOk = (e: string) => /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/.test(e) && e.length <= 254;
const REFRESH_MS = 15_000;

export interface RolesContext {
  repo: CmsRepo;
  now: () => Date;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  audit: (actor: Actor, action: AuditAction, o?: { detail?: Record<string, unknown> }) => void;
  /** Admin by the app's word, a key's scope or the system (not through a role). */
  baseAdmin: (actor: Actor) => boolean;
  ready: () => Promise<void> | void;
  targets: () => { slug: string; label: string; coded: RoleOp[] }[];
  users?: UsersOptions;
}

export function createRoles(ctx: RolesContext) {
  const { repo, fail } = ctx;
  const iso = () => ctx.now().toISOString();
  let cache: CmsRole[] = [];
  let loadedAt = 0;
  let loading: Promise<void> | null = null;
  const view = (r: CmsRecord): CmsRole => ({ ...(r.data as unknown as RoleData), id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt });

  async function load(force = false): Promise<void> {
    if (!force && loadedAt && ctx.now().getTime() - loadedAt < REFRESH_MS) return;
    loading ??= (async () => {
      try {
        cache = (await repo.listRecords({ kind: KIND, order: "asc", limit: 500 })).map(view);
        loadedAt = ctx.now().getTime();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }
  const lower = (e?: string | null) => (e ? e.trim().toLowerCase() : null);
  const isMember = (m: RoleMember, id: string, email?: string | null) => m.id === id || (!!m.pending && !!email && m.email === lower(email));
  const rolesOf = (id: string, email?: string | null) => cache.filter((r) => r.members.some((m) => isMember(m, id, email)));
  const actorRoles = (actor: Actor) => (actor.kind === "user" ? rolesOf(actor.id, actor.email) : []);
  /** Admin through a role (read from memory: `load()` runs before every request). */
  const roleAdmin = (actor: Actor) => actorRoles(actor).some((r) => r.admin);

  const lastSeen = new Map<string, number>();
  type PersonData = { label: string; email: string | null; lastSeenAt: string };
  async function people(): Promise<PersonMatch[]> {
    return (await repo.listRecords({ kind: PERSON, limit: 5000 })).map((r) => {
      const d = r.data as unknown as PersonData;
      return { id: r.key!, label: d.label, email: d.email, lastSeenAt: d.lastSeenAt };
    });
  }
  /** Notes that a person used the CMS (at most every 10 minutes each), and turns email invitations to roles into memberships. */
  async function seen(actor: Actor): Promise<void> {
    if (actor.kind !== "user" || actor.agent) return;
    const t = ctx.now().getTime();
    if (t - (lastSeen.get(actor.id) ?? 0) < SEEN_EVERY_MS) return;
    lastSeen.set(actor.id, t);
    if (lastSeen.size > 20_000) lastSeen.clear();
    const data: PersonData = { label: actor.label || actor.id, email: lower(actor.email), lastSeenAt: iso() };
    try {
      const cur = await repo.findRecordByKey(PERSON, actor.id);
      if (cur) await repo.updateRecord(PERSON, cur.id, { data: data as unknown as Record<string, unknown>, at: iso() });
      else await repo.insertRecord({ kind: PERSON, key: actor.id, data: data as unknown as Record<string, unknown>, at: iso() });
      const email = data.email;
      if (!email) return;
      await load();
      for (const r of cache.filter((x) => x.members.some((m) => m.pending && m.email === email))) {
        const members = r.members.filter((m) => !(m.pending && m.email === email));
        if (!members.some((m) => m.id === actor.id)) members.push({ id: actor.id, label: data.label, email });
        await save(r.id, { name: r.name, admin: r.admin, permissions: r.permissions, members });
        ctx.audit({ kind: "system", label: "first sign-in" }, "role.member.add", { detail: { id: r.id, name: r.name, member: actor.id, label: data.label, email } });
      }
    } catch {
      // Remembering people is a convenience: it never fails a request.
    }
  }
  async function findPeople(q: string): Promise<PersonMatch[]> {
    const s = q.trim().toLowerCase().slice(0, 100);
    const known = await people();
    const fromApp = ctx.users ? ((await ctx.users.search(s)) ?? []).map((u) => ({ id: String(u.id), label: String(u.label), email: lower((u as RoleMember).email), lastSeenAt: null as string | null })) : [];
    const out = new Map<string, PersonMatch>();
    for (const u of fromApp) out.set(u.id, { ...u, lastSeenAt: known.find((k) => k.id === u.id)?.lastSeenAt ?? null });
    for (const k of known) {
      if (out.has(k.id)) continue;
      if (!s || k.label.toLowerCase().includes(s) || (k.email ?? "").includes(s) || k.id.toLowerCase() === s) out.set(k.id, k);
    }
    return [...out.values()].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.label.localeCompare(b.label)).slice(0, 20);
  }
  const isAdmin = (actor: Actor) => ctx.baseAdmin(actor) || roleAdmin(actor);
  function admin(actor: Actor) {
    if (!isAdmin(actor)) throw fail(actor.kind === "anonymous" ? "unauthorized" : "forbidden_roles");
  }
  async function found(id: string): Promise<CmsRole> {
    const r = await repo.findRecord(KIND, id);
    if (!r) throw fail("role_not_found");
    return view(r);
  }
  function clean(i: RoleInput, cur?: CmsRole): RoleData {
    const name = (i.name ?? cur?.name ?? "").trim();
    if (!name || name.length > 60) throw fail("name_invalid", { max: 60 });
    const known = new Set(ctx.targets().map((t) => t.slug));
    const permissions: RolePermissions = {};
    for (const [target, ops] of Object.entries(i.permissions ?? cur?.permissions ?? {})) {
      if (!known.has(target)) throw fail("unknown_collection", { collection: target });
      const row: Partial<Record<RoleOp, boolean>> = {};
      for (const op of ROLE_OPS) if (ops?.[op]) row[op] = true;
      // Writing, publishing and deleting make no sense without reading.
      if (Object.keys(row).length) permissions[target] = { ...row, read: true };
    }
    return { name, admin: i.admin ?? cur?.admin ?? false, permissions, members: cur?.members ?? [] };
  }
  /** Two roles with one name cannot be told apart on the screen. */
  async function unique(name: string, except?: string) {
    await load(true);
    if (cache.some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase())) throw fail("name_taken", { name });
  }
  /** The app's admins and API keys are outside the roles, so the last member of an admin role may only leave when someone else still is an admin. */
  async function save(id: string, data: RoleData) {
    const r = await repo.updateRecord(KIND, id, { data: data as unknown as Record<string, unknown>, at: iso() });
    await load(true);
    return view(r!);
  }

  return {
    /** Call before deciding anything: refreshes the roles kept in memory (every 15 seconds, or now after a change). */
    load,
    /** The roles a person is in (from memory: call `load` first). */
    of: (userId: string, email?: string | null) => rolesOf(userId, email),
    /** Remember that a person used the CMS; their email invitations to roles take effect. */
    seen,
    isAdmin,
    /**
     * What the roles say about one operation: true or false when the person is in a role,
     * undefined when they are in none (the default rule applies then).
     */
    allows(actor: Actor, target: string, op: RoleOp): boolean | undefined {
      if (actor.kind !== "user") return undefined;
      const mine = actorRoles(actor);
      if (!mine.length) return undefined;
      return mine.some((r) => r.admin || !!r.permissions[target]?.[op]);
    },
    async list(actor: Actor): Promise<{ roles: CmsRole[]; targets: { slug: string; label: string; coded: RoleOp[] }[]; users: boolean }> {
      admin(actor);
      await ctx.ready();
      await load(true);
      return { roles: cache, targets: ctx.targets(), users: !!ctx.users };
    },
    async create(actor: Actor, input: RoleInput): Promise<CmsRole> {
      admin(actor);
      await ctx.ready();
      const data = clean(input);
      await unique(data.name);
      const r = await repo.insertRecord({ kind: KIND, data: data as unknown as Record<string, unknown>, at: iso() });
      await load(true);
      ctx.audit(actor, "role.create", { detail: { id: r.id, name: data.name } });
      return view(r);
    },
    async update(actor: Actor, id: string, input: RoleInput): Promise<CmsRole> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      const data = clean(input, cur);
      if (data.name !== cur.name) await unique(data.name, id);
      // Taking "admin" off the role that makes you an admin would lock you out of this screen.
      if (cur.admin && !data.admin && !ctx.baseAdmin(actor) && actor.kind === "user" && !cache.some((r) => r.id !== id && r.admin && r.members.some((m) => m.id === actor.id))) throw fail("role_last_admin");
      const role = await save(id, data);
      ctx.audit(actor, "role.update", { detail: { id, name: role.name } });
      return role;
    },
    async remove(actor: Actor, id: string): Promise<void> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      if (cur.admin && !ctx.baseAdmin(actor) && actor.kind === "user" && !cache.some((r) => r.id !== id && r.admin && r.members.some((m) => m.id === actor.id))) throw fail("role_last_admin");
      await repo.deleteRecords({ kind: KIND, id });
      await load(true);
      ctx.audit(actor, "role.delete", { detail: { id, name: cur.name } });
    },
    /**
     * Adds someone: `{ id }` for a person found by search, or `{ email }`. An email the CMS
     * knows becomes that person; an unknown one waits (`pending`) until they first sign in.
     */
    async addMember(actor: Actor, id: string, member: { id?: string; email?: string; label?: string }): Promise<CmsRole> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      let entry: RoleMember;
      if (member.email !== undefined && !member.id) {
        const email = lower(member.email)!;
        if (!emailOk(email)) throw fail("email_invalid", { email: member.email.slice(0, 80) });
        const match = (await people()).find((p) => p.email === email) ?? (await findPeople(email)).find((p) => p.email === email);
        entry = match ? { id: match.id, label: match.label, email } : { id: `email:${email}`, label: email, email, pending: true };
      } else {
        const userId = (member.id ?? "").trim();
        if (!userId || userId.length > 200) throw fail("name_invalid", { max: 200 });
        const known = (await ctx.users?.get?.(userId)) ?? (await people()).find((p) => p.id === userId) ?? null;
        const label = (known?.label ?? member.label ?? userId).trim().slice(0, 120) || userId;
        entry = { id: userId, label, email: lower((known as RoleMember | null)?.email) };
      }
      if (cur.members.some((m) => m.id === entry.id || (entry.email && m.email === entry.email))) return cur;
      const role = await save(id, { name: cur.name, admin: cur.admin, permissions: cur.permissions, members: [...cur.members, entry] });
      ctx.audit(actor, "role.member.add", { detail: { id, name: cur.name, member: entry.id, label: entry.label, pending: !!entry.pending } });
      return role;
    },
    async removeMember(actor: Actor, id: string, userId: string): Promise<CmsRole> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      if (!cur.members.some((m) => m.id === userId)) return cur;
      if (cur.admin && actor.kind === "user" && actor.id === userId && !ctx.baseAdmin(actor) && !cache.some((r) => r.id !== id && r.admin && r.members.some((m) => m.id === userId))) throw fail("role_last_admin");
      const role = await save(id, { name: cur.name, admin: cur.admin, permissions: cur.permissions, members: cur.members.filter((m) => m.id !== userId) });
      ctx.audit(actor, "role.member.remove", { detail: { id, name: cur.name, member: userId } });
      return role;
    },
    /** People to add, by name or email: the app's (`createCms({ users })`), the sign-in's, and everyone the CMS has seen. Most recently active first. */
    async searchUsers(actor: Actor, q: string): Promise<PersonMatch[]> {
      admin(actor);
      await ctx.ready();
      return findPeople(q);
    },
  };
}

export type CmsRoles = ReturnType<typeof createRoles>;
