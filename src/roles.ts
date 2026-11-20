/**
 * Roles: what a person may do, set on a screen instead of in code. A role lists, per collection,
 * read, write, publish and delete. People are put into roles by the
 * id the app's `resolveUser` gives them.
 *
 * Order of decisions: the system actor, then a collection's own `access` function (code wins; the
 * screen shows it as "set in code"), then roles, then the default (admins only). An app that
 * never makes a role behaves exactly as before.
 */
import type { CmsErrorCode, CmsErrorOptions, ErrorParams } from "./errors";
import type { CmsRepo } from "./repo";
import type { Actor, AuditAction, CmsRecord } from "./types";

export const ROLE_OPS = ["read", "write", "publish", "delete"] as const;
export type RoleOp = (typeof ROLE_OPS)[number];
/** Target → what is allowed. A target is a collection slug. */
export type RolePermissions = Record<string, Partial<Record<RoleOp, boolean>>>;

export interface RoleMember {
  id: string;
  label: string;
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
  const rolesOf = (id: string) => cache.filter((r) => r.members.some((m) => m.id === id));
  /** Admin through a role (read from memory: `load()` runs before every request). */
  const roleAdmin = (actor: Actor) => actor.kind === "user" && rolesOf(actor.id).some((r) => r.admin);
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
  /** The app's admins and API keys are outside the roles, so the last member of an admin role may only leave when someone else still is an admin. */
  async function save(id: string, data: RoleData) {
    const r = await repo.updateRecord(KIND, id, { data: data as unknown as Record<string, unknown>, at: iso() });
    await load(true);
    return view(r!);
  }

  return {
    /** Call before deciding anything: refreshes the roles kept in memory (every 15 seconds, or now after a change). */
    load,
    isAdmin,
    /**
     * What the roles say about one operation: true or false when the person is in a role,
     * undefined when they are in none (the default rule applies then).
     */
    allows(actor: Actor, target: string, op: RoleOp): boolean | undefined {
      if (actor.kind !== "user") return undefined;
      const mine = rolesOf(actor.id);
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
    async addMember(actor: Actor, id: string, member: { id: string; label?: string }): Promise<CmsRole> {
      admin(actor);
      await ctx.ready();
      const cur = await found(id);
      const userId = member.id.trim();
      if (!userId || userId.length > 200) throw fail("name_invalid", { max: 200 });
      const known = (await ctx.users?.get?.(userId)) ?? null;
      const label = (known?.label ?? member.label ?? userId).trim().slice(0, 120) || userId;
      if (cur.members.some((m) => m.id === userId)) return cur;
      const role = await save(id, { name: cur.name, admin: cur.admin, permissions: cur.permissions, members: [...cur.members, { id: userId, label }] });
      ctx.audit(actor, "role.member.add", { detail: { id, name: cur.name, member: userId, label } });
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
    /** People to add, from the app (`createCms({ users })`). Empty without it. */
    async searchUsers(actor: Actor, q: string): Promise<RoleMember[]> {
      admin(actor);
      return ctx.users ? (await ctx.users.search(q.trim().slice(0, 100))).slice(0, 20).map((u) => ({ id: String(u.id), label: String(u.label) })) : [];
    },
  };
}

export type CmsRoles = ReturnType<typeof createRoles>;
