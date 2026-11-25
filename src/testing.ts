/**
 * `@mainsoft/agent-cms/testing` (0.24.0): a CMS in memory, for testing plugins.
 *
 *   import { createTestCms } from "@mainsoft/agent-cms/testing";
 *   import { test } from "node:test";
 *
 *   test("my plugin answers", async () => {
 *     const t = createTestCms({ plugins: [myPlugin()] });
 *     const res = await t.fetch("/my-plugin/hello");
 *     assert.equal(res.status, 200);
 *     await t.close();
 *   });
 *
 * Everything runs in this process: a memory repository, the HTTP handler without a server,
 * and three people (`admin`, `writer`, `anon`). No database, no network.
 */

import { createCms, defineCollection, type AnyCollection, type Cms, type CreateCmsOptions } from "./cms";
import { createRestClient, type RestClient } from "./client";
import { createCmsHandler, type CmsHandlerOptions } from "./http";
import { MemoryRepo, type CmsRepo } from "./repo";
import { runTool, type ToolOutcome } from "./tools";
import type { JobsRun } from "./jobs";
import type { ScheduledRun } from "./flow";
import type { Actor } from "./types";

/** A signed-in person, as `resolveUser` returns one. */
export type TestUser = Extract<Actor, { kind: "user" }>;

/** Who a call is made as: one of the three test people, or your own. */
export type TestAs = "admin" | "writer" | "anon" | Actor;

/** Where `fetch` sends requests. Plugin routes are at `<TEST_BASE_URL>/<plugin name>/…`. */
export const TEST_BASE_URL = "http://test.local/api/cms";

/** A key of 32 characters, so sealed settings and webhooks work. Only for tests. */
export const TEST_SECRETS_KEY = "agent-cms-testing-key-0123456789";

const AS_HEADER = "x-agent-cms-test-as";

export type TestCmsOptions<C extends readonly AnyCollection[]> = Omit<CreateCmsOptions<C>, "repo" | "collections"> & {
  /** Default: one public collection, `pages`. */
  collections?: C;
  /** Default: a new `MemoryRepo`. */
  repo?: CmsRepo;
  /** More options for `createCmsHandler` (`mcp`, `publicOrigin`, …). */
  handler?: Omit<CmsHandlerOptions, "cms" | "resolveUser">;
  /** Give `writer` a role that may read and write every collection. Default true. */
  writerRole?: boolean;
};

export interface TestCms<C extends readonly AnyCollection[]> {
  /** The CMS. */
  cms: Cms<C>;
  /** Its memory repository: look at what was stored. */
  repo: CmsRepo;
  /** An admin (may do everything). */
  admin: TestUser;
  /** A person who is not an admin. With `writerRole` (the default) they may read and write every collection, not publish. */
  writer: TestUser;
  /** Nobody signed in. */
  anon: Actor;
  /**
   * A request to the CMS's HTTP API, as `as` (default `admin`). `path` is under `/api/cms`,
   * with or without the leading slash: `t.fetch("/stats/summary")`. A string body is sent as JSON.
   */
  fetch(path: string, init?: RequestInit, o?: { as?: TestAs }): Promise<Response>;
  /** The REST client the admin uses, as `as` (default `admin`). */
  client(as?: TestAs): RestClient;
  /**
   * Call an agent tool (yours or the CMS's) as `as` (default `admin`), like an agent would.
   * Returns `{ ok: true, value }`, or `{ ok: false, error }` for a refusal or bad input.
   */
  tool(name: string, input?: unknown, o?: { as?: TestAs }): Promise<ToolOutcome>;
  /** One cron call: what is scheduled, then the jobs that are due (yours too), then housekeeping. Waits for event listeners first. */
  cron(): Promise<ScheduledRun & { jobs: JobsRun }>;
  /** Wait for event listeners (`ctx.on`) that are still running after a write. */
  flush(): Promise<void>;
  /** Start the plugins (the first request does it too). Rejects when a `required` plugin cannot start. */
  ready(): Promise<void>;
  /** Save a plugin's settings, as the admin screen does, and restart it. */
  settings(plugin: string, values: Record<string, unknown>): Promise<void>;
  /** What `onError` heard (a listener, job or hook that threw), with where. Empty when you gave your own `onError`. */
  errors: { where: string; error: unknown }[];
  /** Stop the plugins and the CMS. Call it at the end of each test. */
  close(): Promise<void>;
}

/**
 * A CMS in memory with your plugins, for tests. Defaults: a `MemoryRepo`, one public
 * collection `pages`, a test `secretsKey`, no warnings on the console, and errors of
 * listeners, jobs and hooks kept in `errors` (give `onError` to change that).
 */
export function createTestCms<const C extends readonly AnyCollection[] = readonly AnyCollection[]>(o: TestCmsOptions<C> = {} as TestCmsOptions<C>): TestCms<C> {
  const { collections, repo: givenRepo, handler: handlerOptions, writerRole = true, ...rest } = o;
  const repo = givenRepo ?? new MemoryRepo();
  const errors: { where: string; error: unknown }[] = [];
  const cms = createCms({
    secretsKey: TEST_SECRETS_KEY,
    // Errors a listener, job or hook throws: kept, so a test can look at them.
    onError: (err: unknown, where: string) => void errors.push({ where, error: err }),
    warn: () => undefined,
    ...rest,
    repo,
    collections: (collections ?? [defineCollection({ slug: "pages", label: "Pages", visibility: "public" })]) as unknown as C,
  } as CreateCmsOptions<C>);

  const admin: TestUser = { kind: "user", id: "test-admin", label: "Admin", email: "admin@test.local", isAdmin: true };
  const writer: TestUser = { kind: "user", id: "test-writer", label: "Writer", email: "writer@test.local", isAdmin: false };
  const anon: Actor = { kind: "anonymous" };
  const own = new Map<string, TestUser>();
  const actorOf = (as: TestAs = "admin"): Actor => (as === "admin" ? admin : as === "writer" ? writer : as === "anon" ? anon : as);

  const handler = createCmsHandler({
    ...handlerOptions,
    cms,
    async resolveUser(req) {
      const id = req.headers.get(AS_HEADER);
      return id === admin.id ? admin : id === writer.id ? writer : id ? (own.get(id) ?? null) : null;
    },
  });

  // The writer's role, made once before the first call.
  let prepared: Promise<void> | null = null;
  const prepare = () =>
    (prepared ??= (async () => {
      if (!writerRole) return;
      const all = cms.collections().map((c) => c.slug);
      const role = await cms.roles.create(admin, { name: "Writer", permissions: Object.fromEntries(all.map((c) => [c, { read: true, write: true }])) });
      await cms.roles.addMember(admin, role.id, { id: writer.id, label: writer.label });
    })());

  /** Who the handler sees: a header it reads in `resolveUser`. */
  function headerFor(as?: TestAs): Record<string, string> {
    const a = actorOf(as);
    if (a.kind !== "user") return {};
    if (a.id !== admin.id && a.id !== writer.id) own.set(a.id, a);
    return { [AS_HEADER]: a.id };
  }

  async function call(input: string, init: RequestInit = {}, as?: TestAs): Promise<Response> {
    await prepare();
    const url = /^https?:\/\//.test(input) ? input : `${TEST_BASE_URL}/${input.replace(/^\/+/, "")}`;
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(headerFor(as))) headers.set(k, v);
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    return handler(new Request(url, { ...init, headers }));
  }

  // 0.24.1: until every listener has finished, awaits included (at most 5 s).
  const flush = () => cms.idle();

  return {
    cms,
    repo,
    admin,
    writer,
    anon,
    fetch: (path, init, opt) => call(path, init, opt?.as),
    client: (as) => createRestClient({ url: TEST_BASE_URL, fetch: ((input: RequestInfo | URL, init?: RequestInit) => call(String(input), init, as)) as typeof fetch }),
    async tool(name, input = {}, opt) {
      await prepare();
      return runTool(cms, actorOf(opt?.as), name, input);
    },
    async cron() {
      await prepare();
      await cms.plugins.start().catch(() => undefined);
      await flush();
      const r = await cms.cron();
      await flush();
      return r;
    },
    flush,
    async ready() {
      await prepare();
      await cms.plugins.start();
    },
    async settings(plugin, values) {
      await prepare();
      await cms.plugins.start().catch(() => undefined);
      try {
        const info = await cms.plugins.saveSettings(plugin, values);
        if (!info) throw new Error(`[agent-cms/testing] the plugin "${plugin}" has no settings`);
      } catch (err) {
        const invalid = (err as { invalid?: unknown }).invalid;
        if (invalid) throw new Error(`[agent-cms/testing] settings of ${plugin} do not fit: ${typeof invalid === "string" ? invalid : JSON.stringify(invalid)}`);
        throw err;
      }
    },
    errors,
    async close() {
      await cms.close();
    },
  };
}
