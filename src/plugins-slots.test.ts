/** 0.23.0 (plugin v2): what plugins add — hooks, collections, fields, automation actions, filters, access, store, settings, log. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection, type CmsTelemetry } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { definePlugin, type PluginInput } from "./plugin";
import { MemoryRepo } from "./repo";
import { callTool } from "./tools";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const reader: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u3", label: "Park", isAdmin: false };
const KEY = "k".repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(plugins: PluginInput[], o: { secretsKey?: string } = {}) {
  const errors: string[] = [];
  const seen: CmsTelemetry[] = [];
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `/guide/${d.slug}`, fields: z.object({ level: z.number().default(1) }) });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide], plugins, secretsKey: o.secretsKey, onError: (_e, where) => void errors.push(where), onEvent: (e) => void seen.push(e) });
  const as = { who: admin as Extract<Actor, { kind: "user" }> };
  const handler = createCmsHandler({ cms, resolveUser: async () => as.who });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch;
  const api = createRestClient({ url: "http://app.test/api/cms", fetch: doFetch });
  return { cms, api, doFetch, errors, seen, repo, as };
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) || isCmsRemoteError(e) ? e.code : Promise.reject(e)));

test("hooks: a plugin's before hook refuses, after hooks run after the collection's, only for its collections", async () => {
  const log: string[] = [];
  const guard = definePlugin({
    name: "guard",
    setup(ctx) {
      ctx.hook("beforePublish", (d) => {
        if (d.content.title.includes("WIP")) throw new Error("a title with WIP cannot go public");
      });
      ctx.hook("beforeChange", (c) => ({ title: c.content.title.trim() }), { collections: ["guide"] });
      ctx.hook("afterPublish", (d) => void log.push(`published ${d.slug}`));
      ctx.hook("afterChange", () => {
        throw new Error("boom");
      });
    },
  });
  const { cms, errors } = setup([guard]);
  await cms.create(admin, "guide", { slug: "a", title: "  Hello  ", body: "x\n" });
  assert.equal((await cms.get(admin, "guide", "a", { draft: true })).title, "Hello");
  await cms.publish(admin, "guide", "a");
  await cms.create(admin, "guide", { slug: "b", title: "WIP draft", body: "x\n" });
  assert.equal(await code(cms.publish(admin, "guide", "b")), "hook_rejected");
  await tick();
  assert.deepEqual(log, ["published a"]);
  assert.ok(errors.includes("afterChange"), "an after hook's error goes to onError");
  assert.throws(() => setup([definePlugin({ name: "typo", setup: (ctx) => ctx.hook("afterPublish", () => {}, { collections: ["gide"] }) })]), /no collection "gide"/);
});

test("collections and fields: a plugin's own collection, a field on the app's", async () => {
  const forms = definePlugin({
    name: "contact",
    setup(ctx) {
      ctx.collection(defineCollection({ slug: "contact-messages", label: "Messages", visibility: "internal", access: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } }));
      ctx.field("guide", "readingMinutes", z.number().int().min(0).default(0), { label: "Reading time", widget: "number" });
    },
  });
  const { cms, api } = setup([forms]);
  assert.ok(cms.collections().some((c) => c.slug === "contact-messages"));
  const g = cms.collections().find((c) => c.slug === "guide")!;
  assert.equal(g.admin?.fields?.readingMinutes?.label, "Reading time");
  const doc = await cms.core.create(admin, "guide", { slug: "a", title: "A", body: "x\n", fields: { readingMinutes: 4 } });
  assert.deepEqual(doc.fields, { level: 1, readingMinutes: 4 });
  assert.equal(await code(cms.core.create(admin, "guide", { slug: "b", title: "B", body: "x\n", fields: { readingMinutes: -1 } })), "invalid_field");
  await cms.core.create(admin, "contact-messages", { slug: "m1", title: "Hi", body: "Hello\n" });
  assert.equal((await api.me()).collections?.some((c) => c.slug === "contact-messages"), true);

  assert.throws(() => setup([definePlugin({ name: "clash", setup: (ctx) => ctx.collection(defineCollection({ slug: "guide", label: "G", visibility: "public" })) })]), /collection name "guide" is taken/);
  assert.throws(() => setup([definePlugin({ name: "clash", setup: (ctx) => ctx.field("guide", "level", z.number()) })]), /already has the field "level"/);
  assert.throws(() => setup([definePlugin({ name: "clash", setup: (ctx) => ctx.field("nope", "x", z.number()) })]), /no collection "nope"/);
});

test("automation actions: named <plugin>.<name>, listed with their label, run by an automation", async () => {
  const ran: string[] = [];
  const slack = definePlugin({
    name: "slack",
    setup(ctx) {
      ctx.automationAction("post", { label: "Post to Slack", run: (c) => void ran.push(`${c.automation.name}: ${c.doc?.slug}`) });
    },
  });
  const { cms } = setup([slack]);
  const list = await cms.automations.list(admin);
  assert.ok(list.actions.includes("slack.post"));
  assert.equal(list.actionLabels["slack.post"], "Post to Slack");
  await cms.automations.create(admin, { name: "Tell Slack", trigger: { event: "doc.published", collection: "guide" }, actions: [{ type: "slack.post" }] });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.publish(admin, "guide", "a");
  for (let i = 0; i < 20 && !ran.length; i++) {
    await cms.cron();
    await tick();
  }
  assert.deepEqual(ran, ["Tell Slack: a"]);
});

test("filters: run in priority order; one that throws is skipped; REST docs, tool results, sitemap, export", async () => {
  const order: string[] = [];
  const shaper = definePlugin({
    name: "shaper",
    setup(ctx) {
      ctx.filter("rest.doc", (d, c) => ({ ...d, fields: { ...d.fields, seenBy: c.actor.kind } }), { priority: 20 });
      ctx.filter("rest.doc", (d) => {
        order.push("first");
        return d;
      }, { priority: 1 });
      ctx.filter("rest.doc", () => {
        throw new Error("broken filter");
      });
      ctx.filter("mcp.result", (v, c) => (c.tool === "get_document" ? { ...(v as object), note: "from shaper" } : v));
      ctx.filter("sitemap.entries", (urls, c) => [...urls, { loc: `${c.origin}/pricing`, lastmod: "2026-11-24T00:00:00Z" }]);
      ctx.filter("export.file", (f) => (f.path.endsWith(".md") ? { ...f, text: `${f.text}\n<!-- exported -->\n` } : f));
    },
  });
  const { cms, api, doFetch, errors } = setup([shaper]);
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.publish(admin, "guide", "a");
  const doc = await api.get("guide", "a");
  assert.equal((doc.fields as Record<string, unknown>).seenBy, "user");
  assert.deepEqual(order, ["first"]);
  assert.ok(errors.includes("plugin shaper: filter rest.doc"));
  const list = (await (await doFetch("http://app.test/api/cms/collections/guide")).json()) as { docs: { fields: Record<string, unknown> }[] };
  assert.equal(list.docs[0].fields.seenBy, "user");

  const tool = (await callTool(cms, admin, "get_document", { collection: "guide", slug: "a" })) as { note?: string };
  assert.equal(tool.note, "from shaper");

  const xml = await (await doFetch("http://app.test/api/cms/sitemap.xml")).text();
  assert.match(xml, /<loc>http:\/\/app\.test\/pricing<\/loc>/);
  assert.match(xml, /<loc>http:\/\/app\.test\/guide\/a<\/loc>/);

  const exp = await cms.transfer.export(admin);
  const md = exp.files.find((f) => f.path === "guide/a.md")!;
  assert.match(md.text, /<!-- exported -->/);
});

test("access: a plugin rule narrows reads and writes (never widens); system actors are not asked", async () => {
  const paywall = definePlugin({
    name: "paywall",
    setup(ctx) {
      ctx.access(({ actor, op, doc }) => (op === "read" && doc?.fields?.level === 2 ? actor.kind === "user" && actor.isAdmin : true));
      ctx.access(({ actor, op }) => !(op === "write" && actor.kind === "user" && actor.id === "u3"));
    },
  });
  const { cms } = setup([paywall]);
  await cms.create(admin, "guide", { slug: "free", title: "Free", body: "x\n" });
  await cms.create(admin, "guide", { slug: "paid", title: "Paid", body: "x\n", fields: { level: 2 } });
  await cms.publish(admin, "guide", "free");
  await cms.publish(admin, "guide", "paid");
  const anon: Actor = { kind: "anonymous" };
  assert.deepEqual((await cms.list(anon, "guide")).map((d) => d.slug).sort(), ["free"]);
  assert.equal(await code(cms.get(anon, "guide", "paid")), "unauthorized");
  assert.deepEqual((await cms.list(admin, "guide")).map((d) => d.slug).sort(), ["free", "paid"]);
  assert.equal(cms.can(reader, "guide", "write"), false);
  assert.equal(cms.can({ kind: "system", label: "job" }, "guide", "write"), true);
});

test("store: small values per plugin; keys and sizes are checked", async () => {
  let store: import("./plugin").PluginStore | null = null;
  const counter = definePlugin({
    name: "counter",
    setup(ctx) {
      store = ctx.store;
    },
  });
  const other = definePlugin({ name: "other", setup: (ctx) => void ctx.store });
  const { repo } = setup([counter, other]);
  await store!.set("views:a", { n: 1 });
  await store!.set("views:a", { n: 2 });
  await store!.set("views:b", 5);
  await store!.set("total", 7);
  assert.deepEqual(await store!.get("views:a"), { n: 2 });
  assert.equal(await store!.get("nope"), null);
  assert.deepEqual(await store!.list("views:"), [
    { key: "views:a", value: { n: 2 } },
    { key: "views:b", value: 5 },
  ]);
  assert.equal(await store!.delete("total"), true);
  assert.equal(await store!.delete("total"), false);
  assert.equal((await repo.listRecords({ kind: "plugin:counter" })).length, 2);
  await assert.rejects(store!.set("x".repeat(201), 1), /1 to 200 characters/);
  await assert.rejects(store!.set("big", "y".repeat(70_000)), /at most 65536 bytes/);
});

test("settings: checked at start (missing ones fail the start), secrets sealed and masked, saving restarts", async () => {
  const seen: unknown[] = [];
  const slack = definePlugin({
    name: "slack",
    settings: z.object({ webhookUrl: z.string().url().describe("secret"), channel: z.string().default("#content") }),
    setup() {},
    start(ctx) {
      seen.push(ctx.settings());
    },
  });
  const { cms, api, repo } = setup([slack], { secretsKey: KEY });
  await api.me();
  const first = cms.plugins.get("slack")!;
  assert.equal(first.state, "failed");
  assert.equal(first.error, "settings: webhookUrl: invalid_type", "the reason names the setting, never its value");
  assert.deepEqual(first.settings, ["webhookUrl", "channel"]);

  assert.equal(await code(api.savePluginSettings("slack", { webhookUrl: "not a url" })), "plugin_settings_invalid");
  const saved = await api.savePluginSettings("slack", { webhookUrl: "https://hooks.slack.test/T000/abcd1234" });
  assert.equal(saved.plugin.state, "running");
  assert.deepEqual(saved.settings.values, { webhookUrl: "••••••••", channel: "#content" }, "a secret is never sent back, not even its end");
  assert.deepEqual(seen, [{ webhookUrl: "https://hooks.slack.test/T000/abcd1234", channel: "#content" }]);
  const row = (await repo.listRecords({ kind: "plugin-settings" }))[0];
  assert.ok(!JSON.stringify(row.data).includes("hooks.slack.test"), "the secret is sealed in the database");

  // The mask sent back (or the key left out) keeps the stored secret.
  await api.savePluginSettings("slack", { webhookUrl: "••••••••", channel: "#news" });
  assert.deepEqual(seen[1], { webhookUrl: "https://hooks.slack.test/T000/abcd1234", channel: "#news" });
  const audit = (await cms.audit(admin, { limit: 10 })).entries.filter((e) => e.action === "plugin.settings");
  assert.equal(audit.length, 2);
  assert.ok(!JSON.stringify(audit).includes("hooks.slack.test"));
});

test("log: goes to onEvent as a plugin line", async () => {
  const p = definePlugin({ name: "chatty", setup: (ctx) => void ctx.on("doc.created", () => ctx.log("info", "made one", { n: 1 })) });
  const { cms, seen } = setup([p]);
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await tick();
  assert.deepEqual(seen.filter((e) => e.type === "plugin"), [{ type: "plugin", plugin: "chatty", level: "info", message: "made one", data: { n: 1 } }]);
});

test("a failed plugin's hooks and filters are out of use; its access rules fail closed", async () => {
  const flaky = definePlugin({
    name: "flaky",
    setup(ctx) {
      ctx.hook("beforePublish", () => {
        throw new Error("never publish");
      });
      ctx.filter("rest.doc", (d) => ({ ...d, title: "changed" }));
      ctx.access(() => true, { collections: ["guide"] });
    },
    start() {
      throw new Error("cannot start");
    },
  });
  const { cms, api } = setup([flaky]);
  await api.me();
  assert.equal(cms.plugins.get("flaky")!.state, "failed");
  // Its rule allowed everything, but while it is down the collection it covers refuses (fails closed).
  assert.equal(await code(cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" })), "forbidden_write");
  const sys = { kind: "system" as const, label: "seed" };
  await cms.create(sys, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.publish(sys, "guide", "a");
  assert.equal(await code(api.get("guide", "a")), "forbidden_read");
});

test("review fixes: draft lists follow plugin write rules; secrets of any type sealed; jobs of a failed plugin wait; filters get copies", async () => {
  // A plugin rule that hides one draft from an editor: lists and counts must agree with the single read.
  const editor: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u9", label: "Ed", isAdmin: false };
  const teams = definePlugin({ name: "teams", setup: (ctx) => ctx.access(({ actor, op, doc }) => !(op === "write" && actor.kind === "user" && actor.id === "u9" && doc?.slug === "secret")) });
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", access: { write: ({ actor }) => actor.kind === "user" }, fields: z.object({ pin: z.number().optional() }) });
  const pinPlugin = definePlugin({ name: "pins", settings: z.object({ pin: z.number().describe("secret") }), setup() {} });
  const ran: string[] = [];
  const down = { now: true };
  const flaky = definePlugin({
    name: "flaky",
    setup: (ctx) => ctx.job("work", { run: () => void ran.push("ran") }),
    start() {
      if (down.now) throw new Error("down");
    },
  });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide], plugins: [teams, pinPlugin, flaky], secretsKey: KEY, onError: () => {} });
  const sys = { kind: "system" as const, label: "seed" };
  await cms.create(sys, "guide", { slug: "open", title: "Open", body: "x\n" });
  await cms.create(sys, "guide", { slug: "secret", title: "Secret draft", body: "classified\n" });
  const drafts = await cms.list(editor, "guide", { drafts: true });
  assert.deepEqual(drafts.map((d) => d.slug), ["open"], "the hidden draft is not in the editor's list");
  assert.equal(await code(cms.get(editor, "guide", "secret", { draft: true })), "not_found");

  await cms.plugins.start().catch(() => {});
  await cms.plugins.saveSettings("pins", { pin: 1234 });
  const row = (await repo.listRecords({ kind: "plugin-settings" }))[0];
  assert.ok(!JSON.stringify(row.data).includes("1234"), "a number marked secret is sealed too");
  assert.deepEqual((await cms.plugins.settings("pins"))!.values, { pin: "••••••••" });

  // The job of a failed plugin waits (no attempt used), and runs once the plugin is fixed.
  await cms.core.jobs.enqueue("flaky.work");
  await cms.cron();
  assert.deepEqual(ran, []);
  const [job] = await cms.core.jobs.list({ state: "waiting" });
  assert.equal(job.attempts, 0);
  down.now = false;
  await cms.plugins.restart("flaky");
  await cms.core.jobs.retry(job.id).catch(() => {});
  await repo.updateJob(job.id, { runAt: new Date(0).toISOString() });
  await cms.cron();
  assert.deepEqual(ran, ["ran"]);
});

test("review fixes: a mail filter cannot change the recipient, even in place; an app plugin cannot pose as a built-in", async () => {
  const sneaky = definePlugin({
    name: "sneaky",
    setup: (ctx) =>
      ctx.filter("mail.message", (m) => {
        m.to = "attacker@evil.test";
        m.text += "\n-- footer";
        return m;
      }),
  });
  const { cms } = setup([sneaky]);
  const out = await cms.plugins.filter("mail.message", { to: "kim@site.test", subject: "Reset", text: "link" }, { kind: "reset" });
  assert.equal(out.text, "link\n-- footer");
  const original = { to: "kim@site.test", subject: "Reset", text: "link" };
  await cms.plugins.filter("mail.message", original, { kind: "reset" });
  assert.equal(original.to, "kim@site.test", "the filter got a copy");

  const fake = { name: "automations", builtin: true, setup() {} } as unknown as import("./plugin").CmsPlugin;
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  assert.throws(() => createCms({ repo: new MemoryRepo(), collections: [guide], builtins: { automations: false }, plugins: [fake] }), /taken by a route/);
});

test("built-ins: webhooks and automations are plugins; builtins: false turns them off", async () => {
  const on = setup([], { secretsKey: KEY });
  const listed = on.cms.plugins.list().filter((p) => p.builtin);
  assert.deepEqual(listed.map((p) => [p.name, p.state]), [
    ["webhooks", "starting"],
    ["automations", "starting"],
  ]);
  const me = await on.api.me();
  assert.equal(me.automations, true);
  assert.deepEqual(me.plugins, {}, "built-ins add nothing under plugins");
  assert.equal(on.cms.plugins.get("webhooks")!.state, "running");

  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], secretsKey: KEY, builtins: { webhooks: false, automations: false } });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const api = createRestClient({ url: "http://app.test/api/cms", fetch: (async (i: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(i), init))) as typeof fetch });
  assert.deepEqual(cms.plugins.list().map((p) => p.name), []);
  assert.equal(cms.webhooks.enabled(), false);
  const off = await api.me();
  assert.equal(off.automations, false);
  assert.equal(off.webhooks, false);
  assert.equal(await code(api.webhooks()), "route_not_found");
  assert.equal(await code(api.automations()), "route_not_found");
});
