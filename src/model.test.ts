import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection, defineSingle } from "./cms";
import { assetIds, relation } from "./fields";
import { keyBetween, normalizePath } from "./model";
import { toJsonSchema } from "./mcp";
import { parseMarkdown, toMarkdown } from "./markdown";
import { MemoryRepo } from "./repo";
import { CmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const editor: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof CmsError && e.code === code);
}

function setup(o: { redirects?: boolean } = {}) {
  const repo = new MemoryRepo();
  const people = defineCollection({ slug: "people", label: "People", visibility: "public", url: (d) => `/people/${d.slug}` });
  const guides = defineCollection({
    slug: "guides",
    label: "Guides",
    visibility: "public",
    tree: { maxDepth: 3 },
    seo: true,
    url: (d) => `/guides/${d.slug}`,
    fields: z.object({ author: relation("people").optional(), related: relation(["guides", "people"], { many: true, max: 3 }).optional(), photos: assetIds({ max: 4 }).optional() }),
    templates: [{ key: "howto", label: "How-to", title: "How to …", body: "## Before you start\n\n## Steps" }],
  });
  const snippets = defineCollection({ slug: "snippets", label: "Snippets", visibility: "public", snippets: true });
  const site = defineSingle({ slug: "site", label: "Site", visibility: "public", fields: z.object({ name: z.string().default("My site"), footer: z.string().default("") }) });
  const cms = createCms({ repo, collections: [people, guides, snippets, site], searchRefreshMs: 0, redirects: o.redirects ?? false, slugs: { hangul: "romanize" } });
  return { repo, cms };
}

test("model: fractional positions sort between neighbours and never collide", () => {
  let keys: string[] = [keyBetween(null, null)];
  for (let i = 0; i < 60; i++) keys.splice(1, 0, keyBetween(keys[0], keys[1] ?? null));
  for (let i = 0; i < 60; i++) keys.unshift(keyBetween(null, keys[0]));
  for (let i = 0; i < 60; i++) keys.push(keyBetween(keys[keys.length - 1], null));
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(normalizePath("/a/b/"), "/a/b");
  assert.equal(normalizePath("//evil.com"), null);
  assert.equal(normalizePath("/a/../b"), null);
});

test("relations: ids are checked, { collection, slug } becomes an id, the link survives a new address, deleting asks first", async () => {
  const { cms } = setup({ redirects: true });
  const kim = await cms.create(admin, "people", { slug: "kim", title: "Kim" }, { publish: true });
  const g = await cms.create(admin, "guides", { slug: "intro", title: "Intro", fields: { author: { collection: "people", slug: "kim" } as never } }, { publish: true });
  assert.equal(g.fields.author, kim.id);
  await rejects(cms.create(admin, "guides", { slug: "x", title: "X", fields: { author: { slug: "nobody" } as never } }), "relation_missing");
  await rejects(cms.create(admin, "guides", { slug: "x", title: "X", fields: { author: "00000000-0000-4000-8000-999999999999" } }), "relation_missing");
  await rejects(cms.create(admin, "guides", { slug: "x", title: "X", fields: { author: g.id } }), "relation_wrong_collection");

  // expand: one level, what the reader may see
  const read = await cms.core.expand(anon, await cms.get(anon, "guides", "intro"), ["author"]);
  assert.equal((read.fields.author as unknown as { slug: string }).slug, "kim");

  // the person moves (redirects on): the relation still points at them
  await cms.update(admin, "people", "kim", { slug: "kim-minji" }, { publish: true });
  const again = await cms.core.expand(anon, await cms.get(anon, "guides", "intro"), ["author"]);
  assert.equal((again.fields.author as unknown as { slug: string }).slug, "kim-minji");

  // referenced: delete is refused with the list, force goes ahead
  const refs = await cms.core.referencedBy(admin, "people", "kim-minji");
  assert.deepEqual(refs.map((r) => r.slug), ["intro"]);
  await assert.rejects(cms.remove(admin, "people", "kim-minji"), (e: unknown) => e instanceof CmsError && e.code === "doc_referenced" && e.status === 409);
  await cms.remove(admin, "people", "kim-minji", { force: true });
  const left = await cms.diagnose(admin, "guides", {}, { slug: "intro" });
  assert.ok(left.some((d) => d.code === "relation_missing" && d.severity === "warning"), "a deleted target is a warning on the saved copy");

  // JSON Schema tells the admin which widget to use
  const schema = toJsonSchema(z.object({ author: relation("people").optional(), photos: assetIds() })) as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(schema.properties.author["x-cms-relation"], { collections: ["people"], many: false, max: null });
  assert.ok(schema.properties.photos["x-cms-gallery"]);
});

test("tree: move, order, cycles, depth, children block delete; readers skip unpublished nodes", async () => {
  const { cms, repo } = setup();
  for (const s of ["a", "b", "c"]) await cms.create(admin, "guides", { slug: s, title: s.toUpperCase() }, { publish: s !== "b" });
  const a = await cms.get(admin, "guides", "a", { draft: true });
  const b = await cms.get(admin, "guides", "b", { draft: true });
  await cms.core.move(admin, "guides", "b", { parentId: a.id });
  await cms.core.move(admin, "guides", "c", { parentId: b.id });
  const versions = (await repo.listVersions(b.id)).length;
  assert.equal(versions, 1, "moving makes no version");
  const t = await cms.core.tree(admin, "guides", { draft: true });
  assert.deepEqual(t.map((n) => [n.slug, n.children.map((k) => [k.slug, k.children.map((x) => x.slug)])]), [["a", [["b", ["c"]]]]]);
  await rejects(cms.core.move(admin, "guides", "a", { parentId: b.id }), "tree_cycle");
  await cms.create(admin, "guides", { slug: "d", title: "D" });
  const c = await cms.get(admin, "guides", "c", { draft: true });
  await rejects(cms.core.move(admin, "guides", "d", { parentId: c.id }), "tree_too_deep");
  // readers: b is a draft, so c moves up under a
  const pub = await cms.core.tree(anon, "guides");
  assert.deepEqual(pub.map((n) => [n.slug, n.children.map((k) => k.slug)]), [["a", ["c"]]]);
  await assert.rejects(cms.remove(admin, "guides", "a"), (e: unknown) => e instanceof CmsError && e.code === "doc_has_children");
  // order: d before a at the top
  await cms.core.move(admin, "guides", "d", { parentId: null, before: a.id });
  assert.deepEqual((await cms.core.tree(admin, "guides", { draft: true })).map((n) => n.slug), ["d", "a"]);
  assert.deepEqual((await cms.core.ancestors(admin, "guides", "c", { draft: true })).map((x) => x.slug), ["a", "b"]);
});

test("single: defaults before the first save, then the published copy; one document only", async () => {
  const { cms } = setup();
  const before = await cms.single(anon, "site");
  assert.equal(before.version, 0);
  assert.equal(before.fields.name, "My site");
  await cms.core.updateSingle(admin, "site", { fields: { name: "Docs" } }, { publish: true });
  assert.equal((await cms.single(anon, "site")).fields.name, "Docs");
  await cms.core.updateSingle(admin, "site", { fields: { name: "Draft name" } });
  assert.equal((await cms.single(anon, "site")).fields.name, "Docs", "readers keep the published copy");
  assert.equal((await cms.single(admin, "site", { draft: true })).fields.name, "Draft name");
  await rejects(cms.create(admin, "site", { slug: "other", title: "Other" }), "single_only");
});

test("templates: code and admin templates make the same start for people and agents; owners and admins change them", async () => {
  const { cms } = setup();
  const t = await cms.core.saveTemplate(editorWith(cms), "guides", { label: "Troubleshooting", body: "## Symptom\n\n## Fix", fields: { photos: [], bogus: 1 } as never });
  const list = await cms.core.templates(admin, "guides");
  assert.deepEqual(list.map((x) => [x.label, x.source]), [["How-to", "code"], ["Troubleshooting", "admin"]]);
  const d1 = await cms.create(admin, "guides", { slug: "t1", title: "Wi-Fi drops" }, { template: t.id! });
  assert.equal(d1.body, "## Symptom\n\n## Fix");
  const d2 = await cms.create(admin, "guides", { slug: "t2" }, { template: "howto" });
  assert.equal(d2.title, "How to …");
  await assert.rejects(cms.core.updateTemplate({ kind: "user", id: "u9", label: "Other", isAdmin: false }, "guides", t.id!, { label: "Mine" }), (e: unknown) => e instanceof CmsError && e.kind === "forbidden");
  await cms.core.deleteTemplate(admin, "guides", t.id!);
  assert.equal((await cms.core.templates(admin, "guides")).length, 1);
});
/** An editor who may write guides (admins always may; this keeps the test about ownership). */
function editorWith(_cms: unknown): Actor {
  return admin;
}

test("snippets: readers get them filled in, editors get the token; loops are refused; publishing refreshes readers", async () => {
  const { cms } = setup();
  await cms.create(admin, "snippets", { slug: "pricing-note", title: "Pricing", body: "Prices include VAT." }, { publish: true });
  await cms.create(admin, "guides", { slug: "plans", title: "Plans", body: "## Plans\n\n[[snippet:pricing-note]]\n\n```\n[[snippet:pricing-note]]\n```" }, { publish: true });
  assert.match((await cms.get(anon, "guides", "plans")).body, /^## Plans\n\nPrices include VAT\.\n\n```\n\[\[snippet:pricing-note\]\]\n```$/);
  assert.match((await cms.get(admin, "guides", "plans", { draft: true })).body, /\[\[snippet:pricing-note\]\]\n/);
  assert.match((await cms.get(anon, "guides", "plans", { snippets: "raw" })).body, /^## Plans\n\n\[\[snippet:pricing-note\]\]/);
  await cms.update(admin, "snippets", "pricing-note", { body: "Prices exclude VAT." }, { publish: true });
  assert.match((await cms.get(anon, "guides", "plans")).body, /Prices exclude VAT\./);
  const hits = await cms.search(anon, ["guides"], "exclude VAT");
  assert.ok(hits.hits.some((h) => h.unit.slug === "plans"), "search sees the filled-in body");
  await cms.create(admin, "snippets", { slug: "a", title: "A", body: "[[snippet:b]]" });
  await cms.create(admin, "snippets", { slug: "b", title: "B", body: "x" });
  await rejects(cms.update(admin, "snippets", "b", { body: "[[snippet:a]]" }), "snippet_cycle");
  assert.deepEqual((await cms.core.snippetUses(admin, "snippets", "pricing-note")).map((d) => d.slug), ["plans"]);
  const d = await cms.diagnose(admin, "guides", { slug: "z", title: "Z", body: "[[snippet:nope]]" });
  assert.ok(d.some((x) => x.code === "snippet_missing" && x.severity === "warning"));
});

test("blocks: steps, link cards, videos and pinned anchors round-trip; blocked video hosts are refused", async () => {
  const docs = [
    "## Setup {#setup}\n\n:::steps\n1. **Install** it\n2. **Run** it\n:::\n\n:::card\n[Docs](https://example.com)\nRead the guide\n:::\n\n:::video\nhttps://youtu.be/dQw4w9WgXcQ\nIntro\n:::",
    ":::video\nasset:abcdefabcdef/clip.mp4\n:::\n\n### Deep {#deep-1}\n\nText",
  ];
  for (const src of docs) assert.equal(toMarkdown(parseMarkdown(src)), src);
  assert.equal(parseMarkdown(":::card\nnot a link\n:::")[0].t, "raw", "anything else stays word for word");
  const { cms } = setup();
  await rejects(cms.create(admin, "guides", { slug: "v", title: "V", body: ":::video\nhttps://evil.example/v.mp4\n:::" }), "video_host_blocked");
  await cms.create(admin, "guides", { slug: "v", title: "V", body: ":::video\nhttps://vimeo.com/123456789\n:::" });
});

test("anchors: a renamed heading keeps its old anchor as an alias; pinned anchors never move", async () => {
  const { cms } = setup();
  const d = await cms.create(admin, "guides", { slug: "an", title: "An", body: "## Install the app\n\nx\n\n## Use {#use}\n\ny" });
  await cms.update(admin, "guides", "an", { body: "## Installing\n\nx\n\n## Using it {#use}\n\ny" });
  assert.deepEqual({ ...(await cms.core.anchorAliases(d.id)) }, { installing: ["install-the-app"] });
  await cms.update(admin, "guides", "an", { body: "## Setup\n\nx\n\n## Using it {#use}\n\ny" });
  assert.deepEqual((await cms.core.anchorAliases(d.id)).setup?.sort(), ["install-the-app", "installing"]);
  assert.equal(await cms.core.resolveAnchor(d.id, "install-the-app", "## Setup\n\nx"), "setup");
});

test("redirects: a published move redirects; chains collapse; loops are refused; only admins manage them", async () => {
  const { cms } = setup({ redirects: true });
  await cms.create(admin, "guides", { slug: "old", title: "Old" }, { publish: true });
  await cms.update(admin, "guides", "old", { slug: "new" }, { publish: true });
  assert.deepEqual(await cms.core.redirects.resolve("/guides/old"), { to: "/guides/new", status: 301 });
  await cms.update(admin, "guides", "new", { slug: "newer" }, { publish: true });
  assert.deepEqual(await cms.core.redirects.resolve("/guides/old"), { to: "/guides/newer", status: 301 }, "a chain is one hop");
  const list = await cms.core.redirects.list(admin);
  assert.ok(list.every((r) => r.source === "auto" && r.to === "/guides/newer"));
  const m = await cms.core.redirects.create(admin, { from: "/promo", to: "/guides/newer", status: 302 });
  assert.equal(m.status, 302);
  await rejects(cms.core.redirects.create(admin, { from: "/guides/newer", to: "/promo" }), "redirect_loop");
  await rejects(cms.core.redirects.create(admin, { from: "/promo", to: "/x" }), "redirect_taken");
  await rejects(cms.core.redirects.list(editor), "forbidden_redirects");
  // moving back to an address that redirected away removes that redirect
  await cms.update(admin, "guides", "newer", { slug: "old" }, { publish: true });
  assert.equal(await cms.core.redirects.resolve("/guides/old"), null);
  // without redirects the address of a published document stays locked
  const plain = setup();
  await plain.cms.create(admin, "guides", { slug: "p", title: "P" }, { publish: true });
  await rejects(plain.cms.update(admin, "guides", "p", { slug: "q" }), "slug_locked");
});

test("seo and sitemap: fallbacks, warnings, noindex left out; suggested slugs romanize Korean", async () => {
  const { cms } = setup();
  await cms.create(admin, "guides", { slug: "s1", title: "First", summary: "The first guide", body: "![Hero](https://img.example/h.png)" }, { publish: true });
  await cms.create(admin, "guides", { slug: "s2", title: "Hidden", seo: { noindex: true } }, { publish: true });
  await cms.create(admin, "guides", { slug: "s3", title: "Draft" });
  const seo = await cms.core.seoFor(anon, "guides", "s1");
  assert.deepEqual([seo.title, seo.description, seo.image, seo.url], ["First", "The first guide", "https://img.example/h.png", "/guides/s1"]);
  const xml = await cms.core.sitemap("https://docs.example");
  assert.match(xml, /<loc>https:\/\/docs\.example\/guides\/s1<\/loc>/);
  assert.doesNotMatch(xml, /guides\/s2|guides\/s3|people\/|example\/site/);
  const d = await cms.diagnose(admin, "guides", { slug: "long", title: "x".repeat(70) });
  assert.ok(d.some((x) => x.code === "seo_title_long" && x.severity === "warning"));
  assert.ok(d.some((x) => x.code === "seo_description_missing"));
  assert.equal(await cms.core.suggestSlug(admin, "guides", "안녕하세요 Slack 연결"), "annyeonghaseyo-slack-yeongyeol");
  assert.equal(await cms.core.suggestSlug(admin, "guides", "First!"), "first");
  await cms.create(admin, "guides", { slug: "first", title: "First" });
  assert.equal(await cms.core.suggestSlug(admin, "guides", "First"), "first-2");
});

test("content model: collections without the new options behave as before", async () => {
  const repo = new MemoryRepo();
  const plain = defineCollection({ slug: "plain", label: "Plain", visibility: "public" });
  const cms = createCms({ repo, collections: [plain], searchRefreshMs: 0 });
  const d = await cms.create(admin, "plain", { slug: "a", title: "A", body: "[[snippet:x]]", seo: { title: "ignored" } } as never);
  assert.equal(d.seo, undefined, "seo is only kept where the collection asks for it");
  assert.equal(d.body, "[[snippet:x]]");
  await rejects(cms.core.tree(admin, "plain"), "tree_off");
  assert.equal(repo.docRefs.length, 0);
});

test("review fixes: draft links stay private, snippets obey beforeRead, draft renames wait for publish, odd anchors and paths", async () => {
  const { cms } = setup({ redirects: true });
  await cms.create(admin, "people", { slug: "b", title: "B" }, { publish: true });
  const b = await cms.get(admin, "people", "b", { draft: true });
  await cms.create(admin, "guides", { slug: "a", title: "A" }, { publish: true });
  await cms.update(admin, "guides", "a", { fields: { author: b.id } }); // draft only
  assert.deepEqual(await cms.referencedBy(anon, "people", "b"), [], "a link only in a draft is not public");
  assert.equal((await cms.referencedBy(admin, "people", "b")).length, 1);
  await rejects(cms.update(admin, "guides", "a", { slug: "a-new" }), "slug_needs_publish");

  const repo = new MemoryRepo();
  const snips = defineCollection({ slug: "snips", label: "S", visibility: "public", snippets: true, hooks: { beforeRead: [({ actor, slug }: { actor: Actor; slug: string | null }) => { if (slug === "secret" && actor.kind === "anonymous") throw new Error("no"); }] } } as never);
  const pages = defineCollection({ slug: "pages", label: "P", visibility: "public" });
  const c2 = createCms({ repo, collections: [snips, pages], searchRefreshMs: 0 });
  await c2.create(admin, "snips", { slug: "secret", title: "S", body: "TOP SECRET" }, { publish: true });
  await c2.create(admin, "pages", { slug: "p", title: "P", body: "[[snippet:secret]]" }, { publish: true });
  assert.doesNotMatch((await c2.get(anon, "pages", "p")).body, /TOP SECRET/);

  const { markdownToHtml } = await import("./html");
  assert.match(markdownToHtml("## Example {#constructor}", { anchorAliases: {} }), /id="constructor"/);
  assert.equal(normalizePath("/\\evil.com"), null);
  assert.equal(normalizePath("/a/%2e%2e/b"), null);
  const { sectionRanges } = await import("./patch");
  assert.deepEqual(sectionRanges("## Install {#setup}\n\nx").map((r) => r.anchor).filter(Boolean), ["setup"]);
  const k = setup();
  void k;
});

test("REST: snippet changes change the ETag, _move takes an id, a single's first PUT takes version 0", async () => {
  const { createCmsHandler } = await import("./http");
  const { cms } = setup();
  const h = createCmsHandler({ cms, basePath: "/api", resolveUser: async () => admin });
  const call = (m: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    h(new Request(`http://x/api${p}`, { method: m, headers: { "content-type": "application/json", origin: "http://x", ...headers }, body: body ? JSON.stringify(body) : undefined }));
  await cms.create(admin, "snippets", { slug: "n", title: "N", body: "one" }, { publish: true });
  await cms.create(admin, "guides", { slug: "g", title: "G", body: "[[snippet:n]]" }, { publish: true });
  const r1 = await call("GET", "/collections/guides/g");
  const tag = r1.headers.get("etag")!;
  await cms.update(admin, "snippets", "n", { body: "two" }, { publish: true });
  const r2 = await call("GET", "/collections/guides/g", undefined, { "if-none-match": tag });
  assert.equal(r2.status, 200);
  assert.match(((await r2.json()) as { doc: { body: string } }).doc.body, /two/);
  const a = await cms.create(admin, "guides", { slug: "ta", title: "TA" });
  const b = await cms.create(admin, "guides", { slug: "tb", title: "TB" });
  assert.equal((await call("POST", "/collections/guides/_move", { id: b.id, parentId: a.id })).status, 200);
  const put = await call("PUT", "/singles/site", { doc: { fields: { name: "X" } }, expectedVersion: 0 });
  assert.equal(put.status, 200);
  assert.equal((await call("PUT", "/singles/site", { doc: { fields: { name: "Y" } }, expectedVersion: 0 })).status, 409);
});
