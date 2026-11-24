/** 0.23.0 (plugin v2): options, engine, requires, start/stop, failure isolation, the plugin list. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { definePlugin, versionSatisfies, type CmsPlugin, type PluginInput } from "./plugin";
import { orderPlugins } from "./plugins";
import { MemoryRepo } from "./repo";
import { toolsFor } from "./tools";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const writer: typeof admin = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(plugins: PluginInput[], o: { as?: typeof admin; startTimeoutMs?: number } = {}) {
  const errors: string[] = [];
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], plugins, pluginStartTimeoutMs: o.startTimeoutMs, onError: (_e, where) => void errors.push(where) });
  const handler = createCmsHandler({ cms, resolveUser: async () => o.as ?? admin });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch;
  const api = createRestClient({ url: "http://app.test/api/cms", fetch: doFetch });
  return { cms, api, doFetch, errors };
}

/** A plugin that records what happens to it. */
function probe(name: string, log: string[], o: Partial<CmsPlugin> & { fail?: () => boolean; wait?: number } = {}): CmsPlugin {
  return {
    name,
    ...o,
    setup(ctx) {
      log.push(`setup ${name}`);
      ctx.route("GET", "ping", () => Response.json({ name }));
      ctx.tool({ name: `${name.replace(/-/g, "_")}_ping`, description: "ping", input: z.object({}), run: () => ({ ok: true }) });
      ctx.nav({ label: name, href: `/admin/p/${name}` });
      ctx.me(() => ({ here: true }));
      ctx.on("doc.created", () => void log.push(`event ${name}`));
    },
    async start() {
      log.push(`start ${name}`);
      if (o.wait) await new Promise((r) => setTimeout(r, o.wait));
      if (o.fail?.()) throw new Error(`${name} could not connect`);
    },
    stop() {
      log.push(`stop ${name}`);
    },
  };
}

test("versions: engine ranges", () => {
  for (const [v, r, ok] of [
    ["0.23.0", ">=0.23", true],
    ["0.22.9", ">=0.23", false],
    ["0.23.4", "^0.23.0", true],
    ["0.24.0", "^0.23.0", false],
    ["1.4.0", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["0.23.1", "~0.23.0", true],
    ["0.23.1", "0.23.x", true],
    ["0.24.0", "0.23", false],
    ["0.23.0-next.20261124.abc", ">=0.23 <0.24", true],
    ["0.30.0", "<0.24 || >=0.30", true],
    ["0.25.0", "<0.24 || >=0.30", false],
    ["0.23.0", "*", true],
  ] as const) assert.equal(versionSatisfies(v, r), ok, `${v} in ${r}`);
  assert.throws(() => definePlugin({ name: "bad-engine", engine: "soon", setup() {} }), /not a version range/);
  assert.throws(() => setup([{ name: "future", engine: ">=9", setup() {} }]), /works with agent-cms >=9/);
});

test("options: checked with zod, defaults filled in, given called or as is", async () => {
  const seen: unknown[] = [];
  const slack = definePlugin({
    name: "slack-notify",
    version: "0.3.0",
    options: z.object({ channel: z.string().regex(/^#/).default("#content"), mention: z.boolean().default(false) }),
    setup(_ctx, options) {
      seen.push(options);
    },
  });
  assert.equal(slack.pluginName, "slack-notify");
  setup([slack]);
  setup([slack({ channel: "#news" })]);
  assert.deepEqual(seen, [
    { channel: "#content", mention: false },
    { channel: "#news", mention: false },
  ]);
  assert.throws(() => slack({ channel: "news" }), /plugin slack-notify: options are not valid \(channel: /);
});

test("order: what a plugin needs is set up and started first; a circle is refused", async () => {
  const log: string[] = [];
  const { cms, api } = setup([probe("b-two", log, { requires: ["a-one"] }), probe("a-one", log)]);
  assert.deepEqual(cms.plugins.names, ["webhooks", "automations", "a-one", "b-two"], "the built-in plugins come first");
  await api.me();
  assert.deepEqual(log, ["setup a-one", "setup b-two", "start a-one", "start b-two"]);
  assert.throws(
    () => orderPlugins([{ name: "x-x", requires: ["y-y"], setup() {} }, { name: "y-y", requires: ["x-x"], setup() {} }]),
    /in a circle: x-x → y-y → x-x/,
  );
  assert.throws(() => setup([probe("lonely", [], { requires: ["ghost"], required: true })]), /needs the plugin "ghost", which is not given/);
});

test("start: runs once before the first request; a plugin that needs a missing one is off", async () => {
  const log: string[] = [];
  const { cms, api, doFetch } = setup([probe("needy", log, { requires: ["ghost"] }), probe("fine", log)]);
  assert.deepEqual(log, ["setup fine"], "the one that needs a missing plugin is not even set up");
  await Promise.all([api.me(), api.me(), api.me()]);
  assert.deepEqual(log, ["setup fine", "start fine"], "started once for many requests");
  const needy = cms.plugins.get("needy")!;
  assert.deepEqual([needy.state, needy.error], ["off", 'needs the plugin "ghost", which is not given to createCms']);
  const r = await doFetch("http://app.test/api/cms/needy/ping");
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "plugin_failed");
  assert.equal((await doFetch("http://app.test/api/cms/fine/ping")).status, 200);
});

test("failure: a plugin that cannot start is off with the ones that need it; the CMS goes on", async () => {
  const log: string[] = [];
  const down = { now: true };
  const { cms, api, doFetch, errors } = setup([probe("vectors", log, { fail: () => down.now }), probe("answers", log, { requires: ["vectors"] }), probe("other", log)]);
  const me = await api.me();
  assert.deepEqual(log, ["setup vectors", "setup answers", "setup other", "start vectors", "stop vectors", "start other"], "the failed one is stopped again; the one that needs it never starts");
  assert.deepEqual(
    cms.plugins.list().filter((p) => !p.builtin).map((p) => [p.name, p.state, p.error]),
    [
      ["vectors", "failed", "vectors could not connect"],
      ["answers", "off", 'needs the plugin "vectors", which is failed'],
      ["other", "running", null],
    ],
  );
  assert.ok(errors.includes("plugin vectors: start"));
  // What the failed ones added is out of use.
  assert.deepEqual(Object.keys(me.plugins ?? {}), ["other"]);
  assert.deepEqual((me.nav ?? []).map((n) => n.plugin), ["other"]);
  assert.deepEqual(toolsFor(cms, admin).filter((t) => t.name.endsWith("_ping")).map((t) => t.name), ["other_ping"]);
  assert.equal((await doFetch("http://app.test/api/cms/vectors/ping")).status, 503);
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await tick();
  assert.deepEqual(log.filter((l) => l.startsWith("event")), ["event other"]);

  // Fixed: a restart starts it and the ones that need it again.
  down.now = false;
  const again = await api.restartPlugin("vectors");
  assert.equal(again.plugin.state, "running");
  assert.equal(cms.plugins.get("answers")!.state, "running");
  assert.equal((await doFetch("http://app.test/api/cms/answers/ping")).status, 200);
  const audit = (await cms.audit(admin, { limit: 5 })).entries;
  assert.ok(audit.some((e) => e.action === "plugin.restart" && e.slug === "vectors"));
});

test("required: the CMS answers 503 plugin_failed until the plugin starts", async () => {
  const log: string[] = [];
  const down = { now: true };
  const { api, doFetch } = setup([probe("auth-bridge", log, { required: true, fail: () => down.now })]);
  const err = await api.list("guide").then(
    () => null,
    (e) => e,
  );
  assert.ok(isCmsRemoteError(err));
  assert.deepEqual([err.status, err.code], [503, "plugin_failed"]);
  // Admins can still reach /plugins and _me to fix it.
  assert.equal((await api.plugins()).plugins.find((p) => p.name === "auth-bridge")?.state, "failed");
  down.now = false;
  assert.ok(await api.list("guide"), "the next request tries again");
  void doFetch;
  assert.equal(log.at(-1), "start auth-bridge");
  assert.ok(!log.slice(0, -1).some((l, i) => l === "start auth-bridge" && log[i + 1] !== "stop auth-bridge"), "every failed start was stopped again");
});

test("start timeout: a start that hangs counts as failed", async () => {
  const log: string[] = [];
  const { cms, api } = setup([probe("slow", log, { wait: 200 })], { startTimeoutMs: 20 });
  await api.me();
  const slow = cms.plugins.get("slow")!;
  assert.deepEqual([slow.state, slow.error], ["failed", "plugin slow: start took longer than 20 ms"]);
});

test("close: plugins stop last started first; the list is for admins", async () => {
  const log: string[] = [];
  const { cms, api } = setup([probe("a-one", log), probe("b-two", log, { requires: ["a-one"], version: "1.2.0", engine: ">=0.22" })]);
  const plugins = (await api.plugins()).plugins.filter((p) => !p.builtin);
  assert.deepEqual(plugins[1], {
    name: "b-two",
    builtin: false,
    version: "1.2.0",
    engine: ">=0.22",
    requires: ["a-one"],
    required: false,
    state: "running",
    error: null,
    startedMs: plugins[1].startedMs,
    startedAt: plugins[1].startedAt,
    registered: { routes: 1, tools: 1, events: 1, jobs: 0, nav: 1, me: 1, sql: 0, hooks: 0, collections: 0, fields: 0, actions: 0, filters: 0, access: 0 },
    settings: null,
  });
  const unknown = await api.plugin("nope").then(
    () => null,
    (e) => e,
  );
  assert.equal(unknown?.code, "plugin_unknown");
  await cms.close();
  assert.deepEqual(log.slice(-2), ["stop b-two", "stop a-one"]);
  assert.equal(await api.me().then(() => "ok", (e) => e.code), "plugin_failed", "a closed CMS answers nothing more");
  await cms.close();
  assert.equal(log.filter((l) => l.startsWith("start")).length, 2, "nothing starts again after close");

  const { api: asWriter } = setup([probe("a-one", [])], { as: writer });
  const err = await asWriter.plugins().then(
    () => null,
    (e) => e,
  );
  assert.equal(err?.code, "forbidden");
});

test("v1 plugins (0.12 to 0.22) work unchanged, without start or stop", async () => {
  const got: string[] = [];
  const old = definePlugin({ name: "old-style", setup: (ctx) => ctx.on("doc.created", (e) => void got.push(e.slug ?? "")) });
  const { cms, api } = setup([old]);
  // Events heard even before any request (a script using the CMS directly).
  await cms.create(admin, "guide", { slug: "early", title: "E", body: "x\n" });
  await api.me();
  await cms.create(admin, "guide", { slug: "late", title: "L", body: "x\n" });
  await tick();
  assert.deepEqual(got, ["early", "late"]);
  assert.equal(cms.plugins.get("old-style")!.state, "running");
});

test("v1: a plugin may keep ctx.secrets from setup", () => {
  let kept: unknown = "unset";
  const p = definePlugin({ name: "keeper", setup: ({ secrets }) => void (kept = secrets) });
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  createCms({ repo: new MemoryRepo(), collections: [guide], plugins: [p], secretsKey: "k".repeat(40) });
  assert.ok(kept && typeof (kept as { seal?: unknown }).seal === "function");
});
