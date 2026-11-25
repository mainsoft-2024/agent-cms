import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { definePlugin } from "./plugin";
import { createTestCms, TEST_SECRETS_KEY } from "./testing";

/** A tiny plugin: a route, a tool, an event listener, a job and settings. */
const counter = definePlugin({
  name: "counter",
  version: "1.0.0",
  engine: ">=0.23",
  options: z.object({ step: z.number().default(1) }),
  settings: z.object({ label: z.string().default("Count"), token: z.string().optional().describe("secret: API token") }),
  setup(ctx, o) {
    ctx.route("GET", "value", async ({ actor }) => Response.json({ value: (await ctx.store.get<number>("n")) ?? 0, label: ctx.settings<{ label: string }>().label, who: actor.kind }));
    ctx.route("POST", "bump", async ({ actor }) => {
      if (actor.kind === "anonymous") return Response.json({ error: "sign in" }, { status: 401 });
      await ctx.store.set("n", ((await ctx.store.get<number>("n")) ?? 0) + o.step);
      return Response.json({ ok: true });
    });
    ctx.tool({ name: "counter_value", description: "The count", input: z.object({}), run: async () => ({ value: (await ctx.store.get<number>("n")) ?? 0 }) });
    ctx.tool({ name: "counter_reset", description: "Reset", input: z.object({ to: z.number() }), scope: "admin", run: async (_a, i: { to: number }) => (await ctx.store.set("n", i.to), { ok: true }) });
    ctx.on("doc.published", async (e) => void (await ctx.enqueue("note", { slug: e.slug })));
    ctx.job("note", { run: async (p: { slug: string }) => ctx.store.set(`published:${p.slug}`, true) });
  },
});

test("createTestCms: routes as each person, with or without the leading slash", async () => {
  const t = createTestCms({ plugins: [counter({ step: 2 })] });
  try {
    await t.ready();
    assert.equal(t.cms.plugins.get("counter")?.state, "running");
    assert.equal((await t.fetch("/counter/bump", { method: "POST" })).status, 200);
    assert.equal((await t.fetch("counter/bump", { method: "POST" }, { as: "writer" })).status, 200);
    assert.equal((await t.fetch("/counter/bump", { method: "POST" }, { as: "anon" })).status, 401);
    const v = (await (await t.fetch("/counter/value", {}, { as: "anon" })).json()) as { value: number; label: string; who: string };
    assert.deepEqual(v, { value: 4, label: "Count", who: "anonymous" });
    // Your own person.
    const own = { kind: "user" as const, id: "u-9", label: "Park", isAdmin: false };
    assert.equal(((await (await t.fetch("/counter/value", {}, { as: own })).json()) as { who: string }).who, "user");
    // The REST client, as the admin and as the writer.
    assert.equal((await t.client().me()).isAdmin, true);
    assert.equal((await t.client("writer").me()).isAdmin, false);
  } finally {
    await t.close();
  }
});

test("createTestCms: the default collection, the writer's role, tools by scope", async () => {
  const t = createTestCms({ plugins: [counter] });
  try {
    assert.deepEqual(t.cms.collections().map((c) => c.slug), ["pages"]);
    const made = await t.fetch("/collections/pages", { method: "POST", body: JSON.stringify({ doc: { slug: "a", title: "A", body: "x\n" } }) }, { as: "writer" });
    assert.equal(made.status, 201, await made.clone().text());
    // The writer may write, not publish.
    assert.equal((await t.fetch("/collections/pages/a/publish", { method: "POST", body: "{}" }, { as: "writer" })).status, 403);

    assert.deepEqual(await t.tool("counter_value", {}, { as: "writer" }), { ok: true, value: { value: 0 } });
    const refused = await t.tool("counter_reset", { to: 5 }, { as: "writer" });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error.error, "unknown_tool");
    assert.equal((await t.tool("counter_reset", { to: "x" })).ok, false, "input is checked");
    assert.deepEqual(await t.tool("counter_reset", { to: 5 }), { ok: true, value: { ok: true } });
    assert.deepEqual(await t.tool("counter_value"), { ok: true, value: { value: 5 } });
  } finally {
    await t.close();
  }
});

test("createTestCms: events, then jobs on cron", async () => {
  const t = createTestCms({ plugins: [counter] });
  try {
    await t.cms.create(t.admin, "pages", { slug: "hello", title: "Hello", body: "hi\n" });
    await t.cms.publish(t.admin, "pages", "hello");
    await t.flush();
    const run = await t.cron();
    assert.ok(run.jobs.ok >= 1, JSON.stringify(run.jobs));
    const stored = await t.repo.findRecordByKey("plugin:counter", "published:hello");
    assert.ok(stored, "the job ran");
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("0.24.1: flush() waits for a listener that is still awaiting", async () => {
  let done = false;
  const slow = definePlugin({
    name: "slow-listener",
    setup(ctx) {
      ctx.on("doc.published", async () => {
        await new Promise((r) => setTimeout(r, 60));
        await new Promise((r) => setTimeout(r, 60));
        done = true;
      });
    },
  });
  const t = createTestCms({ plugins: [slow] });
  try {
    await t.cms.create(t.admin, "pages", { slug: "hello", title: "Hello", body: "hi\n" });
    await t.cms.publish(t.admin, "pages", "hello");
    await t.flush();
    assert.equal(done, true);
  } finally {
    await t.close();
  }
});

test("createTestCms: settings are saved (secrets sealed) and the plugin restarts", async () => {
  assert.equal(TEST_SECRETS_KEY.length, 32);
  const t = createTestCms({ plugins: [counter] });
  try {
    await t.settings("counter", { label: "Visits", token: "tok-1234567" });
    const v = (await (await t.fetch("/counter/value")).json()) as { label: string };
    assert.equal(v.label, "Visits");
    const view = await t.client().pluginSettings("counter");
    assert.equal(view.settings?.values.token, "••••••••");
    await assert.rejects(t.settings("counter", { label: 3 }), /settings of counter do not fit/);
    await assert.rejects(t.settings("nope", {}), /has no settings/);
  } finally {
    await t.close();
  }
});

test("createTestCms: ready() rejects when a required plugin cannot start", async () => {
  const broken = definePlugin({
    name: "broken",
    required: true,
    setup() {},
    start() {
      throw new Error("no connection");
    },
  });
  const t = createTestCms({ plugins: [broken] });
  try {
    await assert.rejects(t.ready(), /broken/);
    assert.equal((await t.fetch("/collections/pages")).status, 503);
  } finally {
    await t.close();
  }
});
