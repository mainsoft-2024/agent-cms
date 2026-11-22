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
  const cms = createCms({ repo: new MemoryRepo(), collections: [products()], warn: () => {}, previewSecret: SECRET, siteUrl: "https://app.test" });
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
