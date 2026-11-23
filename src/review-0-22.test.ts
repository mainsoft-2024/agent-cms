/** Review of 0.22.0 multilingual documents: findings fixed after the review (docs/roadmap/review-0-22.md, "다국어 서버"). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { relation } from "./fields";
import { localeTagMatches } from "./http";
import { MemoryRepo } from "./repo";
import { callTool } from "./tools";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const lee: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? e.code : String(e)));
const tick = () => new Promise((r) => setTimeout(r, 5));

const fields = z.object({ subtitle: z.string().optional(), secret: z.string().optional(), order: z.number().optional() });
// `secret` and `order` are shared (not text): a translation shows its source's values.
const sharedAdmin = { fields: { secret: { localized: false } } } as const;

function setup(o: { access?: Parameters<typeof defineCollection>[0]["access"]; fieldAccess?: Parameters<typeof defineCollection>[0]["fieldAccess"]; trash?: boolean; redirects?: boolean } = {}) {
  const repo = new MemoryRepo();
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", localized: true, categories: ["A", "B"], url: (d) => `/${d.locale}/guide/${d.slug}`, fields, admin: sharedAdmin, ...(o.access ? { access: o.access } : {}), ...(o.fieldAccess ? { fieldAccess: o.fieldAccess } : {}) });
  const posts = defineCollection({ slug: "posts", label: "Posts", visibility: "public", fields: z.object({ about: relation("guide").optional() }) });
  const cms = createCms({ repo, collections: [guide, posts], locales: ["ko", "en", "ja"], defaultLocale: "ko", searchRefreshMs: 0, warn: () => {}, ...(o.trash ? { trash: { days: 30 } } : {}), ...(o.redirects ? { redirects: true } : {}), automations: {} });
  return { cms, repo };
}

// ── P0 1: shared fields come from what the reader may see of the source ──

test("review 0.22: a draft source's shared fields never reach readers of a published translation (get, list, page, search, expand)", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "s", title: "원문", category: "A", body: "x\n", fields: { secret: "draft-only", order: 1 } });
  const en = await cms.create(admin, "guide", { slug: "s", title: "Translated", body: "hello world\n" }, { locale: "en", publish: true });
  const got = await cms.get(anon, "guide", "s", { locale: "en" });
  assert.equal(got.title, "Translated");
  assert.equal("secret" in got.fields, false, "no source copy for readers: no shared fields");
  assert.equal(got.category, null);
  const listed = (await cms.list(anon, "guide", { locale: "en" }))[0];
  assert.equal("secret" in listed.fields, false);
  assert.equal(JSON.stringify(await cms.page(anon, "guide", { locale: "en" })).includes("draft-only"), false);
  const hits = (await cms.search(anon, ["guide"], "hello", { locale: "en" })).hits;
  assert.ok(hits.length > 0);
  assert.equal(JSON.stringify(hits).includes("draft-only"), false);
  // A relation to the translation, expanded for a reader.
  await cms.create(admin, "posts", { slug: "p", title: "P", fields: { about: en.id } }, { publish: true });
  const expanded = await cms.core.expand(anon, await cms.get(anon, "posts", "p"), ["about"]);
  assert.equal(JSON.stringify(expanded).includes("draft-only"), false);
  // Editors still get the source's working copy.
  assert.equal((await cms.get(admin, "guide", "s", { locale: "en", draft: true })).fields.secret, "draft-only");
  // Once the source is published readers get its published values.
  await cms.publish(admin, "guide", "s");
  assert.equal((await cms.get(anon, "guide", "s", { locale: "en" })).fields.secret, "draft-only");
  await cms.update(admin, "guide", "s", { fields: { secret: "newer draft" } });
  assert.equal((await cms.get(anon, "guide", "s", { locale: "en" })).fields.secret, "draft-only", "the source's draft stays out");
});

test("review 0.22: a source denied by access.read or fieldAccess shares nothing hidden through a translation the reader may see", async () => {
  // access.read: anonymous readers may see English documents only.
  const { cms } = setup({ access: { read: ({ actor, doc }) => actor.kind === "user" || !doc || doc.locale === "en" } });
  await cms.create(admin, "guide", { slug: "s", title: "원문", category: "A", body: "x\n", fields: { secret: "s1", order: 7 } }, { publish: true });
  await cms.create(admin, "guide", { slug: "s", title: "English", body: "find me\n" }, { locale: "en", publish: true });
  assert.equal(await code(cms.get(anon, "guide", "s")), "unauthorized");
  const en = await cms.get(anon, "guide", "s", { locale: "en" });
  assert.deepEqual([en.title, "secret" in en.fields, "order" in en.fields, en.category], ["English", false, false, null]);
  assert.equal(JSON.stringify(await cms.list(anon, "guide", { locale: "en" })).includes("s1"), false);
  assert.equal(JSON.stringify((await cms.search(anon, ["guide"], "find", { locale: "en" })).hits).includes("s1"), false);
  assert.equal((await cms.get(lee, "guide", "s", { locale: "en" })).fields.secret, "s1", "a reader allowed on the source gets it");

  // fieldAccess: `secret` is hidden from anonymous readers on the source, allowed on the translation.
  const two = setup({ fieldAccess: { secret: { read: ({ actor, doc }) => actor.kind === "user" || doc?.locale === "en" } } });
  await two.cms.create(admin, "guide", { slug: "f", title: "원문", body: "x\n", fields: { secret: "s2", order: 3 } }, { publish: true });
  await two.cms.create(admin, "guide", { slug: "f", title: "English", body: "field rules\n" }, { locale: "en", publish: true });
  const f = await two.cms.get(anon, "guide", "f", { locale: "en" });
  assert.deepEqual(["secret" in f.fields, f.fields.order], [false, 3]);
  assert.equal(JSON.stringify(await two.cms.list(anon, "guide", { locale: "en" })).includes("s2"), false);
  assert.equal(JSON.stringify((await two.cms.search(anon, ["guide"], "rules", { locale: "en" })).hits).includes("s2"), false);
});

// ── P0 2: automations act on the document the event is about ──

test("review 0.22: an automation on publish acts on the English translation only", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "a", title: "원문", body: "x\n" }, { publish: true });
  await tick();
  await cms.cron();
  const auto = await cms.automations.create(admin, { name: "Tag", trigger: { event: "doc.published", collection: "guide" }, actions: [{ type: "add_keyword", name: "tagged" }] });
  await cms.create(admin, "guide", { slug: "a", title: "Source" }, { locale: "en", publish: true });
  await tick();
  await cms.cron();
  const runs = await cms.automations.runs(admin, auto.id);
  assert.deepEqual(runs.map((r) => r.state), ["ok"]);
  assert.deepEqual((await cms.get(admin, "guide", "a", { locale: "en", draft: true })).keywords, ["tagged"]);
  assert.deepEqual((await cms.get(admin, "guide", "a", { draft: true })).keywords, [], "the source is untouched");
});

// ── P0 3: a trash cascade checks every translation first and is all or nothing ──

test("review 0.22: deleting a source is refused when one translation may not be deleted; nothing changes", async () => {
  const { cms } = setup({
    trash: true,
    access: { write: ({ actor }) => actor.kind === "user", publish: ({ actor, doc }) => actor.kind === "user" && (actor.isAdmin || doc?.locale !== "ja") },
  });
  await cms.create(admin, "guide", { slug: "d", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "d", title: "English" }, { locale: "en" });
  await cms.create(admin, "guide", { slug: "d", title: "日本語" }, { locale: "ja" });
  assert.equal(await code(cms.remove(lee, "guide", "d")), "forbidden_publish");
  assert.equal((await cms.trash.list(admin)).items.length, 0, "nothing went to the trash");
  assert.equal((await cms.get(admin, "guide", "d", { locale: "en", draft: true })).title, "English");

  // A `beforeDelete` hook that refuses one translation stops the whole delete too.
  await cms.remove(admin, "guide", "d");
  const src = (await cms.trash.list(admin)).items.find((i) => !i.locale)!;
  // Restoring: Lee may not restore the Japanese translation, so the source does not come back either.
  assert.equal(await code(cms.trash.restore(lee, [{ kind: "document", id: src.id }])), "forbidden_publish");
  assert.equal((await cms.trash.list(admin)).items.length, 3);
});

test("review 0.22: restoring a source with its translations is all or nothing (a failed write restores none)", async () => {
  const { cms, repo } = setup({ trash: true });
  await cms.create(admin, "guide", { slug: "r", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "r", title: "English" }, { locale: "en" });
  await cms.create(admin, "guide", { slug: "r", title: "日本語" }, { locale: "ja" });
  await cms.remove(admin, "guide", "r");
  const src = (await cms.trash.list(admin)).items.find((i) => !i.locale)!;
  const orig = repo.updateDoc.bind(repo);
  let n = 0;
  repo.updateDoc = async (id, patch) => {
    if ("deletedAt" in patch && patch.deletedAt === null && ++n === 2) throw new Error("disk full");
    return orig(id, patch);
  };
  await assert.rejects(cms.trash.restore(admin, [{ kind: "document", id: src.id }]), /disk full/);
  repo.updateDoc = orig;
  assert.equal((await cms.trash.list(admin)).items.length, 3, "nobody came back");
  await cms.trash.restore(admin, [{ kind: "document", id: src.id }]);
  assert.equal((await cms.trash.list(admin)).items.length, 0);
});

test("review 0.22: a beforeDelete hook refusing a translation stops deleting its source", async () => {
  const repo = new MemoryRepo();
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", localized: true, url: (d) => `/${d.locale}/guide/${d.slug}`, hooks: { beforeDelete: [(d) => { if (d.content.title === "English") throw new Error("keep English"); }] } });
  const cms = createCms({ repo, collections: [guide], locales: ["ko", "en"], defaultLocale: "ko", warn: () => {}, trash: { days: 30 } });
  await cms.create(admin, "guide", { slug: "h", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "h", title: "English" }, { locale: "en" });
  await assert.rejects(cms.remove(admin, "guide", "h"));
  assert.equal((await cms.get(admin, "guide", "h", { draft: true })).title, "원문");
  assert.equal((await cms.trash.list(admin)).items.length, 0);
});

// ── P1 4: renaming the source moves what readers, search and redirects see of its translations ──

test("review 0.22: renaming a source moves its published translations' public copies, search hits and redirects", async () => {
  const { cms } = setup({ redirects: true });
  await cms.create(admin, "guide", { slug: "old", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "old", title: "English", body: "renamed page\n" }, { locale: "en", publish: true });
  await cms.update(admin, "guide", "old", { slug: "new" }, { publish: true });
  const en = await cms.get(anon, "guide", "new", { locale: "en" });
  assert.deepEqual([en.slug, en.published?.slug ?? en.slug], ["new", "new"]);
  assert.equal((await cms.list(anon, "guide", { locale: "en" }))[0].slug, "new");
  const hits = (await cms.search(anon, ["guide"], "renamed", { locale: "en" })).hits;
  assert.deepEqual([...new Set(hits.map((h) => h.unit.slug))], ["new"]);
  const xml = await cms.sitemap("https://x.example");
  assert.match(xml, /\/en\/guide\/new/);
  assert.doesNotMatch(xml, /\/guide\/old/);
  assert.deepEqual(await cms.redirects.resolve("/en/guide/old"), { to: "/en/guide/new", status: 301 });
  assert.deepEqual(await cms.redirects.resolve("/ko/guide/old"), { to: "/ko/guide/new", status: 301 });
});

// ── P1 5: If-Match names the language ──

test("review 0.22: If-Match tags of another language are refused; bare numbers are accepted", () => {
  const all = ["ko", "en", "zhhant"];
  assert.equal(localeTagMatches('"v3-en"', "en", all, true), true);
  assert.equal(localeTagMatches('W/"v3-en-abc12"', "en", all, true), true);
  assert.equal(localeTagMatches('"v3-ko"', "en", all, true), false);
  assert.equal(localeTagMatches('"v3"', "en", all, true), false, "a tag without a language is a source's");
  assert.equal(localeTagMatches('"v3"', "ko", all, false), true);
  assert.equal(localeTagMatches('"v3-en"', "ko", all, false), false);
  assert.equal(localeTagMatches("3", "en", all, true), true);
  assert.equal(localeTagMatches(null, "en", all, true), true);
});

test("review 0.22: a source-only change to a shared field gives the translation a new ETag (200, not 304); a source tag cannot write the translation", async () => {
  const { cms } = setup();
  const { createCmsHandler } = await import("./http");
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await handler(new Request(`http://localhost/api/cms${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, etag: res.headers.get("etag"), json: res.status === 304 ? null : ((await res.json()) as Record<string, unknown>) };
  };
  await cms.create(admin, "guide", { slug: "e", title: "원문", body: "x\n", fields: { order: 1 } }, { publish: true });
  await cms.create(admin, "guide", { slug: "e", title: "English" }, { locale: "en", publish: true });
  const first = await call("GET", "/collections/guide/e?locale=en");
  assert.equal((await call("GET", "/collections/guide/e?locale=en", { "if-none-match": first.etag! })).status, 304);
  await cms.update(admin, "guide", "e", { fields: { order: 2 } }, { publish: true });
  const after = await call("GET", "/collections/guide/e?locale=en", { "if-none-match": first.etag! });
  assert.equal(after.status, 200);
  assert.equal(((after.json!.doc as { fields: { order: number } }).fields.order), 2);
  // The source is at v2 and the translation at v1: "v1-ko" names the source, not the translation.
  await cms.update(admin, "guide", "e@en", { title: "English 2" });
  const wrong = await call("PATCH", "/collections/guide/e?locale=en", { "if-match": '"v2-ko"' }, { doc: { title: "x" } });
  assert.deepEqual([wrong.status, wrong.json!.error], [409, "locale_etag_mismatch"]);
});

// ── P1: bulk_documents and add_to_release take locale ──

test("review 0.22: bulk_documents and add_to_release with locale act on the translation; the source stays", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "b", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "b", title: "English" }, { locale: "en", publish: true });
  const r = (await callTool(cms, admin, "bulk_documents", { collection: "guide", action: "unpublish", slugs: ["b"], locale: "en" })) as { results: { slug: string; ok: boolean; locale?: string }[] };
  assert.deepEqual(r.results.map((x) => [x.slug, x.ok, x.locale]), [["b", true, "en"]]);
  assert.equal((await cms.get(admin, "guide", "b", { locale: "en", draft: true })).publishedVersion, null);
  assert.equal((await cms.get(admin, "guide", "b", { draft: true })).publishedVersion, 1, "the source is still published");

  const rel = await cms.releases.create(admin, { name: "R" });
  const added = (await callTool(cms, admin, "add_to_release", { id: rel.id, items: [{ collection: "guide", slug: "b", locale: "en" }] })) as { items: { slug: string; locale?: string }[] };
  assert.deepEqual(added.items.map((i) => [i.slug, i.locale]), [["b", "en"]]);
  const en = await cms.get(admin, "guide", "b", { locale: "en", draft: true });
  assert.deepEqual((await cms.releases.get(admin, rel.id)).items.map((i) => i.documentId), [en.id]);
});

// ── P2: list_translations for readers, `@` in slugs ──

test("review 0.22: list_translations gives readers only the published languages they may read, without draft details", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "t", title: "원문", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "t", title: "English" }, { locale: "en", publish: true });
  await cms.update(admin, "guide", "t@en", { title: "English 2" });
  await cms.create(admin, "guide", { slug: "t", title: "日本語 draft" }, { locale: "ja" });
  const r = (await callTool(cms, anon, "list_translations", { collection: "guide", slug: "t" })) as { translations: { locale: string; version: number | null; docStatus: string; sourceVersion: number | null }[] };
  assert.deepEqual(r.translations.map((t) => [t.locale, t.version, t.docStatus, t.sourceVersion]), [["ko", 1, "published", null], ["en", 1, "published", null]]);
  const full = (await callTool(cms, admin, "list_translations", { collection: "guide", slug: "t" })) as { translations: { locale: string; version: number | null }[] };
  assert.deepEqual(full.translations.map((t) => [t.locale, t.version]), [["ko", 1], ["en", 2], ["ja", 1]]);
});

test("review 0.22: with locales on a slug with @ is refused (it would read as a translation's address)", async () => {
  const repo = new MemoryRepo();
  const free = defineCollection({ slug: "free", label: "Free", visibility: "public", slugPattern: /^[a-z0-9@.-]+$/ } as never);
  const cms = createCms({ repo, collections: [free], locales: ["ko", "en"], defaultLocale: "ko", warn: () => {} });
  assert.equal(await code(cms.create(admin, "free", { slug: "me@en", title: "x" })), "invalid_slug");
  const off = createCms({ repo: new MemoryRepo(), collections: [free], warn: () => {} });
  assert.equal(await code(off.create(admin, "free", { slug: "me@en", title: "x" })), "ok", "without locales it is just a slug");
});

test("client: If-Match on a translation names its language, so its own saves are not refused", async () => {
  const { createRestClient } = await import("./client");
  const seen: string[] = [];
  const client = createRestClient({
    url: "http://x/api",
    fetch: async (input, init) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("if-match")}`);
      return new Response(JSON.stringify({ doc: {} }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await client.update("guide", "start@pt-BR", { summary: "x" }, { expectedVersion: 4 });
  await client.update("guide", "start", { summary: "x" }, { expectedVersion: 4 });
  assert.deepEqual(seen, ['http://x/api/collections/guide/start%40pt-BR "v4-ptbr"', 'http://x/api/collections/guide/start "v4"']);
});
