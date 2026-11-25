import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "./cms";
import { definePlugin } from "./plugin";
import { fuse, pickSections, runRanker, type SearchRankContext, type SearchRankerHit } from "./rankers";
import { MemoryRepo } from "./repo";
import { unitsOf } from "./search";
import { createTestCms } from "./testing";

const pages = defineCollection({ slug: "pages", label: "Pages", visibility: "public" });
const secret = defineCollection({ slug: "secret", label: "Secret", visibility: "internal", access: { read: ({ actor }) => actor.kind === "user" } });
const snippets = defineCollection({ slug: "snips", label: "Snippets", visibility: "public", snippets: true });

/** A ranker that returns what `answer` says, and remembers what it was asked. */
function fixed(answer: (q: string, ctx: SearchRankContext) => SearchRankerHit[] | Promise<SearchRankerHit[]>, o: { name?: string; timeoutMs?: number; weight?: number } = {}) {
  const asked: { q: string; ctx: SearchRankContext }[] = [];
  const plugin = definePlugin({
    name: "vec",
    setup(ctx) {
      ctx.search.ranker({ name: o.name ?? "emb", timeoutMs: o.timeoutMs, weight: o.weight, rank: (q, c) => (asked.push({ q, ctx: c }), answer(q, c)) });
    },
  });
  return { plugin, asked };
}

async function seed(t: ReturnType<typeof createTestCms>) {
  const a = t.admin;
  await t.cms.create(a, "pages", { slug: "billing", title: "Card approval errors", body: "## Declined\nThe card was declined by the bank.\n\n## Limits\nDaily limits apply.\n" }, { publish: true });
  await t.cms.create(a, "pages", { slug: "slack", title: "Connect Slack", body: "## Setup\nPaste the webhook address.\n" }, { publish: true });
  await t.cms.create(a, "pages", { slug: "draft", title: "Payment draft", body: "Payment does not work yet.\n" });
  const billing = await t.cms.get(a, "pages", "billing");
  const slack = await t.cms.get(a, "pages", "slack");
  const draft = await t.cms.get(a, "pages", "draft", { draft: true });
  return { billing, slack, draft };
}

test("rankers: a document with no shared words is found, merged by rank, read rules after", async () => {
  let ids: Record<string, string> = {};
  const { plugin, asked } = fixed(() => [{ documentId: ids.draft, section: null }, { documentId: "nope" }, { documentId: ids.billing, section: "limits", score: 0.9 }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    const d = await seed(t);
    ids = { billing: d.billing.id, slack: d.slack.id, draft: d.draft.id };
    const r = await t.cms.search(t.anon, ["pages"], "payment is not going through");
    // The draft and the unknown id are dropped; the billing page comes in the section asked for.
    assert.deepEqual(r.hits.map((h) => [h.unit.slug, h.unit.anchor, h.matchedBy]), [["billing", "limits", ["vec.emb"]]]);
    assert.equal(r.empty, false);
    assert.ok(r.hits[0].score > 0 && r.hits[0].score < 0.1, "a fused score");
    assert.equal(asked[0].ctx.locale, null);
    assert.deepEqual(asked[0].ctx.collections, ["pages"]);
    assert.equal(asked[0].ctx.actor.kind, "anonymous");
    assert.ok(asked[0].ctx.signal instanceof AbortSignal);

    // Both lists agree: keyword first, then the ranker; a hit both found adds up.
    const both = await t.cms.search(t.anon, ["pages"], "card declined");
    assert.equal(both.hits[0].unit.slug, "billing");
    assert.ok(both.hits.some((h) => h.matchedBy?.includes("keyword")));
    const top = both.hits.find((h) => h.unit.anchor === "limits");
    assert.deepEqual(top?.matchedBy, ["keyword", "vec.emb"].filter((n) => top?.matchedBy?.includes(n)));

    // rankers: false is the keyword search as before.
    const plain = await t.cms.search(t.anon, ["pages"], "payment is not going through", { rankers: false });
    assert.deepEqual(plain.hits, []);
    assert.equal(plain.empty, true);
    assert.equal(asked.length, 2);
  } finally {
    await t.close();
  }
});

test("rankers: no section, or one that is gone: the keyword search's best section, else the first", async () => {
  let id = "";
  let section: string | null = null;
  const { plugin } = fixed(() => [{ documentId: id, section }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    const d = await seed(t);
    id = d.billing.id;
    section = "renamed-heading";
    let r = await t.cms.search(t.anon, ["pages"], "zzz unknown words");
    assert.equal(r.hits[0].unit.anchor, "declined");
    // The keyword search liked "limits" best.
    r = await t.cms.search(t.anon, ["pages"], "daily");
    assert.equal(r.hits[0].unit.anchor, "limits");
    section = null;
    r = await t.cms.search(t.anon, ["pages"], "qqq");
    assert.equal(r.hits[0].unit.anchor, "declined");
  } finally {
    await t.close();
  }
});

test("rankers: a document the reader may not read never shows", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id }]);
  const t = createTestCms({ collections: [pages, secret], plugins: [plugin] });
  try {
    await t.cms.create(t.admin, "secret", { slug: "s", title: "Hidden", body: "Top secret.\n" }, { publish: true });
    id = (await t.cms.get(t.admin, "secret", "s")).id;
    // A reader who searches pages only: the secret document is not in what they search.
    assert.deepEqual((await t.cms.search(t.anon, ["pages"], "anything")).hits, []);
    // Signed in, searching the secret collection: allowed.
    assert.equal((await t.cms.search(t.writer, ["secret"], "anything")).hits[0]?.unit.slug, "s");
  } finally {
    await t.close();
  }
});

test("rankers: late or failing rankers are skipped, told once a minute, and aborted", async () => {
  let aborted = false;
  const slow = definePlugin({
    name: "slow",
    setup(ctx) {
      ctx.search.ranker({
        name: "late",
        timeoutMs: 30,
        rank: (_q, c) =>
          new Promise((ok) => {
            c.signal.addEventListener("abort", () => (aborted = true));
            setTimeout(() => ok([]), 300);
          }),
      });
      ctx.search.ranker({ name: "broken", rank: () => { throw new Error("boom"); } });
    },
  });
  const events: { type: string; rankers?: unknown }[] = [];
  const t = createTestCms({ collections: [pages], plugins: [slow] });
  const off = t.cms.onTelemetry((e) => void events.push(e as never));
  try {
    await seed(t);
    const r = await t.cms.search(t.anon, ["pages"], "slack");
    assert.equal(r.hits[0].unit.slug, "slack");
    assert.equal(r.hits[0].matchedBy, undefined, "nothing merged: the keyword search as before");
    assert.ok(aborted);
    await t.cms.search(t.anon, ["pages"], "slack");
    const reported = t.errors.filter((e) => e.where.startsWith("search ranker"));
    assert.deepEqual(reported.map((e) => e.where).sort(), ["search ranker slow.broken", "search ranker slow.late"]);
    const s = events.filter((e) => e.type === "search").at(-1) as { rankers: { name: string; ok: boolean; timedOut?: boolean }[] };
    assert.deepEqual(s.rankers.map((x) => [x.name, x.ok, !!x.timedOut]), [["slow.late", false, true], ["slow.broken", false, false]]);
  } finally {
    off();
    await t.close();
  }
});

test("rankers: a plugin that failed to start adds no ranker; the plugins screen lists it", async () => {
  const bad = definePlugin({
    name: "bad",
    setup(ctx) {
      ctx.search.ranker({ name: "r", rank: () => [] });
    },
    start() {
      throw new Error("no");
    },
  });
  const t = createTestCms({ collections: [pages], plugins: [bad] });
  try {
    await t.ready().catch(() => undefined);
    await seed(t);
    const r = await t.cms.search(t.anon, ["pages"], "slack");
    assert.equal(r.hits[0].matchedBy, undefined);
    const info = t.cms.plugins.get("bad")!;
    assert.equal(info.registered.rankers, 1);
    assert.deepEqual(info.added, [{ kind: "rankers", name: "bad.r" }]);
    assert.throws(() => createTestCms({ plugins: [definePlugin({ name: "dup", setup: (c) => (c.search.ranker({ name: "a", rank: () => [] }), c.search.ranker({ name: "a", rank: () => [] })) })] }), /added twice/);
    assert.throws(() => createTestCms({ plugins: [definePlugin({ name: "badname", setup: (c) => c.search.ranker({ name: "A B", rank: () => [] }) })] }), /must be lowercase/);
  } finally {
    await t.close();
  }
});

test("REST and MCP: matchedBy and the fused score; rankers=0", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    id = (await seed(t)).billing.id;
    const r = (await (await t.fetch("/search?q=payment+trouble", {}, { as: "anon" })).json()) as { hits: { slug: string; matchedBy?: string[]; score: number }[] };
    assert.deepEqual(r.hits.map((h) => [h.slug, h.matchedBy]), [["billing", ["vec.emb"]]]);
    const off = (await (await t.fetch("/search?q=payment+trouble&rankers=0", {}, { as: "anon" })).json()) as { hits: unknown[] };
    assert.deepEqual(off.hits, []);
    const tool = await t.tool("search_documents", { query: "payment trouble" }, { as: "writer" });
    assert.equal(tool.ok, true);
    assert.deepEqual((tool as { value: { slug: string; matchedBy?: string[] }[] }).value.map((h) => [h.slug, h.matchedBy]), [["billing", ["vec.emb"]]]);
  } finally {
    await t.close();
  }
});

test("sections: what the index holds, by id or by the address events carry; missing; pages; admins only", async () => {
  const seen: { event: string; sections: string[]; missing: number }[] = [];
  const watcher = definePlugin({
    name: "watch",
    setup(ctx) {
      const follow = async (e: { event: string; collection?: string | null; slug?: string | null }) => {
        const page = await ctx.search.sections({ docs: [{ collection: e.collection!, slug: e.slug! }] });
        seen.push({ event: e.event, sections: page.sections.map((s) => `${s.slug}#${s.anchor}`), missing: page.missing.docs.length });
      };
      ctx.on("doc.published", follow);
      ctx.on("doc.unpublished", follow);
    },
  });
  const t = createTestCms({ collections: [pages], plugins: [watcher] });
  try {
    const d = await seed(t);
    await t.flush();
    assert.deepEqual(seen.map((s) => [s.event, s.sections, s.missing]), [
      ["doc.published", ["billing#declined", "billing#limits"], 0],
      ["doc.published", ["slack#setup"], 0],
    ]);
    await t.cms.unpublish(t.admin, "pages", "slack");
    await t.flush();
    assert.deepEqual(seen.at(-1), { event: "doc.unpublished", sections: [], missing: 1 });

    const byId = await t.cms.searchSections({ docIds: [d.billing.id, d.draft.id] });
    assert.equal(byId.sections.length, 2);
    assert.deepEqual(byId.missing.docIds, [d.draft.id]);
    const s0 = byId.sections[0];
    assert.equal(s0.text, "The card was declined by the bank.");
    assert.match(s0.hash, /^[0-9a-f]{64}$/);
    // The same text, the same hash.
    assert.equal((await t.cms.searchSections({ docIds: [d.billing.id] })).sections[0].hash, s0.hash);

    // Everything, a page at a time.
    await t.cms.create(t.admin, "pages", { slug: "third", title: "Third", body: "x\n" }, { publish: true });
    const p1 = await t.cms.searchSections({ limit: 1 });
    assert.equal(new Set(p1.sections.map((s) => s.docId)).size, 1);
    assert.ok(p1.next);
    // billing and third (slack is not published any more).
    const p2 = await t.cms.searchSections({ limit: 1, cursor: p1.next });
    assert.equal(p2.next, null);
    assert.deepEqual([...new Set([...p1.sections, ...p2.sections].map((s) => s.slug))].sort(), ["billing", "third"]);

    // REST: admins only.
    assert.equal((await t.fetch("/search/sections", {}, { as: "writer" })).status, 403);
    assert.equal((await t.fetch("/search/sections", {}, { as: "anon" })).status, 401);
    const rest = (await (await t.fetch("/search/sections?docs=pages/billing,pages/gone")).json()) as { sections: { slug: string }[]; missing: { docs: { slug: string }[] } };
    assert.equal(rest.sections.length, 2);
    assert.deepEqual(rest.missing.docs.map((x) => x.slug), ["gone"]);
    assert.equal((await t.fetch("/search/sections?docs=nocollection")).status, 422);
    const viaClient = await t.client().searchSections({ docIds: [d.billing.id] });
    assert.equal(viaClient.sections.length, 2);
  } finally {
    await t.close();
  }
});

test("search.stale: a published snippet changes what documents read", async () => {
  const heard: string[] = [];
  const watcher = definePlugin({ name: "watch", setup: (ctx) => ctx.on("search.stale", (e) => void heard.push(`${e.collection}/${e.slug}`)) });
  const t = createTestCms({ collections: [pages, snippets], plugins: [watcher] });
  try {
    await t.cms.create(t.admin, "snips", { slug: "price", title: "Price", body: "10 dollars\n" }, { publish: true });
    await t.cms.create(t.admin, "pages", { slug: "p", title: "P", body: "It costs [[snippet:price]].\n" }, { publish: true });
    await t.flush();
    heard.length = 0;
    await t.cms.update(t.admin, "snips", "price", { body: "12 dollars\n" }, { publish: true });
    await t.flush();
    assert.deepEqual(heard, ["snips/price"]);
    const page = await t.cms.searchSections({ docs: [{ collection: "pages", slug: "p" }] });
    assert.match(page.sections[0].text, /12 dollars/);
  } finally {
    await t.close();
  }
});

test("fuse and pickSections: plain functions", async () => {
  const units = unitsOf({ id: "d1", collection: "c", slug: "a", title: "A", summary: "", body: "## One\nx\n\n## Two\ny\n", category: null, keywords: [], publishedAt: null, fields: {} });
  const [one, two] = units;
  const out = fuse([{ name: "keyword", weight: 1, units: [one, two] }, { name: "p.r", weight: 2, units: [two] }], () => 1);
  assert.deepEqual(out.map((h) => [h.unit.anchor, h.matchedBy]), [["two", ["keyword", "p.r"]], ["one", ["keyword"]]]);
  assert.throws(() => pickSections(units, { docIds: Array.from({ length: 201 }, (_, i) => `x${i}`) }, { localized: () => false, defaultLocale: undefined }), /at most 200/);
  const run = await runRanker("p.r", { name: "r", rank: () => "nope" as never }, "q", { collections: [], locale: null, limit: 1, actor: { kind: "anonymous" } });
  assert.equal(run.ok, false);
});

test("review 0.25: a ranker that found nothing changes nothing; a slow synchronous one is not used", async () => {
  const quiet = definePlugin({
    name: "quiet",
    setup(ctx) {
      ctx.search.ranker({ name: "none", rank: () => [] });
      ctx.search.ranker({
        name: "blocking",
        timeoutMs: 20,
        rank: () => {
          const until = Date.now() + 60;
          while (Date.now() < until);
          return [{ documentId: "x" }];
        },
      });
    },
  });
  const t = createTestCms({ collections: [pages], plugins: [quiet] });
  try {
    await seed(t);
    const r = await t.cms.search(t.anon, ["pages"], "slack");
    const plain = await t.cms.search(t.anon, ["pages"], "slack", { rankers: false });
    assert.deepEqual(r.hits, plain.hits);
    assert.equal(r.hits[0].matchedBy, undefined);
    assert.ok(t.errors.some((e) => e.where === "search ranker quiet.blocking"));
  } finally {
    await t.close();
  }
});

test("review 0.25: the app's filter is asked about the section the ranker chose", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id, section: "limits" }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    id = (await seed(t)).billing.id;
    const r = await t.cms.search(t.anon, ["pages"], "qqq", { filter: (u) => u.anchor === "limits" });
    assert.deepEqual(r.hits.map((h) => h.unit.anchor), ["limits"]);
  } finally {
    await t.close();
  }
});

test("review 0.25: a document only a ranker found is checked against the database (index behind)", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    const d = await seed(t);
    id = d.billing.id;
    assert.equal((await t.cms.search(t.anon, ["pages"], "qqq")).hits.length, 1);
    // Unpublished behind the CMS's back (another server): the index still holds it.
    await t.repo.updateDoc(id, { status: "draft", publishedVersion: null });
    assert.deepEqual((await t.cms.search(t.anon, ["pages"], "qqq")).hits, []);
  } finally {
    await t.close();
  }
});

test("review 0.25: sections need an admin who is not limited to some collections; MCP can turn rankers off; empty asks", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id }]);
  const t = createTestCms({ collections: [pages], plugins: [plugin] });
  try {
    id = (await seed(t)).billing.id;
    const scoped = await t.cms.createKey(t.admin, { name: "scoped", scopes: ["admin"], collections: ["pages"] });
    const wide = await t.cms.createKey(t.admin, { name: "wide", scopes: ["admin"] });
    const as = (secret: string) => t.fetch("/search/sections", { headers: { authorization: `Bearer ${secret}` } }, { as: "anon" });
    assert.equal((await as(scoped.secret)).status, 403);
    assert.equal((await as(wide.secret)).status, 200);

    const off = await t.tool("search_documents", { query: "payment trouble", rankers: false }, { as: "writer" });
    assert.deepEqual((off as { value: unknown[] }).value, []);
    const on = await t.tool("search_documents", { query: "payment trouble" }, { as: "writer" });
    assert.equal((on as { value: unknown[] }).value.length, 1);

    assert.deepEqual(await t.client().searchSections({ docIds: [] }), { sections: [], missing: { docIds: [], docs: [] }, next: null });
  } finally {
    await t.close();
  }
});

test("delta 0.25: a ranker whose only hit the reader may not read changes nothing", async () => {
  let id = "";
  const { plugin } = fixed(() => [{ documentId: id }]);
  const ruledPages = defineCollection({ slug: "docs", label: "Docs", visibility: "public", access: { read: ({ doc }) => !doc || doc.slug !== "private" } });
  const t = createTestCms({ collections: [ruledPages], plugins: [plugin] });
  try {
    await t.cms.create(t.admin, "docs", { slug: "open", title: "Slack setup", body: "Connect Slack.\n" }, { publish: true });
    await t.cms.create(t.admin, "docs", { slug: "private", title: "Hidden", body: "Nothing.\n" }, { publish: true });
    id = (await t.cms.searchSections({ docs: [{ collection: "docs", slug: "private" }] })).sections[0].docId;
    const r = await t.cms.search(t.anon, ["docs"], "slack");
    assert.deepEqual(r.hits, (await t.cms.search(t.anon, ["docs"], "slack", { rankers: false })).hits);
    assert.equal(r.hits[0].matchedBy, undefined);
  } finally {
    await t.close();
  }
});

test("delta 0.25: unarchiving a published page with a pending draft tells search.stale", async () => {
  const heard: string[] = [];
  const watcher = definePlugin({ name: "watch", setup: (ctx) => ctx.on("search.stale", (e) => void heard.push(`${e.slug}:${(e.detail as { reason?: string }).reason}`)) });
  const t = createTestCms({ collections: [pages], plugins: [watcher] });
  try {
    await t.cms.create(t.admin, "pages", { slug: "a", title: "A", body: "one\n" }, { publish: true });
    await t.cms.update(t.admin, "pages", "a", { body: "two\n" });
    await t.cms.archive(t.admin, "pages", "a");
    await t.cms.unarchive(t.admin, "pages", "a");
    await t.flush();
    assert.deepEqual(heard, ["a:unarchive"]);
    assert.equal((await t.cms.searchSections({ docs: [{ collection: "pages", slug: "a" }] })).sections.length, 1);
  } finally {
    await t.close();
  }
});

test("0.25.1: sections wait for a rebuild that started before the write; a failed rebuild is an error", async () => {
  const repo = new MemoryRepo();
  let failNext = false;
  const list = repo.listDocs.bind(repo);
  repo.listDocs = (async (...a: Parameters<typeof list>) => {
    if (failNext) {
      failNext = false;
      throw new Error("database is gone");
    }
    // A slow read: the rebuild is still running when the write below lands.
    await new Promise((r) => setTimeout(r, 20));
    return list(...a);
  }) as typeof repo.listDocs;
  const t = createTestCms({ collections: [pages], repo });
  try {
    await t.cms.create(t.admin, "pages", { slug: "a", title: "A", body: "one\n" }, { publish: true });
    await t.cms.search(t.admin, ["pages"], "one");
    await t.cms.update(t.admin, "pages", "a", { body: "two\n" }, { publish: true });
    const searching = t.cms.search(t.admin, ["pages"], "two"); // starts a rebuild
    await t.cms.update(t.admin, "pages", "a", { body: "three\n" }, { publish: true });
    const page = await t.cms.searchSections({ docs: [{ collection: "pages", slug: "a" }] });
    assert.match(page.sections[0].text, /three/);
    await searching;

    await t.cms.update(t.admin, "pages", "a", { body: "four\n" }, { publish: true });
    failNext = true;
    await assert.rejects(t.cms.searchSections({ docs: [{ collection: "pages", slug: "a" }] }), /database is gone/);
    // Searches still answer (from the last index, then a good rebuild).
    await t.cms.search(t.admin, ["pages"], "four");
    assert.match((await t.cms.searchSections({ docs: [{ collection: "pages", slug: "a" }] })).sections[0].text, /four/);
  } finally {
    await t.close();
  }
});

test("0.25.1: renaming a source tells search.stale for each live translation at its new address", async () => {
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", localized: true });
  const heard: string[] = [];
  const watcher = definePlugin({ name: "watch", setup: (ctx) => ctx.on("search.stale", (e) => void heard.push(`${e.slug}@${(e as { locale?: string }).locale}:${(e.detail as { reason?: string }).reason}:${(e.detail as { from?: string }).from}`)) });
  const t = createTestCms({ collections: [guide], plugins: [watcher], locales: ["ko", "en", "ja"], defaultLocale: "ko", redirects: true });
  try {
    await t.cms.create(t.admin, "guide", { slug: "start", title: "시작", body: "본문\n" }, { publish: true });
    await t.cms.create(t.admin, "guide", { slug: "start", title: "Start", body: "Body\n" }, { locale: "en", publish: true });
    await t.cms.create(t.admin, "guide", { slug: "start", title: "始め", body: "本文\n" }, { locale: "ja" }); // a draft: not searchable
    await t.flush();
    heard.length = 0;
    await t.cms.update(t.admin, "guide", "start", { slug: "begin" }, { publish: true });
    await t.flush();
    assert.equal(heard.length, 1, heard.join(", "));
    assert.match(heard[0], /^begin@en:moved:start@en$/);
    const page = await t.cms.searchSections({ docs: [{ collection: "guide", slug: "begin", locale: "en" }] });
    assert.equal(page.sections[0]?.slug, "begin");
  } finally {
    await t.close();
  }
});

test("0.25.1: sections by address work for a slug with a comma (repeated doc=); OpenAPI names the section fields", async () => {
  const odd = defineCollection({ slug: "odd", label: "Odd", visibility: "public", slugPattern: /^[a-z0-9,-]+$/ });
  const t = createTestCms({ collections: [odd] });
  try {
    await t.cms.create(t.admin, "odd", { slug: "a,b", title: "Comma", body: "Hello\n" }, { publish: true });
    await t.cms.create(t.admin, "odd", { slug: "c", title: "C", body: "Hi\n" }, { publish: true });
    const rest = (await (await t.fetch(`/search/sections?doc=${encodeURIComponent("odd/a,b")}&doc=odd/c`)).json()) as { sections: { slug: string }[]; missing: { docs: unknown[] } };
    assert.deepEqual(rest.sections.map((s) => s.slug).sort(), ["a,b", "c"]);
    assert.equal(rest.missing.docs.length, 0);
    assert.equal((await t.fetch("/search/sections?doc=")).status, 422, "a blank doc= is refused, not a listing");
    const viaClient = await t.client().searchSections({ docs: [{ collection: "odd", slug: "a,b" }] });
    assert.deepEqual(viaClient.sections.map((s) => s.slug), ["a,b"]);
    const spec = (await (await t.fetch("/openapi.json")).json()) as { components: { schemas: Record<string, { properties: Record<string, unknown> }> }; paths: Record<string, { get: { parameters?: { name: string }[] } }> };
    assert.ok(spec.components.schemas.SearchSection.properties.hash);
    assert.ok(spec.components.schemas.SearchDocRef.properties.collection);
    assert.ok(spec.paths["/search/sections"].get.parameters?.some((p) => p.name === "doc"));
  } finally {
    await t.close();
  }
});

test("0.25.1: the change stamp sees a write that committed after a newer one", async () => {
  const repo = new MemoryRepo();
  const t = createTestCms({ collections: [pages], repo });
  try {
    await t.cms.create(t.admin, "pages", { slug: "a", title: "A", body: "one\n" }, { publish: true });
    await t.cms.create(t.admin, "pages", { slug: "b", title: "B", body: "two\n" }, { publish: true });
    const a = await t.cms.get(t.admin, "pages", "a");
    const before = await repo.changeStamp();
    // A slow transaction lands with a time older than the newest row: count and newest time stay.
    await repo.updateDoc(a.id, { status: "archived", updatedAt: "2000-01-01T00:00:00.000Z" }, a.version);
    assert.notEqual(await repo.changeStamp(), before);
  } finally {
    await t.close();
  }
});
