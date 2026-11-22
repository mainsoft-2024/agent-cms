/** 0.17.0: the change log between servers, the read cache, database paging. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCache, type ChangeSignal } from "./changes";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const anon: Actor = { kind: "anonymous" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await tick(20);
  }
  assert.fail("timed out waiting");
}

type Frame = { event: string; id: string; data: Record<string, unknown> };
async function frames(res: Response, n: number, ms = 800): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Frame[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const got = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (!got || got.done) break;
    buf += dec.decode(got.value, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      if (!event) continue;
      out.push({ event, id: /^id: (.+)$/m.exec(block)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") });
    }
  }
  reader.releaseLock();
  return out;
}

const guide = () => defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
const notes = () => defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });

/** Two servers on one database. */
function pair(o: Partial<Parameters<typeof createCms>[0]> = {}) {
  const repo = new MemoryRepo();
  const make = () => createCms({ repo, collections: [guide(), notes()], warn: () => {}, onError: () => {}, changes: { pollMs: 200 }, ...o });
  return { repo, a: make(), b: make() };
}

test("change log: what one server does reaches the other's listeners, in order, and nobody hears itself twice", async () => {
  const { a, b } = pair();
  const heardA: string[] = [];
  const heardB: string[] = [];
  const stopA = a.subscribe((e) => heardA.push(`${e.event}:${e.slug}:${e.remote ? "remote" : "local"}:${e.seq}`));
  const stopB = b.subscribe((e) => heardB.push(`${e.event}:${e.slug}:${e.remote ? "remote" : "local"}:${e.seq}`));
  await tick(250); // both have read where the log stands
  await b.create(admin, "guide", { slug: "x", title: "X", body: "hi\n" });
  await b.publish(admin, "guide", "x");
  await until(() => heardA.length >= 2);
  assert.deepEqual(heardA, ["doc.created:x:remote:1", "doc.published:x:remote:2"]);
  await until(() => heardB.length >= 2);
  assert.deepEqual(heardB, ["doc.created:x:local:1", "doc.published:x:local:2"], "its own events once, with their numbers");
  stopA();
  stopB();
});

test("change log: a signal wakes the other server at once instead of waiting for the next look", async () => {
  const fns = new Set<() => void>();
  let published = 0;
  const signal: ChangeSignal = {
    publish: () => {
      published++;
      for (const f of fns) f();
    },
    subscribe: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
  const { a, b } = pair({ changes: { pollMs: 60_000, signal } });
  const heard: string[] = [];
  const stop = a.subscribe((e) => heard.push(e.event));
  await tick(30);
  await b.create(admin, "guide", { slug: "s", title: "S", body: "x\n" });
  await until(() => heard.length === 1, 1000);
  assert.ok(published >= 1);
  assert.equal(fns.size, 1, "A listens while someone is subscribed");
  stop();
  assert.equal(fns.size, 0, "and stops with the last subscriber");
});

test("read cache: readers are served from the cache, a publish here empties it at once and one elsewhere within a poll", async () => {
  const cacheA = memoryCache();
  const seen: string[] = [];
  const { a, b, repo } = pair({ cache: cacheA, onEvent: (e) => e.type === "cache" && void seen.push(e.hit ? "hit" : "miss") });
  await a.create(admin, "guide", { slug: "c", title: "One", body: "x\n" }, { publish: true });
  let reads = 0;
  const findDoc = repo.findDoc.bind(repo);
  repo.findDoc = (...args: Parameters<typeof repo.findDoc>) => {
    reads++;
    return findDoc(...args);
  };
  assert.equal((await a.get(anon, "guide", "c")).title, "One");
  assert.equal((await a.get(anon, "guide", "c")).title, "One");
  assert.equal(reads, 1, "the second read did not touch the database");
  assert.deepEqual(seen.slice(-2), ["miss", "hit"]);

  await a.update(admin, "guide", "c", { title: "Two" }, { publish: true });
  assert.equal((await a.get(anon, "guide", "c")).title, "Two", "this server's own publish empties its cache");

  await b.update(admin, "guide", "c", { title: "Three" }, { publish: true });
  await until(async () => (await a.get(anon, "guide", "c")).title === "Three");

  // A draft save does not change what readers get; editors never read from the cache.
  await b.update(admin, "guide", "c", { title: "Draft" });
  assert.equal((await a.get(admin, "guide", "c", { draft: true })).title, "Draft");
  assert.equal((await a.get(anon, "guide", "c")).title, "Three");
  // Lists too.
  const page1 = await a.page(anon, "guide", { limit: 10 });
  assert.deepEqual(page1.docs.map((d) => d.title), ["Three"]);
  await b.create(admin, "guide", { slug: "d", title: "Four", body: "x\n" }, { publish: true });
  await until(async () => (await a.page(anon, "guide", { limit: 10 })).docs.length === 2);
  // A collection with its own read rule is never cached (what a reader gets depends on who reads).
  await a.create(admin, "notes", { slug: "n", title: "N", body: "x\n" }, { publish: true });
  const before = cacheA.size();
  await a.get(admin, "notes", "n");
  assert.equal(cacheA.size(), before);
});

test("paging: pages come from the database by the last row; adding documents between pages repeats and skips nothing", async () => {
  const repo = new MemoryRepo();
  let t = Date.parse("2026-11-22T00:00:00Z");
  const cms = createCms({ repo, collections: [guide()], warn: () => {}, now: () => new Date((t += 1000)) });
  for (let i = 0; i < 25; i++) await cms.create(admin, "guide", { slug: `p${String(i).padStart(2, "0")}`, title: `Post ${i}`, body: "x\n", category: i % 2 ? "odd" : "even" }, { publish: true });
  const seen: string[] = [];
  let cursor: string | null = null;
  let first = true;
  do {
    const p: Awaited<ReturnType<typeof cms.page>> = await cms.page(anon, "guide", { limit: 10, cursor });
    assert.equal(p.total, first ? 25 : p.total);
    seen.push(...p.docs.map((d) => d.slug));
    if (first) {
      // Someone publishes while the reader is on page 1: the next pages neither repeat nor skip.
      await cms.create(admin, "guide", { slug: "new", title: "New", body: "x\n" }, { publish: true });
      first = false;
    }
    cursor = p.nextCursor;
    if (cursor) assert.match(cursor, /^k\./);
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, "nothing twice");
  assert.equal(seen.length, 25, "the new one is newer than page 1, so it is not in the later pages");
  assert.deepEqual(seen.slice(0, 3), ["p24", "p23", "p22"]);
  // Filters run in the database too; an old numeric cursor still works.
  const odd = await cms.page(anon, "guide", { limit: 5, category: "odd", q: "post 1" });
  assert.deepEqual(odd.docs.map((d) => d.slug), ["p19", "p17", "p15", "p13", "p11"]);
  assert.equal(odd.total, 6);
  const old = await cms.page(anon, "guide", { limit: 5, cursor: "5" });
  assert.equal(old.docs.length, 5);
  assert.equal(old.nextCursor, "10");
  // Editors: newest change first, with drafts.
  await cms.update(admin, "guide", "p00", { title: "Edited" });
  const ed = await cms.page(admin, "guide", { drafts: true, limit: 2 });
  assert.deepEqual(ed.docs.map((d) => d.slug), ["p00", "new"]);
  assert.equal(ed.total, 26);
});

test("GET /_changes: polling by number, only what the caller may hear, and a reset when the log no longer reaches back", async () => {
  const repo = new MemoryRepo();
  let t = Date.parse("2026-11-01T00:00:00Z");
  const cms = createCms({ repo, collections: [guide(), notes()], warn: () => {}, cronSecret: "c".repeat(32), now: () => new Date(t) });
  const handler = createCmsHandler({ cms, resolveUser: async () => null });
  const get = async (q: string) => (await handler(new Request(`http://app.test/api/cms/_changes${q}`))).json() as Promise<{ changes: { seq: number; event: string; slug: string }[]; last: number; more: boolean; reset: boolean }>;
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.publish(admin, "guide", "a");
  await cms.create(admin, "notes", { slug: "n", title: "N", body: "x\n" }, { publish: true });
  await tick(20);
  const all = await get("?since=0");
  assert.deepEqual(all.changes.map((c) => `${c.event}:${c.slug}`), ["doc.published:a"], "a stranger hears the publish only");
  assert.equal(all.last, 4, "but the number covers everything it skipped");
  assert.deepEqual((await get(`?since=${all.last}`)).changes, []);
  // A week later the log was pruned; a client still at 1 is told to reload.
  t += 8 * 86_400_000;
  await cms.create(admin, "guide", { slug: "b", title: "B", body: "x\n" }, { publish: true });
  await tick(20);
  await cms.cron();
  const late = await get("?since=1");
  assert.equal(late.reset, true);
  const fresh = await get(`?since=${all.last}`);
  assert.deepEqual(fresh.changes.map((c) => c.slug), ["b"]);
});

test("events stream: a client that comes back with its last id gets exactly what it missed, from any server", async () => {
  const { a, b } = pair();
  const handler = createCmsHandler({ cms: a, resolveUser: async () => admin });
  const first = await handler(new Request("http://app.test/api/cms/_events?collections=guide"));
  const ready = (await frames(first, 1))[0];
  assert.equal(ready.event, "ready");
  await b.create(admin, "guide", { slug: "m", title: "M", body: "x\n" });
  await b.publish(admin, "guide", "m");
  const live = await frames(first, 2, 2000);
  assert.deepEqual(live.map((f) => [f.event, f.id]), [["doc.created", "1"], ["doc.published", "2"]]);
  await first.body!.cancel();
  // Gone; meanwhile B changes things.
  await b.update(admin, "guide", "m", { body: "y\n" });
  await b.unpublish(admin, "guide", "m");
  await tick(20);
  const back = await handler(new Request("http://app.test/api/cms/_events?collections=guide", { headers: { "last-event-id": "2" } }));
  const got = await frames(back, 3);
  assert.deepEqual(got.map((f) => [f.event, f.id]), [["doc.updated", "3"], ["doc.unpublished", "4"], ["ready", "4"]]);
  await back.body!.cancel();
});

test("metrics: requests, events, cache and search are counted; paths are grouped; the text parses as Prometheus", async () => {
  const { createMetrics, routeOf } = await import("./metrics");
  assert.equal(routeOf("/api/cms/collections/guide/hello-world/versions"), "/collections/:c/:slug/versions");
  assert.equal(routeOf("/api/cms/collections/guide/hello/comments/9f2a/resolve"), "/collections/:c/:slug/comments/:id/resolve");
  assert.equal(routeOf("/keys/0b6f2e9c-1111-2222-3333-444455556666/rotate"), "/keys/:id/rotate");
  const metrics = createMetrics();
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide()], warn: () => {}, cache: memoryCache(), changes: { log: false } });
  const stop = cms.onTelemetry(metrics.onEvent);
  const handler = createCmsHandler({ cms, resolveUser: async () => null });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "hello world\n" }, { publish: true });
  for (const slug of ["a", "a", "zzz-not-there"]) await handler(new Request(`http://app.test/api/cms/collections/guide/${slug}`));
  await cms.search(anon, ["guide"], "hello");
  await cms.search(anon, ["guide"], "qqqq");
  const snap = metrics.snapshot();
  assert.equal(snap.requests, 3);
  assert.equal(snap.events, 2);
  assert.equal(snap.searches, 2);
  assert.ok(snap.cacheHits >= 1 && snap.cacheMisses >= 1, JSON.stringify(snap));
  const text = metrics.text();
  assert.match(text, /agent_cms_requests_total\{method="GET",route="\/collections\/:c\/:slug",status="200",via="rest"\} 2/);
  assert.match(text, /agent_cms_requests_total\{method="GET",route="\/collections\/:c\/:slug",status="404",via="rest"\} 1/);
  assert.match(text, /agent_cms_request_duration_seconds_bucket\{method="GET",route="\/collections\/:c\/:slug",le="\+Inf"\} 3/);
  assert.match(text, /agent_cms_events_total\{event="doc.published",collection="guide"\} 1/);
  assert.match(text, /agent_cms_search_empty_total 1/);
  assert.doesNotMatch(text, /zzz-not-there/, "slugs never become labels");
  // Every sample line: name{labels} number.
  for (const line of text.trim().split("\n")) if (!line.startsWith("#")) assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$/, line);
  stop();
  await handler(new Request("http://app.test/api/cms/collections/guide/a"));
  assert.equal(metrics.snapshot().requests, 3, "stopped listening");
});

test("field access: hidden fields never reach the reader, read-only fields cannot change and keep their value when left out", async () => {
  const { z } = await import("zod");
  const { MemoryStorage } = await import("./storage");
  void MemoryStorage;
  const editor: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
  const products = defineCollection({
    slug: "products",
    label: "Products",
    visibility: "public",
    fields: z.object({ price: z.number().optional(), cost: z.number().optional(), sku: z.string().optional() }),
    access: { write: ({ actor }) => actor.kind === "user" },
    fieldAccess: {
      cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin },
      price: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
    },
    fieldHooks: { sku: { beforeChange: (v) => (typeof v === "string" ? v.trim().toUpperCase() : v), afterRead: (v, { actor }) => (actor.kind === "anonymous" ? undefined : v) } },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [products], warn: () => {} });
  await cms.create(admin, "products", { slug: "mug", title: "Mug", body: "x\n", fields: { price: 12, cost: 4, sku: " ab-1 " } }, { publish: true });
  const asAdmin = await cms.get(admin, "products", "mug", { draft: true });
  assert.deepEqual(asAdmin.fields, { price: 12, cost: 4, sku: "AB-1" }, "the field hook ran on save");
  const asEditor = await cms.get(editor, "products", "mug", { draft: true });
  assert.deepEqual(asEditor.fields, { price: 12, sku: "AB-1" }, "cost is hidden from the editor");
  assert.deepEqual((await cms.get(anon, "products", "mug")).fields, { price: 12 }, "afterRead per field");
  // The editor saves the form it got (no cost): the cost is kept.
  await cms.update(editor, "products", "mug", { title: "Big mug", fields: asEditor.fields });
  assert.deepEqual((await cms.get(admin, "products", "mug", { draft: true })).fields, { price: 12, cost: 4, sku: "AB-1" });
  // Changing a read-only field is refused; sending it unchanged is fine.
  await assert.rejects(cms.update(editor, "products", "mug", { fields: { ...asEditor.fields, price: 1 } }), (e: unknown) => (e as { code?: string }).code === "forbidden_field");
  // An editor sending a cost it cannot see does not overwrite it.
  await cms.update(editor, "products", "mug", { fields: { price: 12, sku: "ab-1", cost: 999 } });
  assert.equal((await cms.get(admin, "products", "mug", { draft: true })).fields.cost, 4);
  // Lists apply the same rules.
  const listed = await cms.list(editor, "products", { drafts: true });
  assert.equal("cost" in listed[0].fields, false);
  assert.deepEqual(cms.fieldRulesFor(editor, "products", asAdmin), { hidden: ["cost"], readOnly: ["price"] });
  // Through REST: _schema tells the form, an autosave cannot sneak a change in.
  const handler = createCmsHandler({ cms, resolveUser: async () => editor, trustedOrigins: ["http://app.test"] });
  const schema = await (await handler(new Request("http://app.test/api/cms/collections/products/_schema?slug=mug"))).json();
  assert.deepEqual(schema.fieldRules, { hidden: ["cost"], readOnly: ["price"] });
  const auto = await handler(new Request("http://app.test/api/cms/collections/products/mug/autosave", { method: "PUT", headers: { origin: "http://app.test", "content-type": "application/json" }, body: JSON.stringify({ doc: { fields: { price: 2 } }, baseVersion: 3 }) }));
  assert.equal(auto.status, 403, await auto.text());
});

test("hooks: beforeRead refuses reads (one, lists, pages); afterRead runs on list rows too", async () => {
  let closed = false;
  const seen: string[] = [];
  const g = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    hooks: {
      beforeRead: [({ actor, slug }) => { if (closed && actor.kind === "anonymous") throw new Error(`closed${slug ? ` (${slug})` : ""}`); }],
      afterRead: [(d, { list }) => (seen.push(list ? "list" : "one"), { ...d, title: d.title.toUpperCase() })],
    },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [g], warn: () => {} });
  await cms.create(admin, "guide", { slug: "a", title: "Hello", body: "x\n" }, { publish: true });
  assert.equal((await cms.get(anon, "guide", "a")).title, "HELLO");
  assert.deepEqual((await cms.list(anon, "guide")).map((d) => d.title), ["HELLO"]);
  assert.deepEqual((await cms.page(anon, "guide")).docs.map((d) => d.title), ["HELLO"]);
  assert.deepEqual(seen, ["one", "list", "list"]);
  closed = true;
  for (const p of [cms.get(anon, "guide", "a"), cms.list(anon, "guide"), cms.page(anon, "guide")]) await assert.rejects(p, (e: unknown) => (e as { code?: string }).code === "hook_rejected");
  assert.equal((await cms.get(admin, "guide", "a")).title, "HELLO", "the hook decides who");
});

test("roles: a role can let people upload and delete in a media store without being an admin", async () => {
  const { MemoryStorage } = await import("./storage");
  const writer: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide()], warn: () => {}, media: { stores: { media: { adapter: new MemoryStorage(), visibility: "public" } } } });
  const want = { name: "a.png", size: 10, mime: "image/png" };
  await assert.rejects(cms.assets.requestUpload(writer, want), (e: unknown) => (e as { code?: string }).code === "forbidden_media");
  const { targets } = await cms.roles.list(admin);
  assert.deepEqual(targets.map((t) => [t.slug, t.label, !!t.media]), [["guide", "Guide", false], ["media:media", "Media", true]]);
  const role = await cms.roles.create(admin, { name: "Writers", permissions: { guide: { write: true }, "media:media": { write: true, publish: true, html: true } } });
  assert.deepEqual(role.permissions["media:media"], { write: true, read: true }, "only write and delete count for files");
  await cms.roles.addMember(admin, role.id, { id: "u2", label: "Lee" });
  const ok = await cms.assets.requestUpload(writer, want);
  assert.ok(ok.asset.id);
  assert.equal(cms.assets.describe(writer)!.stores[0].can.write, true);
  assert.equal(cms.assets.describe(writer)!.stores[0].can.delete, false);
});

test("review fixes: hidden fields are gone from every copy, cannot be set on create; a shared cache keeps CMSs apart; a young gap in the log waits", async () => {
  const { z } = await import("zod");
  const editor: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
  const col = defineCollection({
    slug: "products",
    label: "Products",
    visibility: "public",
    fields: z.object({ cost: z.number().optional() }),
    access: { write: ({ actor }) => actor.kind === "user" },
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [col], warn: () => {} });
  await cms.create(admin, "products", { slug: "a", title: "A", body: "x\n", fields: { cost: 4 } }, { publish: true });
  const seen = await cms.get(editor, "products", "a", { draft: true });
  assert.doesNotMatch(JSON.stringify(seen), /"cost"/, "not in fields, published or autosave");
  await cms.create(editor, "products", { slug: "b", title: "B", body: "x\n", fields: { cost: 9 } });
  assert.equal((await cms.get(admin, "products", "b", { draft: true })).fields.cost, undefined, "a field the creator cannot see is not taken");

  const store = memoryCache();
  const one = createCms({ repo: new MemoryRepo(), collections: [guide()], warn: () => {}, cache: store, changes: { log: false } });
  const two = createCms({ repo: new MemoryRepo(), collections: [guide()], warn: () => {}, cache: store, changes: { log: false } });
  await one.create(admin, "guide", { slug: "same", title: "One", body: "x\n" }, { publish: true });
  await two.create(admin, "guide", { slug: "same", title: "Two", body: "x\n" }, { publish: true });
  assert.equal((await one.get(anon, "guide", "same")).title, "One");
  assert.equal((await two.get(anon, "guide", "same")).title, "Two");

  const repo = new MemoryRepo();
  const c = createCms({ repo, collections: [guide()], warn: () => {} });
  await repo.appendChange({ event: "doc.created", collection: "guide", slug: "x", version: 1, origin: "o", data: {} });
  // Number 2 is still committing elsewhere; 3 is already visible.
  (repo as unknown as { changes: { seq: number }[] }).changes.push({ ...(await repo.changesSince(0, 1))[0], seq: 3, slug: "z" } as never);
  const r = await c.changes.since(admin, 0, { hear: () => true });
  assert.deepEqual([r!.changes.map((x) => x.seq), r!.last, r!.more], [[1], 1, true]);
});
