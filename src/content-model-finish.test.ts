/** 0.21.0, second pass: archive asks about references, redirects to documents, 30-day visits, share image size, citation aliases, tree moves at once, inline snippets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { lookupForAgent, verifyCitations } from "./agent";
import { createCms, defineCollection } from "./cms";
import { relation } from "./fields";
import { MemoryRepo } from "./repo";
import { CMS_TOOLS, toolsFor } from "./tools";
import { CmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const editor: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };

async function rejects(p: Promise<unknown>, code: string, check?: (e: CmsError) => void) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof CmsError) || e.code !== code) return false;
    check?.(e);
    return true;
  });
}

function setup(o: { redirects?: boolean; retention?: Record<string, number> } = {}) {
  const repo = new MemoryRepo();
  const people = defineCollection({ slug: "people", label: "People", visibility: "public", url: (d) => `/people/${d.slug}` });
  const guides = defineCollection({
    slug: "guides",
    label: "Guides",
    visibility: "public",
    tree: { maxDepth: 5 },
    seo: true,
    url: (d) => `/guides/${d.slug}`,
    fields: z.object({ author: relation("people").optional() }),
  });
  const notes = defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });
  const snippets = defineCollection({ slug: "snippets", label: "Snippets", visibility: "public", snippets: true });
  const cms = createCms({ repo, collections: [people, guides, notes, snippets], searchRefreshMs: 0, redirects: o.redirects ?? false, retention: o.retention });
  return { repo, cms };
}

test("archive: documents pointing here are listed (409 doc_referenced); force hides it anyway; REST and the agent tool too", async () => {
  const { cms } = setup();
  await cms.create(admin, "people", { slug: "kim", title: "Kim" }, { publish: true });
  await cms.create(admin, "guides", { slug: "intro", title: "Intro", fields: { author: { collection: "people", slug: "kim" } as never } }, { publish: true });
  await rejects(cms.archive(admin, "people", "kim"), "doc_referenced", (e) => {
    assert.equal(e.status, 409);
    assert.equal((e.diagnostics ?? [])[0]?.params?.slug, "intro");
  });
  assert.equal((await cms.get(admin, "people", "kim", { draft: true })).status, "published", "nothing changed");

  const { createCmsHandler } = await import("./http");
  const h = createCmsHandler({ cms, basePath: "/api", resolveUser: async () => admin });
  const post = (p: string, body: unknown) => h(new Request(`http://x/api${p}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://x" }, body: JSON.stringify(body) }));
  const refused = await post("/collections/people/kim/archive", {});
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: string }).error, "doc_referenced");

  // The agent tool: refused without force, hidden with it.
  const tool = CMS_TOOLS.find((t) => t.name === "archive_document")!;
  await rejects(Promise.resolve(tool.run(cms.core, admin, { collection: "people", slug: "kim", archived: true })), "doc_referenced");
  const forced = await post("/collections/people/kim/archive", { force: true });
  assert.equal(forced.status, 200);
  assert.equal((await cms.get(admin, "people", "kim", { draft: true })).status, "archived");
  // Showing it again needs no question; a document nobody points at is hidden without one.
  await cms.unarchive(admin, "people", "kim");
  await cms.create(admin, "people", { slug: "lee", title: "Lee" }, { publish: true });
  assert.equal((await tool.run(cms.core, admin, { collection: "people", slug: "lee", archived: true })) && (await cms.get(admin, "people", "lee", { draft: true })).status, "archived");
  // Bulk: the referenced one is reported, the rest goes through.
  const res = await cms.bulk(admin, "people", "archive", [{ slug: "kim" }]);
  assert.equal(res[0].ok, false);
  assert.equal(res[0].error?.code, "doc_referenced");
});

test("redirects to a document follow its current address; gone or not public: no redirect", async () => {
  const { cms } = setup({ redirects: true });
  const g = await cms.create(admin, "guides", { slug: "pricing", title: "Pricing" }, { publish: true });
  const r = await cms.core.redirects.create(admin, { from: "/old-pricing", toDocumentId: g.id });
  assert.equal(r.to, "/guides/pricing");
  assert.equal(r.toDocumentId, g.id);
  assert.deepEqual(await cms.core.resolveRedirect("/old-pricing"), { to: "/guides/pricing", status: 301 });
  // A rename: the redirect follows (and the automatic one from the old address is added).
  await cms.update(admin, "guides", "pricing", { slug: "plans" }, { publish: true });
  assert.deepEqual(await cms.core.redirects.resolve("/old-pricing"), { to: "/guides/plans", status: 301 });
  const listed = (await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!;
  assert.deepEqual(listed.target && [listed.target.title, listed.target.slug, listed.target.published], ["Pricing", "plans", true]);
  // Hidden: nowhere to go.
  await cms.archive(admin, "guides", "plans");
  assert.equal(await cms.core.resolveRedirect("/old-pricing"), null);
  assert.equal((await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!.target?.published, false);
  await cms.unarchive(admin, "guides", "plans");
  assert.deepEqual(await cms.core.resolveRedirect("/old-pricing"), { to: "/guides/plans", status: 301 });
  // Deleted: nowhere to go, and the list says so.
  await cms.remove(admin, "guides", "plans");
  assert.equal(await cms.core.resolveRedirect("/old-pricing"), null);
  assert.equal((await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!.target, null);
  // Documents without a public address cannot be targets; an address target replaces a document target.
  const n = await cms.create(admin, "notes", { slug: "n", title: "N" }, { publish: true });
  await rejects(cms.core.redirects.create(admin, { from: "/n", toDocumentId: n.id }), "redirect_document");
  const back = await cms.core.redirects.update(admin, r.id, { to: "/guides" });
  assert.equal(back.toDocumentId, null);
  assert.deepEqual(await cms.core.resolveRedirect("/old-pricing"), { to: "/guides", status: 301 });
});

test("redirects: a document target read by beforeRead rules stays private", async () => {
  const repo = new MemoryRepo();
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public", url: (d) => `/guides/${d.slug}`, access: { read: ({ doc }) => !doc?.slug.startsWith("secret") } });
  const cms = createCms({ repo, collections: [guides], searchRefreshMs: 0, redirects: true });
  const s = await cms.create(admin, "guides", { slug: "secret-plan", title: "S" }, { publish: true });
  await cms.core.redirects.create(admin, { from: "/s", toDocumentId: s.id });
  assert.equal(await cms.core.resolveRedirect("/s"), null, "an anonymous reader may not read it: its address is not handed out");
});

test("redirects: the warm path reads the document once per TTL; a change in this process is seen at once", async () => {
  const { cms, repo } = setup({ redirects: true });
  const g = await cms.create(admin, "guides", { slug: "a", title: "A" }, { publish: true });
  await cms.core.redirects.create(admin, { from: "/x", toDocumentId: g.id });
  let reads = 0;
  const orig = repo.findDocById.bind(repo);
  repo.findDocById = async (id: string, ...rest: unknown[]) => {
    reads++;
    return (orig as (...a: unknown[]) => ReturnType<typeof orig>)(id, ...rest);
  };
  for (let i = 0; i < 5; i++) await cms.core.resolveRedirect("/x");
  assert.equal(reads, 1, "one read, then the cache");
  await cms.update(admin, "guides", "a", { slug: "b" }, { publish: true });
  assert.deepEqual(await cms.core.resolveRedirect("/x"), { to: "/guides/b", status: 301 });
});

test("redirects: visits per day for 30 days (hits30d, daily, GET /redirects/:id/hits), old days pruned", async () => {
  const { cms, repo } = setup({ redirects: true });
  const m = await cms.core.redirects.create(admin, { from: "/promo", to: "/guides" });
  const o = await cms.core.redirects.create(admin, { from: "/older", to: "/guides" });
  // Visits of earlier days, as the minute flush would have written them.
  const today = new Date().toISOString().slice(0, 10);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  await repo.addRedirectHits(new Map([[o.id, 4]]), new Date().toISOString(), day(3));
  await repo.addRedirectHits(new Map([[o.id, 9]]), new Date().toISOString(), day(40));
  for (let i = 0; i < 3; i++) await cms.core.resolveRedirect("/promo");
  const list = await cms.core.redirects.list(admin);
  const pm = list.find((x) => x.id === m.id)!;
  assert.equal(pm.hits30d, 3, "visits not written yet count");
  assert.equal(pm.daily.length, 30);
  assert.equal(pm.daily[29], 3, "today is last");
  const old = list.find((x) => x.id === o.id)!;
  assert.equal(old.hits30d, 4, "the day 40 days ago is outside the window");
  assert.equal(old.daily[26], 4);
  const { createCmsHandler } = await import("./http");
  const h = createCmsHandler({ cms, basePath: "/api", resolveUser: async () => admin });
  const r = await h(new Request(`http://x/api/redirects/${m.id}/hits?days=7`));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { days: { day: string; n: number }[]; total: number };
  assert.equal(body.days.length, 7);
  assert.equal(body.total, 3);
  assert.deepEqual(body.days[6], { day: body.days[6].day, n: 3 });
  await rejects(cms.core.redirects.hits(editor, m.id), "forbidden_redirects");
  await rejects(cms.core.redirects.hits(admin, "00000000-0000-4000-8000-000000000000"), "redirect_not_found");
  // Retention: with redirects on, daily visits older than 90 days go (the total stays).
  assert.ok(cms.core.retention.rules().some((x) => x.what === "redirect_hits" && x.days === 90));
  await repo.addRedirectHits(new Map([[o.id, 1]]), new Date().toISOString(), day(120));
  const dry = await cms.core.retention.run(admin, { dryRun: true });
  assert.equal(dry.items.find((x) => x.what === "redirect_hits")?.rows, 1);
  await cms.core.retention.run(admin);
  assert.equal((await repo.redirectHitDays(day(400))).some((x) => x.day === day(120)), false);
  assert.ok((await repo.redirectHitDays(day(400))).some((x) => x.day === day(40)));
  // Deleting a redirect drops its days.
  await cms.core.redirects.remove(admin, o.id);
  assert.equal((await repo.redirectHitDays(day(400))).some((x) => x.redirectId === o.id), false);
});

test("seo: a share image smaller than 1200×630 is a warning with its size; the other checks are there", async () => {
  const { cms, repo } = setup();
  const asset = (id: string, width: number, height: number) =>
    repo.insertAsset({ id, store: "default", key: `${id}.jpg`, folder: "", name: `${id}.jpg`, kind: "image", mime: "image/jpeg", size: 10, width, height, duration: null, alt: "", tags: [], thumbKey: null, status: "ready", uploadId: null, createdBy: null, createdByKind: null, createdByAgent: null });
  await asset("smallsmall01", 800, 400);
  await asset("bigbigbigbig", 1600, 900);
  const small = await cms.diagnose(admin, "guides", { slug: "s", title: "S", summary: "x", seo: { image: "asset:smallsmall01/s.jpg" } });
  const w = small.find((d) => d.code === "seo_image_small");
  assert.ok(w, "warned");
  assert.equal(w!.severity, "warning");
  assert.deepEqual([w!.path, w!.params?.width, w!.params?.height], ["seo.image", 800, 400]);
  assert.match(w!.message, /800×400/);
  // The body's first picture is the share image when the SEO one is empty.
  const fromBody = await cms.diagnose(admin, "guides", { slug: "s", title: "S", summary: "x", body: "![a](asset:smallsmall01/s.jpg)" });
  assert.equal(fromBody.find((d) => d.code === "seo_image_small")?.path, "body");
  const big = await cms.diagnose(admin, "guides", { slug: "s", title: "S", summary: "x", seo: { image: "asset:bigbigbigbig/b.jpg" } });
  assert.ok(!big.some((d) => d.code === "seo_image_small"));
  const ext = await cms.diagnose(admin, "guides", { slug: "s", title: "S", summary: "x", seo: { image: "https://img.example/a.png" } });
  assert.ok(!ext.some((d) => d.code === "seo_image_small"), "size unknown: nothing said");
  // Saving is never blocked by it.
  await cms.create(admin, "guides", { slug: "ok", title: "OK", seo: { image: "asset:smallsmall01/s.jpg" } });
  const long = await cms.diagnose(admin, "guides", { slug: "l", title: "x".repeat(61), summary: "y".repeat(161) });
  assert.ok(long.some((d) => d.code === "seo_title_long"));
  assert.ok(long.some((d) => d.code === "seo_description_long"));
  const none = await cms.diagnose(admin, "guides", { slug: "n", title: "N" });
  assert.ok(none.some((d) => d.code === "seo_description_missing"));
  // seoFor(doc) is the plan's name; seoOf stays.
  const d = await cms.get(admin, "guides", "ok", { draft: true });
  assert.deepEqual(cms.core.seoFor(d), cms.core.seoOf(d));
});

test("citations under a renamed heading's old anchor are valid and come back with the current one", async () => {
  const { cms } = setup();
  await cms.create(admin, "guides", { slug: "slack", title: "Slack", body: "## Connect Slack\n\nOpen settings and press connect.", keywords: ["slack"] }, { publish: true });
  await cms.update(admin, "guides", "slack", { body: "## Connecting\n\nOpen settings and press connect." }, { publish: true });
  const r = await lookupForAgent(cms, anon, ["guides"], "slack connect");
  assert.equal(r.sections[0].id, "cms://guides/slack#connecting");
  assert.equal(r.aliases?.["cms://guides/slack#connect-slack"], "cms://guides/slack#connecting");
  const v = verifyCitations([{ id: "cms://guides/slack#connect-slack", quote: "open settings" }, { id: "cms://guides/slack#nope" }], r);
  assert.deepEqual(v.valid, [{ id: "cms://guides/slack#connecting", quote: "open settings", renamedFrom: "cms://guides/slack#connect-slack" }]);
  assert.deepEqual(v.invalid.map((x) => x.reason), ["unknown_id"]);
  // A quote that is not in the current section still fails.
  assert.equal(verifyCitations([{ id: "cms://guides/slack#connect-slack", quote: "not there" }], r).invalid[0].reason, "quote_not_found");
});

test("tree: two opposite moves at once never make a loop", async () => {
  const { cms } = setup();
  for (let round = 0; round < 10; round++) {
    const a = await cms.create(admin, "guides", { slug: `a${round}`, title: "A" });
    const b = await cms.create(admin, "guides", { slug: `b${round}`, title: "B" });
    const res: PromiseSettledResult<unknown>[] = await Promise.allSettled([cms.core.move(admin, "guides", a.slug, { parentId: b.id }), cms.core.move(admin, "guides", b.slug, { parentId: a.id })]);
    assert.equal(res.filter((x) => x.status === "fulfilled").length, 1, "one goes through");
    const rej = res.find((x) => x.status === "rejected") as PromiseRejectedResult;
    assert.equal((rej.reason as CmsError).code, "tree_cycle");
    const a2 = await cms.get(admin, "guides", a.slug, { draft: true });
    const b2 = await cms.get(admin, "guides", b.slug, { draft: true });
    assert.ok(!(a2.parentId === b.id && b2.parentId === a.id), "no loop");
  }
});

test("snippets inside a line: one paragraph goes in place; a longer one keeps the token and warns; counted as uses", async () => {
  const { cms } = setup();
  await cms.create(admin, "snippets", { slug: "price", title: "Price", body: "**$10**\na month" }, { publish: true });
  await cms.create(admin, "snippets", { slug: "steps", title: "Steps", body: "One.\n\nTwo." }, { publish: true });
  await cms.create(admin, "snippets", { slug: "draft-only", title: "D", body: "secret" });
  const body = "It costs [[snippet:price]] for now.\n\nSee [[snippet:steps]] here.\n\nHidden: [[snippet:draft-only]]!\n\n`[[snippet:price]]` stays in code?\n\n```\n[[snippet:price]]\n```";
  await cms.create(admin, "guides", { slug: "g", title: "G", summary: "s", body }, { publish: true });
  const pub = (await cms.get(anon, "guides", "g")).body;
  assert.match(pub, /^It costs \*\*\$10\*\* a month for now\./);
  assert.match(pub, /See \[\[snippet:steps\]\] here\./, "two paragraphs do not fit in a line");
  assert.match(pub, /Hidden: !/, "not published: removed like a block");
  assert.match(pub, /```\n\[\[snippet:price\]\]\n```/, "code fences stay");
  assert.match(pub, /`\[\[snippet:price\]\]` stays in code\?/, "inline code stays");
  // Editors and agents see the tokens.
  assert.equal((await cms.get(admin, "guides", "g", { draft: true })).body, body);
  assert.equal((await cms.get(anon, "guides", "g", { snippets: "raw" })).body, body);
  // Search reads the filled-in text.
  assert.ok((await cms.search(anon, ["guides"], "month")).hits.some((h) => h.unit.slug === "g"));
  // Uses count inline tokens.
  assert.deepEqual((await cms.core.snippetUses(admin, "snippets", "price")).map((d) => d.slug), ["g"]);
  // The warning, for editors.
  const d = await cms.diagnose(admin, "guides", { body: "See [[snippet:steps]] here." }, { slug: "g" });
  const w = d.find((x) => x.code === "snippet_inline_multi");
  assert.equal(w?.severity, "warning");
  assert.equal(w?.params?.key, "steps");
  const fine = await cms.diagnose(admin, "guides", { body: "[[snippet:steps]]\n\nCosts [[snippet:price]]." }, { slug: "g" });
  assert.ok(!fine.some((x) => x.code === "snippet_inline_multi"), "on its own line, or one paragraph: no warning");
});

test("small leftovers: list_templates needs read rights only; resolveRedirect and seoFor(doc) are there", async () => {
  const { cms } = setup({ redirects: true });
  const reader: Actor = { kind: "key", id: "k", label: "reader", scopes: ["read"], collections: null };
  const t = toolsFor(cms.core, reader).find((x) => x.name === "list_templates");
  assert.ok(t, "a reader gets the tool");
  const list = (await t!.run(cms.core, reader, { collection: "guides" })) as { templates: unknown[] };
  assert.ok(Array.isArray(list.templates));
  await rejects(cms.core.templates(anon, "guides"), "unauthorized");
  assert.equal(typeof cms.core.resolveRedirect, "function");
});
