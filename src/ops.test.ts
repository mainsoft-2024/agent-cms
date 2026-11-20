/** 0.12.0: background jobs, sealed secrets, webhooks, plugins, telemetry. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection, type CmsTelemetry } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { WEBHOOK_MAX_FAILURES, WEBHOOK_RETRY } from "./outbox";
import { definePlugin, type CmsEvent } from "./plugin";
import { MemoryRepo } from "./repo";
import { createSealer } from "./secrets";
import { callTool, toolsFor } from "./tools";
import type { Actor } from "./types";
import { signWebhook, verifyWebhook, WebhookVerifyError, type WebhookPayload } from "./webhooks";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const writer: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const KEY = "k".repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 5));

type Sent = { url: string; headers: Headers; body: string };

function setup(o: { secretsKey?: string | null; plugins?: Parameters<typeof createCms>[0]["plugins"]; answer?: () => number | Error } = {}) {
  const clock = { t: Date.parse("2026-11-21T00:00:00Z") };
  const sent: Sent[] = [];
  const seen: CmsTelemetry[] = [];
  const state = { answer: o.answer ?? (() => 200) };
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `https://site.test/guide/${d.slug}` });
  const notes = defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: () => true } });
  const repo = new MemoryRepo();
  const cms = createCms({
    repo,
    collections: [guide, notes],
    now: () => new Date(clock.t),
    cronSecret: "cron-secret-cron-secret",
    secretsKey: o.secretsKey === null ? undefined : (o.secretsKey ?? KEY),
    plugins: o.plugins,
    onEvent: (e) => void seen.push(e),
    onError: () => {},
    webhooks: {
      resolveHost: async (host) => (host === "intranet.test" ? ["10.0.0.5"] : ["93.184.216.34"]),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
        const a = state.answer();
        if (a instanceof Error) throw a;
        return new Response(null, { status: a });
      }) as typeof fetch,
    },
  });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch;
  const api = createRestClient({ url: "http://app.test/api/cms", fetch: doFetch });
  const minutes = (n: number) => (clock.t += n * 60_000);
  return { cms, repo, api, clock, sent, seen, state, doFetch, minutes };
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) || isCmsRemoteError(e) ? e.code : Promise.reject(e)));

test("secrets: a sealed value opens with the same key only", () => {
  const a = createSealer(KEY);
  const sealed = a.seal("whsec_abc");
  assert.notEqual(sealed, a.seal("whsec_abc"), "a fresh nonce every time");
  assert.ok(!sealed.includes("whsec_abc"));
  assert.equal(a.open(sealed), "whsec_abc");
  assert.throws(() => createSealer("x".repeat(40)).open(sealed));
  assert.throws(() => a.open(sealed.slice(0, -2) + "AA"), "a changed value is refused");
  assert.throws(() => createSealer("short"), /at least 32/);
});

test("jobs: run when due, retry on the schedule of their kind, stay with the error when they give up", async () => {
  const { cms, repo, minutes } = setup();
  const ran: string[] = [];
  let fail = 2;
  cms.jobs.define<{ n: string }>("demo.flaky", {
    retryAfter: [60, 300],
    run: (p) => {
      ran.push(p.n);
      if (fail-- > 0) throw new Error("not yet");
    },
  });
  cms.jobs.define("demo.broken", { run: () => Promise.reject(new Error("always")) });
  await assert.rejects(cms.jobs.enqueue("demo.unknown"), /unknown job kind/);
  assert.throws(() => cms.jobs.define("demo.flaky", { run: () => {} }), /defined twice/);

  await cms.jobs.enqueue("demo.flaky", { n: "a" });
  await cms.jobs.enqueue("demo.flaky", { n: "later" }, { runAt: new Date(Date.parse("2026-11-21T03:00:00Z")) });
  await cms.jobs.enqueue("demo.broken");
  assert.deepEqual(await cms.jobs.run(), { ran: 2, ok: 0, retried: 1, failed: 1, waiting: 2 });
  assert.deepEqual(await cms.jobs.run(), { ran: 0, ok: 0, retried: 0, failed: 0, waiting: 2 }, "nothing is due before the wait is over");
  minutes(1);
  assert.equal((await cms.jobs.run()).retried, 1, "second attempt after 1 minute");
  minutes(4);
  assert.equal((await cms.jobs.run()).ran, 0, "third attempt waits 5 minutes");
  minutes(1);
  assert.deepEqual(await cms.jobs.run(), { ran: 1, ok: 1, retried: 0, failed: 0, waiting: 1 });
  assert.deepEqual(ran, ["a", "a", "a"]);

  const [dead] = await cms.jobs.list({ state: "failed" });
  assert.equal(dead.kind, "demo.broken");
  assert.equal(dead.lastError, "always");
  assert.deepEqual(await cms.jobs.stats(), { waiting: 1, failed: 1 });
  assert.equal(await cms.jobs.retry(dead.id), true);
  assert.equal((await cms.jobs.run()).failed, 1);

  // Finished jobs are forgotten after a week; failed ones stay.
  minutes(8 * 24 * 60);
  await cms.cron();
  // (the job set for 03:00 ran in that call, so it is the one finished job left)
  assert.deepEqual(repo.jobs.map((j) => [j.kind, j.payload.n ?? null, !!j.doneAt]).sort(), [["demo.broken", null, false], ["demo.flaky", "later", true]]);
});

test("jobs: two callers at the same moment run each job once", async () => {
  const { cms } = setup();
  let runs = 0;
  cms.jobs.define("demo.slow", {
    run: async () => {
      runs++;
      await tick();
    },
  });
  for (let i = 0; i < 12; i++) await cms.jobs.enqueue("demo.slow");
  const [a, b] = await Promise.all([cms.jobs.run(), cms.jobs.run()]);
  assert.equal(runs, 12);
  assert.equal(a.ran + b.ran, 12);
});

test("webhooks: a publish goes out signed, without the body, and verifies", async () => {
  const { cms, sent, minutes } = setup();
  const { webhook, secret } = await cms.webhooks.create(admin, { name: "Site cache", url: "https://hooks.test/cms", events: ["doc.published", "doc.deleted"], collections: ["guide"] });
  assert.match(secret, /^whsec_/);
  assert.equal("secretEnc" in webhook, false);
  assert.equal((await cms.webhooks.secret(admin, webhook.id)).secret, secret);

  await cms.create(admin, "guide", { slug: "a", title: "A", body: "## One\n\nsecret words\n" }); // doc.created: not asked for
  await cms.create(admin, "notes", { slug: "n", title: "N", body: "x\n" });
  await cms.publish(admin, "notes", "n"); // another collection
  await cms.publish(admin, "guide", "a");
  await tick();
  assert.equal(sent.length, 0, "nothing leaves inside the request");
  const run = await cms.cron();
  assert.deepEqual(run.jobs, { ran: 1, ok: 1, retried: 0, failed: 0, waiting: 0 });

  assert.equal(sent.length, 1);
  const [req] = sent;
  assert.equal(req.url, "https://hooks.test/cms");
  assert.equal(req.headers.get("x-cms-event"), "doc.published");
  assert.ok(!req.body.includes("secret words"), "the document's text is never sent");
  const event = await verifyWebhook({ body: req.body, headers: req.headers }, secret, { now: new Date(Date.parse("2026-11-21T00:00:00Z")) });
  assert.deepEqual(
    { ...event, id: "", at: "" },
    { id: "", at: "", event: "doc.published", actor: { kind: "user", id: "u1", label: "Kim", agent: null }, collection: "guide", slug: "a", version: 1, url: "https://site.test/guide/a" } satisfies WebhookPayload
  );
  assert.equal(req.headers.get("x-cms-delivery"), event.id);

  // The receiver's checks.
  const bad = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof WebhookVerifyError ? e.code : Promise.reject(e)));
  const at = { now: new Date(Date.parse("2026-11-21T00:00:00Z")) };
  assert.equal(await bad(verifyWebhook({ body: req.body, headers: req.headers }, "whsec_other", at)), "mismatch");
  assert.equal(await bad(verifyWebhook({ body: req.body + " ", headers: req.headers }, secret, at)), "mismatch");
  assert.equal(await bad(verifyWebhook({ body: req.body, headers: {} }, secret, at)), "missing");
  assert.equal(await bad(verifyWebhook({ body: req.body, headers: { "X-CMS-Signature": "nonsense" } }, secret, at)), "malformed");
  assert.equal(await bad(verifyWebhook({ body: req.body, headers: req.headers }, secret, { now: new Date(at.now.getTime() + 6 * 60_000) })), "expired");
  const again = new Request("https://receiver.test/hook", { method: "POST", body: req.body, headers: { "x-cms-signature": await signWebhook(req.body, secret) } });
  assert.equal((await verifyWebhook(again, secret)).slug, "a");
  assert.equal(await again.text(), req.body, "the request can still be read afterwards");

  const [d] = await cms.webhooks.deliveries(admin, webhook.id);
  assert.deepEqual({ ok: d.ok, status: d.status, attempt: d.attempt, event: d.event }, { ok: true, status: 200, attempt: 1, event: "doc.published" });

  // 30 days of history.
  minutes(31 * 24 * 60);
  await cms.cron();
  assert.equal((await cms.webhooks.deliveries(admin, webhook.id)).length, 0);
});

test("webhooks: a failing address is tried again on the schedule, then switched off after 20 in a row", async () => {
  const { cms, repo, sent, state, minutes } = setup({ answer: () => 500 });
  const { webhook } = await cms.webhooks.create(admin, { name: "Down", url: "https://hooks.test/down" });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await tick();
  assert.equal((await cms.cron()).jobs.retried, 1);
  // 1 min, 5 min, 30 min, 2 h, 12 h: not a second earlier.
  for (const wait of WEBHOOK_RETRY) {
    minutes(wait / 60 - 1);
    assert.equal((await cms.cron()).jobs.ran, 0);
    minutes(1);
    assert.equal((await cms.cron()).jobs.ran, 1);
  }
  assert.equal(sent.length, 6, "the first attempt and five more");
  assert.deepEqual(await cms.jobs.stats(), { waiting: 0, failed: 1 });
  const history = await cms.webhooks.deliveries(admin, webhook.id);
  assert.deepEqual(history.map((d) => d.attempt).sort(), [1, 2, 3, 4, 5, 6]);
  assert.ok(history.every((d) => !d.ok && d.status === 500 && d.error === "answered 500"));
  assert.equal(new Set(sent.map((s) => s.headers.get("x-cms-delivery"))).size, 1, "every attempt carries the same id");

  // A good answer starts the count again.
  state.answer = () => 204;
  assert.equal((await cms.webhooks.test(admin, webhook.id)).ok, true);
  await cms.webhooks.retry(admin, history[0].id);
  await cms.cron();
  assert.equal((await cms.webhooks.list(admin))[0].failures, 0);

  // 20 failures in a row switch it off.
  state.answer = () => new Error("connect ECONNREFUSED");
  for (let i = 0; i < 4; i++) await cms.create(admin, "guide", { slug: `b${i}`, title: "B", body: "x\n" });
  await tick();
  for (let i = 0; i < 6 && (await cms.webhooks.list(admin))[0].enabled; i++) {
    await cms.cron();
    minutes(13 * 60);
  }
  const [off] = await cms.webhooks.list(admin);
  assert.equal(off.enabled, false);
  assert.ok(off.failures >= WEBHOOK_MAX_FAILURES && off.failures < WEBHOOK_MAX_FAILURES + 4, "counted one by one although four deliveries ran side by side");
  assert.match(off.disabledReason ?? "", /20 failed deliveries in a row.*ECONNREFUSED/);
  await tick();
  assert.ok(repo.audit.some((a) => a.action === "webhook.disable" && a.actorKind === "system"));
  const before = sent.length;
  await cms.create(admin, "guide", { slug: "c", title: "C", body: "x\n" });
  await tick();
  minutes(13 * 60);
  await cms.cron();
  assert.equal(sent.length, before, "a switched-off webhook gets nothing");
  // Switching it on again is a fresh start.
  const on = await cms.webhooks.update(admin, webhook.id, { enabled: true });
  assert.deepEqual({ enabled: on.enabled, failures: on.failures, reason: on.disabledReason }, { enabled: true, failures: 0, reason: null });
});

test("webhooks: who may, which addresses, and the key that must be set", async () => {
  const { cms } = setup();
  assert.equal(await code(cms.webhooks.list(writer)), "forbidden_webhooks");
  assert.equal(await code(cms.webhooks.list({ kind: "anonymous" })), "unauthorized");
  const make = (url: string) => code(cms.webhooks.create(admin, { name: "x", url }));
  assert.equal(await make("http://hooks.test/x"), "webhook_url_blocked");
  assert.equal(await make("https://intranet.test/x"), "webhook_url_blocked");
  assert.equal(await make("https://127.0.0.1/x"), "webhook_url_blocked");
  assert.equal(await make("https://user:pw@hooks.test/x"), "webhook_url_blocked");
  assert.equal(await make("not a url"), "webhook_url_blocked");
  assert.equal(await code(cms.webhooks.create(admin, { name: "", url: "https://hooks.test/x" })), "name_invalid");
  assert.equal(await code(cms.webhooks.create(admin, { name: "x", url: "https://hooks.test/x", collections: ["nope"] })), "unknown_collection");
  assert.equal(await code(cms.webhooks.create(admin, { name: "x", url: "https://hooks.test/x", events: ["doc.exploded" as never] })), "webhook_event_unknown");
  assert.equal(await code(cms.webhooks.update(admin, "00000000-0000-4000-8000-000000000999", { name: "y" })), "webhook_not_found");

  const bare = setup({ secretsKey: null });
  assert.equal(await code(bare.cms.webhooks.create(admin, { name: "x", url: "https://hooks.test/x" })), "secrets_key_missing");
  assert.equal(bare.cms.webhooks.enabled(), false);
  assert.deepEqual(await bare.cms.webhooks.list(admin), []);
  await bare.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  assert.equal((await bare.cms.cron()).jobs.ran, 0);
});

test("events: every kind of change is told once, and no tool can make a webhook", async () => {
  const got: CmsEvent[] = [];
  const spy = definePlugin({ name: "spy", setup: (ctx) => ctx.on("*", (e) => void got.push(e)) });
  const { cms } = setup({ plugins: [spy] });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "one\n" });
  await cms.update(admin, "guide", "a", { body: "two\n" });
  await cms.publish(admin, "guide", "a");
  await cms.addComment(admin, "guide", "a", { body: "Looks good" });
  await cms.unpublish(admin, "guide", "a");
  await cms.remove(admin, "guide", "a");
  await cms.trash.restore(admin, [{ kind: "document", id: (await cms.trash.list(admin)).items[0].id }]);
  await tick();
  assert.deepEqual(
    got.map((e) => e.event),
    ["doc.created", "doc.updated", "doc.published", "comment.created", "doc.unpublished", "doc.deleted", "doc.restored"]
  );
  assert.ok(got.every((e) => e.collection === "guide" && e.slug === "a" && e.actor?.label === "Kim"));
  assert.ok(!toolsFor(cms, admin).some((t) => /webhook|job/.test(t.name)), "agents get no way to send data out by themselves");
});

test("plugins: routes with the checked actor, tools, jobs, _me, menu entries", async () => {
  const done: unknown[] = [];
  const stats = definePlugin({
    name: "stats",
    sql: ['CREATE TABLE IF NOT EXISTS "stats_days" ("day" date PRIMARY KEY, "n" integer NOT NULL DEFAULT 0)'],
    setup(ctx) {
      ctx.route("GET", "summary", ({ actor, path, cms }) => Response.json({ who: actor.kind === "anonymous" ? null : actor.label, path, collections: cms.collections().length }));
      ctx.route("POST", "", async ({ req }) => Response.json({ echo: await req.json() }, { status: 201 }));
      ctx.tool({ name: "stats_count", description: "How many collections there are", input: z.object({ times: z.number().default(1) }), run: (_a, i, cms) => ({ n: cms.collections().length * i.times }) });
      ctx.tool({ name: "stats_reset", description: "Forget the numbers", input: z.object({}), scope: "admin", run: () => ({ ok: true }) });
      ctx.job<{ day: string }>("rollup", { run: (p) => void done.push(p.day) });
      ctx.on("doc.published", (e) => void ctx.enqueue("rollup", { day: `${e.slug}@${ctx.secrets ? "sealed" : "plain"}` }));
      ctx.me((actor) => ({ canReset: actor.kind === "user" && actor.isAdmin }));
      ctx.nav({ label: "Stats", href: "/admin/stats" });
      ctx.nav({ label: "Stats settings", href: "/admin/stats/settings", admin: true });
    },
  });
  const { cms, api, doFetch } = setup({ plugins: [stats] });
  assert.deepEqual(cms.plugins.sql, stats.sql);

  const get = await doFetch("http://app.test/api/cms/stats/summary/2026/11");
  assert.deepEqual(await get.json(), { who: "Kim", path: ["2026", "11"], collections: 2 });
  const post = await doFetch("http://app.test/api/cms/stats", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json", origin: "http://app.test" } });
  assert.deepEqual([post.status, await post.json()], [201, { echo: { a: 1 } }]);
  assert.equal((await doFetch("http://app.test/api/cms/stats/nothing")).status, 404);
  assert.equal((await doFetch("http://app.test/api/cms/stats/summary", { method: "DELETE", headers: { origin: "http://app.test" } })).status, 404);

  const me = await api.me();
  assert.deepEqual(me.plugins, { stats: { canReset: true } });
  assert.deepEqual(me.nav, [
    { label: "Stats", href: "/admin/stats", plugin: "stats" },
    { label: "Stats settings", href: "/admin/stats/settings", plugin: "stats" },
  ]);
  assert.equal(me.webhooks, true);

  assert.deepEqual(await callTool(cms, admin, "stats_count", { times: 3 }), { n: 6 });
  assert.ok(toolsFor(cms, admin).some((t) => t.name === "stats_reset"));
  assert.ok(toolsFor(cms, writer).some((t) => t.name === "stats_count"));
  assert.ok(!toolsFor(cms, writer).some((t) => t.name === "stats_reset"), "an admin tool is hidden from others");

  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.publish(admin, "guide", "a");
  await tick();
  await cms.cron();
  assert.deepEqual(done, ["a@sealed"]);
  assert.deepEqual(cms.jobs.kinds().sort(), ["automation.run", "stats.rollup", "webhook.deliver"]);

  const twice = () => createCms({ repo: new MemoryRepo(), collections: [], plugins: [stats, stats] });
  assert.throws(twice, /given twice/);
  assert.throws(() => definePlugin({ name: "Bad Name", setup() {} }), /lowercase/);
  assert.throws(() => createCms({ repo: new MemoryRepo(), collections: [], plugins: [{ name: "webhooks", setup() {} }] }), /taken by a route/);
});

test("rest: webhooks, jobs, the cron answer and what onEvent sees", async () => {
  const { api, doFetch, seen, state, minutes, cms } = setup();
  const list0 = await api.webhooks();
  assert.deepEqual([list0.webhooks, list0.enabled, list0.events.includes("doc.published")], [[], true, true]);
  const { webhook, secret } = await api.createWebhook({ name: "Chat", url: "https://hooks.test/chat", events: ["doc.published"] });
  assert.equal(await api.webhookSecret(webhook.id), secret);
  assert.equal((await api.updateWebhook(webhook.id, { name: "Team chat" })).name, "Team chat");
  assert.equal(await code(api.createWebhook({ name: "x", url: "http://hooks.test/x" })), "webhook_url_blocked");
  assert.equal((await api.testWebhook(webhook.id)).event, "ping");

  state.answer = () => 503;
  minutes(1);
  await api.create("guide", { slug: "a", title: "A", body: "x\n" });
  await api.publish("guide", "a");
  await tick();
  const cron = await doFetch("http://app.test/api/cms/_cron", { method: "POST", headers: { authorization: "Bearer cron-secret-cron-secret" } });
  const body = (await cron.json()) as { published: string[]; jobs: { ran: number; retried: number } };
  assert.deepEqual([cron.status, body.published, body.jobs.ran, body.jobs.retried], [200, [], 1, 1]);
  assert.equal((await doFetch("http://app.test/api/cms/_cron", { method: "POST" })).status, 401);

  const deliveries = await api.webhookDeliveries(webhook.id);
  assert.deepEqual(deliveries.map((d) => [d.event, d.ok]), [["doc.published", false], ["ping", true]]);
  assert.deepEqual(await api.retryDelivery(deliveries[0].id), { queued: true });
  for (const wait of WEBHOOK_RETRY) {
    minutes(wait / 60);
    await cms.cron();
  }
  minutes(13 * 60); // the retried one started a minute later, so its last attempt is one round behind
  await cms.cron();
  const jobs = await api.jobs({ state: "failed" });
  assert.deepEqual([jobs.failed, jobs.jobs.length, jobs.jobs[0].lastError], [2, 2, "answered 503"]);
  state.answer = () => 200;
  await api.retryJob(jobs.jobs[0].id);
  await cms.cron();
  assert.equal((await api.jobs()).failed, 1);
  await api.removeWebhook(webhook.id);
  assert.deepEqual((await api.webhooks()).webhooks, []);

  // A person who is not an admin.
  const other = createRestClient({ url: "http://app.test/api/cms", fetch: (async (i: RequestInfo | URL, init?: RequestInit) => createCmsHandler({ cms, resolveUser: async () => writer as Extract<Actor, { kind: "user" }> })(new Request(String(i), init))) as typeof fetch });
  assert.equal(await code(other.webhooks()), "forbidden_webhooks");
  assert.equal(await code(other.jobs()), "forbidden");
  assert.equal((await other.me()).webhooks, false);

  const requests = seen.filter((e) => e.type === "request");
  assert.ok(requests.some((e) => e.type === "request" && e.method === "POST" && e.path === "/webhooks" && e.status === 201 && e.actor === "user" && e.via === "rest"));
  assert.ok(requests.some((e) => e.type === "request" && e.path === "/_cron" && e.status === 401));
  assert.ok(seen.some((e) => e.type === "event" && e.event === "doc.published"));
  assert.ok(seen.some((e) => e.type === "job" && e.kind === "webhook.deliver" && !e.ok && e.error === "answered 503"));
  assert.ok(seen.some((e) => e.type === "cron" && e.jobs.ran === 1));
});

test("hooks: beforeChange can change or refuse a save; beforePublish and beforeDelete can refuse", async () => {
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    hooks: {
      beforeChange: [
        ({ content, prev }) => (prev ? undefined : { keywords: [...content.keywords, "new"] }),
        ({ content }) => {
          if (/lorem ipsum/i.test(content.body)) throw new Error("Placeholder text is still in the body");
        },
      ],
      beforePublish: [({ content, actor }) => void (content.summary || actor.kind === "system" || Promise.reject(new Error("unreachable")))],
      beforeDelete: [({ slug }) => { if (slug === "home") throw new Error("The home page cannot be deleted"); }],
    },
  });
  const strict = defineCollection({ slug: "strict", label: "Strict", visibility: "public", hooks: { beforePublish: [({ content }) => { if (!content.summary) throw new Error("Write a summary before publishing"); }] } });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide, strict] });
  const reason = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? `${e.code}: ${cms.message(e)}` : Promise.reject(e)));

  const doc = await cms.create(admin, "guide", { slug: "home", title: "Home", body: "Hello\n", keywords: ["a"] });
  assert.deepEqual(doc.keywords, ["a", "new"]);
  assert.deepEqual((await cms.update(admin, "guide", "home", { body: "Hello again\n" })).keywords, ["a", "new"], "only on create");
  assert.equal(await reason(cms.update(admin, "guide", "home", { body: "Lorem ipsum dolor\n" })), "hook_rejected: Placeholder text is still in the body");
  assert.equal(await reason(cms.create(admin, "guide", { slug: "x", title: "X", body: "lorem ipsum\n" })), "hook_rejected: Placeholder text is still in the body");
  assert.equal((await cms.get(admin, "guide", "home", { draft: true })).body, "Hello again\n");
  assert.equal(await reason(cms.remove(admin, "guide", "home")), "hook_rejected: The home page cannot be deleted");

  await cms.create(admin, "strict", { slug: "a", title: "A", body: "x\n" });
  assert.equal(await reason(cms.publish(admin, "strict", "a")), "hook_rejected: Write a summary before publishing");
  assert.equal(await reason(cms.create(admin, "strict", { slug: "b", title: "B", body: "x\n" }, { publish: true })), "hook_rejected: Write a summary before publishing");
  assert.equal(await reason(cms.update(admin, "strict", "a", { summary: "S" }, { publish: true })), "ok");
});
