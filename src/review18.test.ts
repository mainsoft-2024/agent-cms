/** 0.18.0: one read policy for every copy of a document, and the change log written in the same transaction. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const editor: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };

function products() {
  return defineCollection({
    slug: "products",
    label: "Products",
    visibility: "public",
    url: (d) => `/products/${d.slug}`,
    fields: z.object({ cost: z.number().optional(), price: z.number().optional() }),
    access: { write: ({ actor }) => actor.kind === "user" },
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
  });
}
/** Members-only documents: a document with `members: true` is not for visitors. */
function notes() {
  return defineCollection({
    slug: "notes",
    label: "Notes",
    visibility: "public",
    fields: z.object({ members: z.boolean().optional() }),
    access: { read: ({ actor, doc }) => !(doc?.fields as { members?: boolean } | undefined)?.members || actor.kind !== "anonymous" },
  });
}
const SECRET = "0123456789abcdef0123456789abcdef-preview";

test("hidden fields leave every copy: versions, one version, diffs, conflicts and preview links", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [products()], warn: () => {}, previewSecret: SECRET });
  await cms.create(admin, "products", { slug: "a", title: "A", body: "x\n", fields: { cost: 4, price: 10 } }, { publish: true });
  await cms.update(admin, "products", "a", { fields: { cost: 5, price: 10 } });

  const list = await cms.versions(editor, "products", "a");
  assert.doesNotMatch(JSON.stringify(list), /"cost"/, "the version list");
  assert.ok(list.every((v) => !v.changed?.fields.some((f) => /cost/.test(f))), "the list of changed fields does not name it either");
  assert.doesNotMatch(JSON.stringify(await cms.version(editor, "products", "a", 1)), /"cost"/, "one version");
  const d = await cms.diff(editor, "products", "a", 1, 2);
  assert.ok(!d.fields.some((f) => /cost/.test(JSON.stringify(f))), "the diff between versions");
  assert.ok(JSON.stringify(await cms.diff(admin, "products", "a", 1, 2)).includes("cost"), "an admin still sees it");

  await assert.rejects(cms.update(editor, "products", "a", { title: "B" }, { expectedVersion: 1 }), (e: { code: string; current?: unknown }) => {
    assert.equal(e.code, "conflict_version");
    assert.ok(e.current, "the current copy comes with the conflict");
    assert.doesNotMatch(JSON.stringify(e.current), /"cost"/, "but without what the editor may not see");
    return true;
  });

  const link = await cms.createPreviewLink(admin, "products", "a");
  const read = await cms.readPreview(link.token);
  assert.equal((read.doc.fields as { price?: number }).price, 10);
  assert.equal((read.doc.fields as { cost?: number }).cost, undefined, "whoever holds the link reads as a visitor");
});

test("search and grep follow the per-document read rule and hide fields", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [products(), notes()], warn: () => {} });
  await cms.create(admin, "notes", { slug: "open", title: "Launch plan open", body: "The launch plan for everyone.\n" }, { publish: true });
  await cms.create(admin, "notes", { slug: "inner", title: "Launch plan inner", body: "The launch plan for members.\n", fields: { members: true } }, { publish: true });
  await cms.create(admin, "products", { slug: "p", title: "Launch widget", body: "Launch day.\n", fields: { cost: 77, price: 99 } }, { publish: true });

  const visitor = await cms.search(anon, ["notes"], "launch plan");
  assert.deepEqual(visitor.hits.map((h) => h.unit.slug).sort(), ["open"], "a visitor does not find the members' note");
  const member = await cms.search(editor, ["notes"], "launch plan");
  assert.deepEqual([...new Set(member.hits.map((h) => h.unit.slug))].sort(), ["inner", "open"]);
  const hit = (await cms.search(editor, ["products"], "launch widget")).hits[0];
  assert.equal((hit.unit.fields as { cost?: number }).cost, undefined, "a hidden field is not in the hit");
  assert.equal((hit.unit.fields as { price?: number }).price, 99);

  const g = await cms.ax.grep(anon, { pattern: "launch plan", ignoreCase: true, collections: ["notes"] });
  assert.ok(g.matches.every((m) => !m.path.includes("inner")), "grep keeps the visitor out of the members' note");
  const gc = await cms.ax.grep(editor, { pattern: "cost", collections: ["products"] });
  assert.equal(gc.count, 0, "a hidden field's frontmatter line is not searchable either");
});

test("change log: rows are written in the write's own transaction, once per event, and roll back with it", async () => {
  const repo = new MemoryRepo();
  // Record whether each change row is written inside a transaction.
  let depth = 0;
  const inTx: boolean[] = [];
  const tx = repo.tx.bind(repo);
  repo.tx = (async (fn: (r: MemoryRepo) => Promise<unknown>) => {
    depth++;
    try {
      return await tx(fn as never);
    } finally {
      depth--;
    }
  }) as typeof repo.tx;
  const append = repo.appendChange.bind(repo);
  repo.appendChange = (async (c: Parameters<typeof append>[0]) => {
    inTx.push(depth > 0);
    return append(c);
  }) as typeof repo.appendChange;
  const cms = createCms({ repo, collections: [products()], warn: () => {} });
  await cms.create(admin, "products", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  await cms.update(admin, "products", "a", { title: "B" });
  await cms.unpublish(admin, "products", "a");
  await cms.remove(admin, "products", "a");
  await cms.settle();
  const rows = await repo.changesSince(0, 100);
  const events = rows.map((r) => `${r.event}:${r.version}`);
  assert.deepEqual(events, ["doc.created:1", "doc.published:1", "doc.updated:2", "doc.unpublished:2", "doc.deleted:2"], "each change once, in order");
  assert.deepEqual(inTx, [true, true, true, true, true], "every row was written inside the transaction that made the change");

  // A write that fails inside its transaction leaves no row behind.
  const before = (await repo.changesSince(0, 100)).length;
  await assert.rejects(cms.create(admin, "products", { slug: "", title: "", body: "" }));
  await cms.settle();
  assert.equal((await repo.changesSince(0, 100)).length, before);
});

test("import: a save that went through stays saved when its publish fails, and only the publish is tried again", async () => {
  let block = true;
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    hooks: { beforePublish: [() => { if (block) throw new Error("legal has not signed off"); }] },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], warn: () => {} });
  const files = [{ path: "guide/a.md", text: "---\ntitle: A\nstatus: published\n---\nHello.\n" }];
  const first = await cms.transfer.import(admin, files, { publish: true });
  const a = first.items[0];
  assert.equal(a.change, "new");
  assert.equal(a.toVersion, 1, "the save stands");
  assert.equal(a.published, false);
  assert.match(a.publishError ?? "", /legal/, "and the item says why the publish failed");
  assert.equal((await cms.get(admin, "guide", "a", { draft: true })).publishedVersion, null);

  block = false;
  const again = await cms.transfer.import(admin, files, { publish: true, only: ["guide/a.md"] });
  assert.equal(again.items[0].change, "same", "nothing to save the second time");
  assert.equal(again.items[0].published, true, "only the publish ran");
  const doc = await cms.get(admin, "guide", "a", { draft: true });
  assert.deepEqual([doc.version, doc.publishedVersion], [1, 1], "no extra version");
});

test("versions in pages: newest first, cut by the store, continuing below the cursor", async () => {
  const { createCmsHandler } = await import("./http");
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], warn: () => {} });
  await cms.create(admin, "guide", { slug: "a", title: "v1", body: "x\n" });
  for (let n = 2; n <= 5; n++) await cms.update(admin, "guide", "a", { title: `v${n}` });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const get = async (q: string) => (await (await handler(new Request(`http://x/api/cms/collections/guide/a/versions?${q}`))).json()) as { versions: { version: number; title?: string }[]; total: number; nextCursor: string | null };
  const one = await get("limit=2&fields=summary");
  assert.deepEqual([one.versions.map((v) => v.version), one.total, one.nextCursor], [[5, 4], 5, "4"]);
  assert.equal(one.versions[0].title, "v5");
  const two = await get(`limit=2&fields=summary&cursor=${one.nextCursor}`);
  assert.deepEqual([two.versions.map((v) => v.version), two.nextCursor], [[3, 2], "2"]);
  const three = await get(`limit=2&cursor=${two.nextCursor}`);
  assert.deepEqual([three.versions.map((v) => v.version), three.nextCursor], [[1], null]);
});

test("tenants: a dropped tenant is disposed only after its requests in progress, streams included, have finished", async () => {
  const { createTenantHandler } = await import("./tenants");
  const disposed: string[] = [];
  let push: ((s: string) => void) | null = null;
  let end: (() => void) | null = null;
  const handler = createTenantHandler({
    resolve: (req) => new URL(req.url).hostname.split(".")[0],
    create: () => () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            push = (s) => c.enqueue(new TextEncoder().encode(s));
            end = () => c.close();
          },
        })
      ),
    dispose: (t) => void disposed.push(t),
    drainMs: 5000,
  });
  const res = await handler(new Request("http://acme.example.test/api/cms/_events"));
  const reader = res.body!.getReader();
  push!("one");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "one");
  const forgotten = handler.forget("acme");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(disposed, [], "the stream is still open, so the tenant is not closed under it");
  end!();
  await reader.read();
  await forgotten;
  assert.deepEqual(disposed, ["acme"]);
  // A request after the drop makes a fresh handler.
  assert.ok(handler.tenants().length === 0);
});
