/** 0.22.0: multilingual documents (locales, translations, status, fallback reads, search, sitemap, tools, REST). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { translatableFields } from "./locale";
import { MemoryRepo } from "./repo";
import { callTool, toolsFor } from "./tools";
import type { Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const anon: Actor = { kind: "anonymous" };

const fields = z.object({
  subtitle: z.string().optional(),
  order: z.number().int().optional(),
  tags: z.array(z.string()).default([]),
  level: z.enum(["basic", "advanced"]).optional(),
  link: z.string().url().optional(),
  note: z.string().optional(),
  extra: z.string().optional(),
});
const guide = defineCollection({
  slug: "guide",
  label: "Guide",
  visibility: "public",
  localized: true,
  url: (d) => `/${d.locale}/guide/${d.slug}`,
  fields,
  admin: { fields: { note: { localized: false }, level: { widget: "select" } } },
});
const blog = defineCollection({ slug: "blog", label: "Blog", visibility: "public", url: (d) => `/blog/${d.slug}` });

function setup() {
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide, blog], locales: ["ko", "en", "ja"], defaultLocale: "ko", searchRefreshMs: 0, warn: () => {} });
  return { cms, repo };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isCmsError(e)) return e.code;
    throw e;
  }
  return "no error";
}

test("locales: an app without locales is unchanged (no locale on documents, no translation tools); localized needs locales", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [blog], warn: () => {} });
  const d = await cms.create(admin, "blog", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  assert.equal("locale" in d, false);
  assert.equal("groupId" in (await cms.get(anon, "blog", "a")), false);
  assert.deepEqual(cms.locales, []);
  assert.equal(cms.localized("blog"), false);
  assert.equal(toolsFor(cms, admin).some((t) => t.name === "list_translations"), false);
  assert.equal(await code(cms.get(anon, "blog", "a", { locale: "en" })), "locale_unknown");
  assert.throws(() => createCms({ repo: new MemoryRepo(), collections: [guide] }), /localized/);
  assert.throws(() => createCms({ repo: new MemoryRepo(), collections: [blog], locales: ["ko"], defaultLocale: "en" }), /defaultLocale/);
  // Collections that are not translated take the default language and refuse another on write.
  const { cms: on } = setup();
  await on.create(admin, "blog", { slug: "b", title: "B", body: "x\n" }, { publish: true });
  assert.equal((await on.get(anon, "blog", "b", { locale: "ko" })).slug, "b");
  assert.equal(await code(on.create(admin, "blog", { slug: "b", title: "B" }, { locale: "en" })), "locale_not_localized");
});

test("locales: which fields are translated", () => {
  assert.deepEqual(translatableFields(guide), { subtitle: true, order: false, tags: true, level: false, link: false, note: false, extra: true });
});

test("locales: a translation starts from the source, shares what is not text, and refuses shared values", async () => {
  const { cms } = setup();
  const src = await cms.create(admin, "guide", { slug: "start", title: "시작하기", summary: "요약", body: "## 설치\n\n설치함.\n", fields: { subtitle: "부제", order: 3, tags: ["설치"], level: "basic", note: "공유" } }, { publish: true });
  assert.equal(src.locale, "ko");
  const en = await cms.create(admin, "guide", { slug: "start", title: "Getting started" }, { locale: "en" });
  assert.deepEqual([en.locale, en.groupId, en.sourceVersion, en.slug, en.status, en.version], ["en", src.id, 1, "start", "draft", 1]);
  assert.equal(en.body, "## 설치\n\n설치함.\n", "text starts as a copy of the source");
  assert.equal(en.title, "Getting started");
  // Shared fields come from the source on read, also after the source changes.
  await cms.update(admin, "guide", "start", { fields: { order: 5 } }, { publish: true });
  const draft = await cms.get(admin, "guide", "start", { locale: "en", draft: true });
  assert.deepEqual([draft.fields.order, draft.fields.level, draft.fields.note, draft.fields.subtitle], [5, "basic", "공유", "부제"]);
  // Writes to a translation: its own text yes, shared values no.
  const t2 = await cms.update(admin, "guide", "start", { body: "## Install\n\nInstalled.\n", fields: { subtitle: "Subtitle" } }, { locale: "en" });
  assert.deepEqual([t2.version, t2.fields.subtitle], [2, "Subtitle"]);
  assert.equal(await code(cms.update(admin, "guide", "start", { fields: { order: 9 } }, { locale: "en" })), "locale_field_shared");
  assert.equal(await code(cms.update(admin, "guide", "start", { fields: { note: "other" } }, { locale: "en" })), "locale_field_shared");
  assert.equal(await code(cms.update(admin, "guide", "start", { category: "x" }, { locale: "en" })), "locale_field_shared");
  assert.equal(await code(cms.update(admin, "guide", "start", { slug: "begin" }, { locale: "en" })), "locale_field_shared");
  // Sending the same shared value is fine (a form sends the whole document).
  assert.equal((await cms.update(admin, "guide", "start", { title: "Start", fields: { order: 5 } }, { locale: "en" })).version, 3);
  assert.equal(await code(cms.create(admin, "guide", { slug: "start", fields: { order: 1 } }, { locale: "ja" })), "locale_field_shared");
  // The source document is untouched by its translation.
  const ko = await cms.get(admin, "guide", "start", { draft: true });
  assert.deepEqual([ko.title, ko.body, ko.version], ["시작하기", "## 설치\n\n설치함.\n", 2]);
  // Errors that teach.
  assert.equal(await code(cms.create(admin, "guide", { slug: "start" }, { locale: "en" })), "translation_exists");
  assert.equal(await code(cms.create(admin, "guide", { slug: "nope" }, { locale: "en" })), "locale_source_missing");
  assert.equal(await code(cms.create(admin, "guide", { slug: "start" }, { locale: "fr" })), "locale_unknown");
  assert.equal(await code(cms.update(admin, "guide", "start", { title: "x" }, { locale: "ja" })), "not_found");
  // Each language has its own versions and publish state.
  assert.equal((await cms.versions(admin, "guide", cms.address("guide", "start", "en"))).length, 3);
  await cms.publish(admin, "guide", cms.address("guide", "start", "en"));
  assert.equal((await cms.get(anon, "guide", "start", { locale: "en" })).title, "Start");
  // Lists are per language.
  assert.deepEqual((await cms.list(anon, "guide")).map((d) => [d.slug, d.locale]), [["start", "ko"]]);
  assert.deepEqual((await cms.list(anon, "guide", { locale: "en" })).map((d) => [d.slug, d.locale, d.fields.order]), [["start", "en", 5]]);
  assert.deepEqual((await cms.page(admin, "guide", { locale: "en" })).docs.map((d) => [d.slug, d.locale]), [["start", "en"]]);
  // Deleting the source takes its translations to the trash.
  await cms.remove(admin, "guide", "start");
  assert.equal(await code(cms.get(admin, "guide", "start", { locale: "en", draft: true })), "not_found");
  // Renaming a source (a draft: published slugs are locked) moves its translations.
  await cms.create(admin, "guide", { slug: "draft", title: "초안", body: "x\n" });
  await cms.create(admin, "guide", { slug: "draft", title: "Draft" }, { locale: "en" });
  await cms.update(admin, "guide", "draft", { slug: "renamed" });
  assert.equal((await cms.get(admin, "guide", "renamed", { locale: "en", draft: true })).title, "Draft");
  assert.equal(await code(cms.get(admin, "guide", "draft", { locale: "en", draft: true })), "not_found");
});

test("locales: status per language (source, missing, outdated, current), the source diff and aligning", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "s", title: "원문", body: "## 하나\n\n첫 문단.\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "s", title: "Source" }, { locale: "en", publish: true });
  const st = async () => Object.fromEntries((await cms.translations(admin, "guide", "s")).translations.map((t) => [t.locale, t.status]));
  assert.deepEqual(await st(), { ko: "source", en: "current", ja: "missing" });
  // A draft of the source does not make translations outdated; publishing it does.
  await cms.update(admin, "guide", "s", { body: "## 하나\n\n고친 문단.\n" });
  assert.equal((await st()).en, "current");
  await cms.publish(admin, "guide", "s");
  assert.deepEqual(await st(), { ko: "source", en: "outdated", ja: "missing" });
  const list = await cms.translations(admin, "guide", "s");
  assert.equal(list.translations.find((t) => t.locale === "en")!.sourceVersion, 1);
  assert.equal(list.sourceVersion, 2);
  const d = await cms.sourceDiff(admin, "guide", "s", "en");
  assert.deepEqual([d.a, d.b, d.status], [1, 2, "outdated"]);
  assert.match(JSON.stringify(d.hunks), /고친 문단/);
  assert.equal(await code(cms.sourceDiff(admin, "guide", "s", "ko")), "locale_is_source");
  assert.equal(await code(cms.sourceDiff(admin, "guide", "s", "ja")), "translation_not_found");
  // "v2 기준으로 맞춤": no new version, the status becomes current.
  const aligned = await cms.markAligned(admin, "guide", "s", "en");
  assert.deepEqual([aligned.sourceVersion, aligned.version], [2, 1]);
  assert.deepEqual(await st(), { ko: "source", en: "current", ja: "missing" });
  assert.deepEqual((await cms.sourceDiff(admin, "guide", "s", "en")).hunks, []);
  assert.equal(await code(cms.markAligned(admin, "guide", "s", "en", { version: 9 })), "version_not_found");
  assert.equal(await code(cms.translations(admin, "blog", "s")), "locale_not_localized");
  assert.equal(await code(cms.translations(anon, "guide", "s")), "unauthorized");
});

test("locales: fallback reads serve the default language and say which was asked for", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "f", title: "한국어", body: "본문\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "f", title: "English draft" }, { locale: "en" });
  assert.equal(await code(cms.get(anon, "guide", "f", { locale: "en" })), "not_found");
  const fb = await cms.get(anon, "guide", "f", { locale: "en", fallback: true });
  assert.deepEqual([fb.title, fb.locale, fb.requestedLocale], ["한국어", "ko", "en"]);
  const ja = await cms.get(anon, "guide", "f", { locale: "ja", fallback: true });
  assert.deepEqual([ja.locale, ja.requestedLocale], ["ko", "ja"]);
  const own = await cms.get(anon, "guide", "f", { locale: "ko", fallback: true });
  assert.equal(own.requestedLocale, undefined);
  // Lists too.
  assert.equal((await cms.list(anon, "guide", { locale: "en" })).length, 0);
  assert.deepEqual((await cms.list(anon, "guide", { locale: "en", fallback: true })).map((d) => [d.slug, d.locale, d.requestedLocale]), [["f", "ko", "en"]]);
  await cms.publish(admin, "guide", "f@en");
  assert.deepEqual((await cms.list(anon, "guide", { locale: "en", fallback: true })).map((d) => [d.slug, d.locale, d.requestedLocale]), [["f", "en", undefined]]);
});

test("locales: one slug per language in the repo", async () => {
  const repo = new MemoryRepo();
  const base = { collection: "guide", title: "x", summary: "", body: "", category: null, keywords: [], fields: {}, status: "draft" as const, version: 1, publishedVersion: null, published: null, publishedAt: null, updatedBy: null, updatedByKind: null };
  const a = await repo.insertDoc({ ...base, slug: "same", locale: "ko" } as never);
  await repo.insertDoc({ ...base, slug: "same", locale: "en", groupId: a.id } as never);
  await assert.rejects(repo.insertDoc({ ...base, slug: "same", locale: "en", groupId: a.id } as never), /duplicate/);
  assert.equal((await repo.findDoc("guide", "same"))!.id, a.id, "without a locale: the source");
  assert.equal((await repo.findDoc("guide", "same", { locale: "en" }))!.locale, "en");
});

test("locales: search per language; Hangul 2-grams only for Korean", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "k", title: "설치 안내", body: "## 설치\n\n한국어 문서 검색 안내.\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "k", title: "Install guide", body: "## Install\n\nEnglish words. 한국어 keyword.\n" }, { locale: "en", publish: true });
  await cms.create(admin, "blog", { slug: "b", title: "Blog", body: "English words in the blog.\n" }, { publish: true });
  const hits = async (q: string, locale?: string) => [...new Set((await cms.search(anon, ["guide", "blog"], q, locale ? { locale } : {})).hits.map((h) => `${h.unit.collection}/${h.unit.slug}:${h.unit.locale ?? "-"}`))].sort();
  assert.deepEqual(await hits("검색"), ["guide/k:ko"], "default language");
  assert.deepEqual(await hits("English"), ["blog/b:-"], "the Korean guide has no English words; the blog is not translated");
  assert.deepEqual(await hits("English", "en"), ["blog/b:-", "guide/k:en"]);
  // "국어" is a 2-gram of "한국어": found in Korean text, not in the English translation.
  assert.deepEqual(await hits("국어", "ko"), ["guide/k:ko"]);
  assert.deepEqual(await hits("국어", "en"), []);
  assert.deepEqual(await hits("한국어", "en"), ["guide/k:en"], "whole words still match");
  assert.equal(await code(cms.search(anon, ["guide"], "x", { locale: "fr" })), "locale_unknown");
});

test("locales: sitemap names every language of a document with hreflang", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "m", title: "맵", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "m", title: "Map" }, { locale: "en", publish: true });
  await cms.create(admin, "guide", { slug: "m", title: "Map ja" }, { locale: "ja" }); // a draft: left out
  await cms.create(admin, "guide", { slug: "solo", title: "혼자", body: "x\n" }, { publish: true });
  const xml = await cms.sitemap("https://docs.example");
  assert.match(xml, /xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml"/);
  assert.match(xml, /<loc>https:\/\/docs.example\/en\/guide\/m<\/loc>/);
  assert.match(xml, /<loc>https:\/\/docs.example\/ko\/guide\/m<\/loc>/);
  assert.equal((xml.match(/hreflang="en" href="https:\/\/docs.example\/en\/guide\/m"/g) ?? []).length, 2, "both entries name the English page");
  assert.equal((xml.match(/hreflang="x-default" href="https:\/\/docs.example\/ko\/guide\/m"/g) ?? []).length, 2);
  assert.doesNotMatch(xml, /\/ja\//);
  assert.match(xml, /<loc>https:\/\/docs.example\/ko\/guide\/solo<\/loc><lastmod>[\d-]+<\/lastmod><\/url>/, "a document with one language has no alternates");
});

test("locales: events, the change log and the audit log say the language", async () => {
  const { cms, repo } = setup();
  const seen: { event: string; slug: string | null; locale?: string; url: string | null }[] = [];
  const stop = cms.subscribe((e) => void seen.push({ event: e.event, slug: e.slug, locale: e.locale, url: e.url }));
  await cms.create(admin, "guide", { slug: "e", title: "이벤트", body: "x\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "e", title: "Event" }, { locale: "en", publish: true });
  await new Promise((r) => setTimeout(r, 50));
  stop();
  const en = seen.filter((e) => e.locale === "en");
  assert.ok(en.length >= 1, JSON.stringify(seen));
  assert.ok(en.every((e) => e.slug === "e" && e.url === "/en/guide/e"), JSON.stringify(en));
  assert.ok(seen.some((e) => e.locale === "ko" && e.url === "/ko/guide/e"), JSON.stringify(seen));
  const audit = await repo.listAudit({ limit: 50 } as never);
  const tr = audit.find((a) => a.action === "doc.translate");
  assert.ok(tr);
  assert.deepEqual([tr!.slug, (tr!.detail as { locale?: string }).locale], ["e", "en"]);
});

test("locales: agent tools take locale; list_translations lists the languages", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "t", title: "도구", body: "## 하나\n\n본문.\n" }, { publish: true });
  assert.ok(toolsFor(cms, admin).some((t) => t.name === "list_translations"));
  const made = (await callTool(cms, admin, "create_document", { collection: "guide", doc: { slug: "t", title: "Tools" }, locale: "en" })) as { locale: string; version: number };
  assert.deepEqual([made.locale, made.version], ["en", 1]);
  const got = (await callTool(cms, admin, "get_document", { collection: "guide", slug: "t", draft: true, locale: "en" })) as { title: string; locale: string };
  assert.deepEqual([got.title, got.locale], ["Tools", "en"]);
  await callTool(cms, admin, "update_document", { collection: "guide", slug: "t", locale: "en", doc: { summary: "Agent tools" }, expectedVersion: 1 });
  const shared = (await callTool(cms, admin, "update_document", { collection: "guide", slug: "t", locale: "en", doc: { fields: { order: 1 } } })) as { error?: string; message?: string };
  assert.deepEqual([shared.error, shared.message], ["locale_field_shared", "fields.order is shared by every language: change it in the ko document"]);
  await callTool(cms, admin, "publish_document", { collection: "guide", slug: "t", locale: "en" });
  const read = await callTool(cms, admin, "read_document", { collection: "guide", slug: "t", locale: "en" });
  assert.match(JSON.stringify(read), /Agent tools/);
  const list = (await callTool(cms, admin, "list_translations", { collection: "guide", slug: "t" })) as { translations: { locale: string; status: string; version: number | null }[] };
  assert.deepEqual(list.translations.map((t) => [t.locale, t.status, t.version]), [["ko", "source", 1], ["en", "current", 2], ["ja", "missing", null]]);
  const docs = (await callTool(cms, anon, "list_documents", { collection: "guide", locale: "en" })) as { slug: string; locale: string }[];
  assert.deepEqual(docs.map((d) => [d.slug, d.locale]), [["t", "en"]]);
  const cols = (await callTool(cms, admin, "list_collections", {})) as { slug: string; localized?: boolean; sharedFields?: string[] }[];
  assert.deepEqual(cols.find((c) => c.slug === "guide")!.sharedFields, ["order", "level", "link", "note"]);
  const ws = (await callTool(cms, admin, "write_document", { collection: "guide", slug: "t", locale: "ja", content: "---\ntitle: x\n---\nx\n" })) as { error?: string };
  assert.equal(ws.error, "translation_not_found");
});

test("locales: REST routes (?locale=, _translations, _align, _source-diff); the ETag differs per language", async () => {
  const { cms } = setup();
  const handler = createCmsHandler({ cms, resolveUser: async () => admin as Extract<Actor, { kind: "user" }> });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(new Request(`http://localhost/api/cms${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, etag: res.headers.get("etag"), json: res.status === 304 ? null : ((await res.json()) as Record<string, unknown>) };
  };
  await cms.create(admin, "guide", { slug: "r", title: "레스트", body: "x\n" }, { publish: true });
  const started = await call("POST", "/collections/guide/r/_translations", { locale: "en", doc: { title: "Rest" }, publish: true });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.equal((started.json!.doc as { locale: string }).locale, "en");
  const ko = await call("GET", "/collections/guide/r");
  const en = await call("GET", "/collections/guide/r?locale=en");
  assert.deepEqual([(ko.json!.doc as { title: string }).title, (en.json!.doc as { title: string }).title], ["레스트", "Rest"]);
  assert.equal(ko.etag, '"v1-ko"');
  assert.equal(en.etag, '"v1-en"');
  assert.equal((await call("GET", "/collections/guide/r?locale=en", undefined, { "if-none-match": en.etag! })).status, 304);
  assert.equal((await call("GET", "/collections/guide/r?locale=en", undefined, { "if-none-match": ko.etag! })).status, 200);
  const patched = await call("PATCH", "/collections/guide/r?locale=en", { doc: { summary: "S" } }, { "if-match": en.etag! });
  assert.deepEqual([patched.status, patched.etag], [200, '"v2-en"'], JSON.stringify(patched.json));
  const fb = await call("GET", "/collections/guide/r?locale=ja&fallback=1");
  assert.deepEqual([(fb.json!.doc as { locale: string }).locale, (fb.json!.doc as { requestedLocale: string }).requestedLocale], ["ko", "ja"]);
  await cms.update(admin, "guide", "r", { body: "y\n" }, { publish: true });
  const list = await call("GET", "/collections/guide/r/_translations");
  assert.deepEqual((list.json!.translations as { locale: string; status: string }[]).map((t) => t.status), ["source", "outdated", "missing"]);
  const diff = await call("GET", "/collections/guide/r/_source-diff?locale=en");
  assert.deepEqual([diff.json!.a, diff.json!.b], [1, 2]);
  const al = await call("POST", "/collections/guide/r/_align", { locale: "en" });
  assert.equal((al.json!.doc as { sourceVersion: number }).sourceVersion, 2);
  const shared = await call("PATCH", "/collections/guide/r?locale=en", { doc: { fields: { order: 2 } } });
  assert.deepEqual([shared.status, shared.json!.error], [422, "locale_field_shared"]);
  const schema = await call("GET", "/collections/guide/_schema");
  assert.deepEqual([schema.json!.localized, schema.json!.defaultLocale, (schema.json!.translatable as Record<string, boolean>).order], [true, "ko", false]);
  const me = await call("GET", "/_me");
  assert.deepEqual([me.json!.locales, me.json!.defaultLocale], [["ko", "en", "ja"], "ko"]);
  assert.equal((me.json!.collections as { slug: string; localized?: boolean }[]).find((c) => c.slug === "guide")!.localized, true);
  const search = await call("GET", "/search?q=Rest&locale=en");
  assert.deepEqual((search.json!.hits as { slug: string; locale: string }[]).map((h) => [h.slug, h.locale]), [["r", "en"]]);
  const unknown = await call("GET", "/collections/guide/r?locale=fr");
  assert.deepEqual([unknown.status, unknown.json!.error], [422, "locale_unknown"]);
});
