/** 0.21.0 review fixes: template projection, video assets in use, redirect chains, heading 4 ids, visits per day, tree moves, snippet tokens. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { MemoryRepo } from "./repo";
import { CMS_TOOLS } from "./tools";
import { CmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const writerKey: Actor = { kind: "key", id: "kw", label: "writer", scopes: ["write"], collections: null };
const readerKey: Actor = { kind: "key", id: "kr", label: "reader", scopes: ["read"], collections: null };

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof CmsError && e.code === code);
}

test("templates: a read-only caller gets names only; writers get the content without fields they may not read", async () => {
  const repo = new MemoryRepo();
  const guides = defineCollection({
    slug: "guides",
    label: "Guides",
    visibility: "public",
    fields: z.object({ cost: z.number().optional(), team: z.string().optional() }),
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
    templates: [{ key: "howto", label: "How-to", description: "Steps", body: "## Steps", fields: { team: "docs" } }],
  });
  const cms = createCms({ repo, collections: [guides], searchRefreshMs: 0 });
  await cms.core.saveTemplate(admin, "guides", { label: "From draft", title: "Secret launch", summary: "unreleased", body: "draft body", fields: { cost: 42, team: "ops" } });

  // Read key: what the templates are called, never what is in them.
  const seen = await cms.core.templates(readerKey, "guides");
  assert.equal(seen.length, 2);
  for (const t of seen) {
    assert.deepEqual(Object.keys(t).filter((k) => ["title", "summary", "body", "fields"].includes(k)), [], `no content in ${t.label}`);
  }
  assert.deepEqual(seen.map((t) => [t.label, t.source]), [["How-to", "code"], ["From draft", "admin"]]);
  assert.equal(seen[0].description, "Steps");
  assert.equal(seen[1].createdBy, "Kim");
  assert.ok(seen[1].id);

  // REST answers the same projection.
  const { createCmsHandler } = await import("./http");
  const key = await cms.createKey(admin, { name: "reader", scopes: ["read"] });
  const h = createCmsHandler({ cms, basePath: "/api", resolveUser: async () => null });
  const res = await h(new Request("http://x/api/collections/guides/_templates", { headers: { authorization: `Bearer ${key.secret}` } }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("draft body") && !text.includes("Secret launch") && !/"cost"/.test(text), text);

  // A writer that may not read `cost` gets the body, not the cost.
  const w = (await cms.core.templates(writerKey, "guides")).find((t) => t.source === "admin")!;
  assert.equal(w.body, "draft body");
  assert.deepEqual(w.fields, { team: "ops" });
  // The admin sees everything, so the picker still fills the new document.
  const a = (await cms.core.templates(admin, "guides")).find((t) => t.source === "admin")!;
  assert.deepEqual(a.fields, { cost: 42, team: "ops" });
  // Creating from it as the writer: the hidden field is not copied over.
  const made = await cms.create(writerKey, "guides", { slug: "x", title: "X" }, { template: w.id });
  assert.equal(made.body, "draft body");
  assert.equal((await cms.get(admin, "guides", "x", { draft: true })).fields?.cost, undefined);
  // The agent tool keeps its own short list.
  const tool = CMS_TOOLS.find((t) => t.name === "list_templates")!;
  const listed = (await tool.run(cms.core, readerKey, { collection: "guides" })) as { templates: Record<string, unknown>[] };
  assert.equal(listed.templates.length, 2);
  await rejects(cms.create(readerKey, "guides", { slug: "y", title: "Y" }, { template: "howto" }), "forbidden_write");
});

function redirectSetup(o: { now?: () => Date } = {}) {
  const repo = new MemoryRepo();
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public", url: (d) => `/guides/${d.slug}` });
  const cms = createCms({ repo, collections: [guides], searchRefreshMs: 0, redirects: true, now: o.now });
  return { repo, cms };
}

test("redirects: a plain redirect into one that follows a document follows the document too (both orders); rename and archive", async () => {
  for (const order of ["follower first", "plain first"] as const) {
    const { cms } = redirectSetup();
    const g: { id: string } = await cms.create(admin, "guides", { slug: "pricing", title: "Pricing" }, { publish: true });
    if (order === "follower first") {
      await cms.core.redirects.create(admin, { from: "/b", toDocumentId: g.id });
      const a = await cms.core.redirects.create(admin, { from: "/a", to: "/b" });
      assert.equal(a.toDocumentId, g.id, order);
    } else {
      await cms.core.redirects.create(admin, { from: "/a", to: "/b" });
      await cms.core.redirects.create(admin, { from: "/b", toDocumentId: g.id });
      assert.equal((await cms.core.redirects.list(admin)).find((x) => x.from === "/a")?.toDocumentId, g.id, order);
    }
    assert.deepEqual(await cms.core.resolveRedirect("/a"), { to: "/guides/pricing", status: 301 }, order);
    await cms.update(admin, "guides", "pricing", { slug: "plans" }, { publish: true });
    assert.deepEqual(await cms.core.resolveRedirect("/a"), { to: "/guides/plans", status: 301 }, `${order}: follows the rename`);
    assert.deepEqual(await cms.core.resolveRedirect("/b"), { to: "/guides/plans", status: 301 });
    await cms.archive(admin, "guides", "plans");
    assert.equal(await cms.core.resolveRedirect("/a"), null, `${order}: hidden target, no redirect`);
    await cms.unarchive(admin, "guides", "plans");
    assert.deepEqual(await cms.core.resolveRedirect("/a"), { to: "/guides/plans", status: 301 });
  }
  // A plain chain without a document stays plain.
  const { cms } = redirectSetup();
  await cms.core.redirects.create(admin, { from: "/y", to: "/z" });
  const x = await cms.core.redirects.create(admin, { from: "/x", to: "/y" });
  assert.equal(x.to, "/z");
  assert.equal(x.toDocumentId, null);
});

test("redirects: each visit counts on its own day across midnight; visits being written still show", async () => {
  let clock = new Date("2026-03-09T23:59:30Z");
  const { cms, repo } = redirectSetup({ now: () => clock });
  const r = await cms.core.redirects.create(admin, { from: "/promo", to: "/guides" });
  await cms.core.resolveRedirect("/promo");
  await cms.core.resolveRedirect("/promo");
  clock = new Date("2026-03-10T00:00:30Z");
  await cms.core.resolveRedirect("/promo");
  const before = (await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!;
  assert.deepEqual(before.daily.slice(-2), [2, 1]);
  // A write that has not finished yet: the counts stay in the series.
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const orig = repo.addRedirectHits.bind(repo);
  repo.addRedirectHits = async (...a: Parameters<typeof orig>) => {
    await gate;
    return orig(...a);
  };
  const flushing = cms.core.redirects.flushHits();
  const during = (await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!;
  assert.deepEqual(during.daily.slice(-2), [2, 1], "in flight, still counted");
  release();
  await flushing;
  const days = await repo.redirectHitDays("2026-03-01");
  assert.deepEqual(days.filter((x) => x.redirectId === r.id).map((x) => [x.day, x.n]).sort(), [["2026-03-09", 2], ["2026-03-10", 1]]);
  const after = (await cms.core.redirects.list(admin)).find((x) => x.id === r.id)!;
  assert.deepEqual(after.daily.slice(-2), [2, 1], "written, counted once");
});

test("redirects to documents: the document is cached, the access.read answer is asked on every visit", async () => {
  const repo = new MemoryRepo();
  let open = true;
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public", url: (d) => `/guides/${d.slug}`, access: { read: () => open } });
  const cms = createCms({ repo, collections: [guides], searchRefreshMs: 0, redirects: true });
  const g = await cms.create(admin, "guides", { slug: "a", title: "A" }, { publish: true });
  await cms.core.redirects.create(admin, { from: "/x", toDocumentId: g.id });
  let reads = 0;
  const orig = repo.findDocById.bind(repo);
  repo.findDocById = async (...a: Parameters<typeof orig>) => {
    reads++;
    return orig(...a);
  };
  assert.deepEqual(await cms.core.resolveRedirect("/x"), { to: "/guides/a", status: 301 });
  open = false;
  assert.equal(await cms.core.resolveRedirect("/x"), null, "the rule now says no");
  open = true;
  assert.deepEqual(await cms.core.resolveRedirect("/x"), { to: "/guides/a", status: 301 });
  assert.equal(reads, 1, "one read of the document");
});

test("heading 4 never moves a ## or ### anchor: it takes the next free id after them; every reader agrees", async () => {
  const { parseMarkdown, headingAnchors, splitSections, extractToc } = await import("./markdown");
  const { sectionRanges } = await import("./patch");
  const { markdownToHtml } = await import("./html");
  const cases: { body: string; h2h3: string[]; h4: string[] }[] = [
    { body: "#### Setup\n\nx\n\n## Setup\n\ny", h2h3: ["setup"], h4: ["setup-1"] },
    { body: "## Setup\n\n#### Setup\n\n### Setup\n\n## Setup", h2h3: ["setup", "setup-1", "setup-2"], h4: ["setup-3"] },
    { body: "#### Notes {#notes}\n\n## Notes\n\n#### Notes", h2h3: ["notes"], h4: ["notes", "notes-2"] },
    { body: "#### Setup 1\n\n## Setup\n\n## Setup\n\n#### Setup", h2h3: ["setup", "setup-1"], h4: ["setup-1-1", "setup-2"] },
  ];
  for (const c of cases) {
    const old = parseMarkdown(c.body.replace(/^#### .*$/gm, "")).flatMap((b) => (b.t === "heading" ? [b.id] : []));
    const blocks = parseMarkdown(c.body);
    const heads = blocks.flatMap((b) => (b.t === "heading" ? [b] : []));
    assert.deepEqual(heads.filter((h) => h.level !== 4).map((h) => h.id), old, `${c.body}: ## and ### as if #### were not there`);
    assert.deepEqual(heads.filter((h) => h.level !== 4).map((h) => h.id), c.h2h3);
    assert.deepEqual(heads.filter((h) => h.level === 4).map((h) => h.id), c.h4, c.body);
    // TOC, anchors, sections, section patches and the rendered page say the same.
    assert.deepEqual(extractToc(blocks).map((t) => t.id), heads.map((h) => h.id));
    assert.deepEqual(headingAnchors(c.body).map((h) => h.id), heads.map((h) => h.id));
    const sec = splitSections(c.body).filter((s) => s.anchor).map((s) => s.anchor);
    assert.deepEqual(sec, heads.filter((h) => h.level === 2).map((h) => h.id), `${c.body}: sections`);
    assert.deepEqual(sectionRanges(c.body).filter((s) => s.anchor).map((s) => s.anchor), sec);
    const html = markdownToHtml(c.body);
    for (const h of heads) assert.ok(html.includes(`id="${h.id}"`), `${h.id} in ${html}`);
  }
  // Citations under the ## anchor keep working with a #### of the same name above it.
  const repo = new MemoryRepo();
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public" });
  const cms = createCms({ repo, collections: [guides], searchRefreshMs: 0 });
  await cms.create(admin, "guides", { slug: "s", title: "S", body: "#### Setup\n\nnote\n\n## Setup\n\nInstall the package and run it.", keywords: ["setup"] }, { publish: true });
  const { lookupForAgent, verifyCitations } = await import("./agent");
  const r = await lookupForAgent(cms, { kind: "anonymous" }, ["guides"], "setup install package");
  assert.ok(r.sections.some((s) => s.id === "cms://guides/s#setup"), JSON.stringify(r.sections.map((s) => s.id)));
  const v = verifyCitations([{ id: "cms://guides/s#setup", quote: "Install the package" }], r);
  assert.equal(v.valid.length, 1, JSON.stringify(v));
});

test("archive: a reference saved between the check and the write still stops it (asked again inside the transaction)", async () => {
  const repo = new MemoryRepo();
  const { relation } = await import("./fields");
  const people = defineCollection({ slug: "people", label: "People", visibility: "public" });
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public", fields: z.object({ author: relation("people").optional() }) });
  const cms = createCms({ repo, collections: [people, guides], searchRefreshMs: 0 });
  await cms.create(admin, "people", { slug: "kim", title: "Kim" }, { publish: true });
  await cms.create(admin, "guides", { slug: "intro", title: "Intro", fields: { author: { collection: "people", slug: "kim" } as never } }, { publish: true });
  // The check before the transaction sees nothing (the reference "arrives" right after it).
  const orig = repo.listDocRefsTo.bind(repo);
  let calls = 0;
  repo.listDocRefsTo = async (id: string) => (calls++ === 0 ? [] : orig(id));
  await assert.rejects(cms.archive(admin, "people", "kim"), (e: unknown) => e instanceof CmsError && e.code === "doc_referenced" && e.status === 409 && (e.diagnostics ?? [])[0]?.params?.slug === "intro");
  assert.equal((await cms.get(admin, "people", "kim", { draft: true })).status, "published", "not hidden");
  // force still hides it.
  assert.equal((await cms.archive(admin, "people", "kim", { force: true })).status, "archived");
});

test("snippets: escaped tokens and tokens in code are text for expansion, diagnostics and usage alike", async () => {
  const { mapSnippetTokens, snippetKeys } = await import("./markdown");
  const repo = new MemoryRepo();
  const snippets = defineCollection({ slug: "snippets", label: "Snippets", visibility: "public", snippets: true });
  const guides = defineCollection({ slug: "guides", label: "Guides", visibility: "public" });
  const cms = createCms({ repo, collections: [snippets, guides], searchRefreshMs: 0 });
  await cms.create(admin, "snippets", { slug: "vat", title: "VAT", body: "Prices include VAT." }, { publish: true });
  await cms.create(admin, "snippets", { slug: "long", title: "Long", body: "One.\n\nTwo." }, { publish: true });
  const literal = "Write \\[[snippet:vat]] to use it.\n\n\\[[snippet:long]]\n\nAlso `[[snippet:long]]` and `x` \\\\[[snippet:vat]].\n\n```\n[[snippet:nope]]\n```";
  assert.deepEqual(snippetKeys(literal), ["vat"], "only the token after an escaped backslash counts");
  assert.deepEqual(snippetKeys("a \\[[snippet:x]] `[[snippet:y]]`\n\n```\n[[snippet:z]]\n```"), []);
  assert.equal(mapSnippetTokens("\\[[snippet:x]] [[snippet:y]]", (k) => k.toUpperCase()), "\\[[snippet:x]] Y");
  await cms.create(admin, "guides", { slug: "how", title: "How", body: literal }, { publish: true });
  const read = (await cms.get({ kind: "anonymous" }, "guides", "how")).body;
  assert.equal(read, "Write \\[[snippet:vat]] to use it.\n\n\\[[snippet:long]]\n\nAlso `[[snippet:long]]` and `x` \\\\Prices include VAT..\n\n```\n[[snippet:nope]]\n```");
  // No warnings about the long snippet used inline or the one in code that does not exist.
  const d = await cms.diagnose(admin, "guides", { slug: "z", title: "Z", body: "Use \\[[snippet:long]] here. `[[snippet:nope]]`\n\n\\[[snippet:nope]]" });
  assert.deepEqual(d.filter((x) => x.code.startsWith("snippet_")), []);
  // Usage lists only documents that really use the snippet.
  await cms.create(admin, "guides", { slug: "uses", title: "Uses", body: "[[snippet:long]]" });
  assert.deepEqual((await cms.core.snippetUses(admin, "snippets", "long")).map((x) => x.slug), ["uses"]);
  assert.deepEqual((await cms.core.snippetUses(admin, "snippets", "vat")).map((x) => x.slug), ["how"]);
});
