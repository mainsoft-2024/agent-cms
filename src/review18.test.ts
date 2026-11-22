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
  assert.deepEqual([one.versions.map((v) => v.version), one.total, one.nextCursor], [[5, 4], 5, "v.4"]);
  assert.equal(one.versions[0].title, "v5");
  const two = await get(`limit=2&fields=summary&cursor=${one.nextCursor}`);
  assert.deepEqual([two.versions.map((v) => v.version), two.nextCursor], [[3, 2], "v.2"]);
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

test("round 2: writes return projected copies; keys follow per-document rules; readers judged on the published copy", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [products(), notes()], warn: () => {} });
  await cms.create(admin, "products", { slug: "a", title: "A", body: "x\n", fields: { cost: 4, price: 10 } }, { publish: true });
  const saved = await cms.update(editor, "products", "a", { title: "B" });
  assert.doesNotMatch(JSON.stringify(saved), /"cost"/, "the document a write returns has the same projection as a read");
  const label = await cms.labelVersion(editor, "products", "a", 1, { label: "first" });
  assert.doesNotMatch(JSON.stringify(label), /"cost"/, "naming a version returns it projected too");

  await cms.create(admin, "notes", { slug: "inner", title: "Inner", body: "x\n", fields: { members: true } }, { publish: true });
  const key: Actor = { kind: "key", id: "k1", label: "site", scopes: ["read"], collections: null };
  await assert.doesNotReject(cms.get(key, "notes", "inner"), "a key is not anonymous, so this rule lets it in");
  // The draft says "for everyone" but the published copy is members-only: a visitor is judged on what they would get.
  await cms.update(admin, "notes", "inner", { fields: { members: false } });
  await assert.rejects(cms.get(anon, "notes", "inner"), (e: { code: string }) => e.code === "unauthorized");
});

test("round 2: events in collections with per-document rules carry no document identity for non-admins", async () => {
  const { hearAs } = await import("./events");
  const cms = createCms({ repo: new MemoryRepo(), collections: [notes(), products()], warn: () => {} });
  const e = { event: "doc.published", collection: "notes", slug: "inner", version: 1, url: "/notes/inner", actor: { kind: "user", id: "u1", label: "Kim", agent: null } } as const;
  const heard = hearAs(cms as never, editor, e as never) as { slug: unknown; url: unknown; actor: unknown } | null;
  assert.ok(heard);
  assert.deepEqual([heard!.slug, heard!.url, heard!.actor], [null, null, null], "something changed in Notes, not which document or who");
  assert.equal((hearAs(cms as never, admin, e as never) as unknown as { slug: string }).slug, "inner", "admins hear everything");
});

test("round 2: change rows match the live events (no phantom publish), created before published", async () => {
  const repo = new MemoryRepo();
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo, collections: [guide], warn: () => {} });
  const live: string[] = [];
  cms.subscribe((e) => void live.push(`${e.seq}:${e.event}`));
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  await cms.update(admin, "guide", "a", { title: "A" }, { publish: true }); // nothing to do
  await cms.settle();
  await new Promise((r) => setTimeout(r, 5));
  const rows = (await repo.changesSince(0, 100)).map((r) => `${r.seq}:${r.event}`);
  assert.deepEqual(rows, ["1:doc.created", "2:doc.published"], "the no-op publish wrote nothing");
  assert.deepEqual(live, rows, "live subscribers heard exactly the log, in its order");
});

test("round 2: a tenant asked for while its old handler drains gets a new one only after dispose", async () => {
  const { createTenantHandler } = await import("./tenants");
  const log: string[] = [];
  let close: (() => void) | null = null;
  let made = 0;
  const handler = createTenantHandler({
    resolve: (req) => new URL(req.url).hostname.split(".")[0],
    create: () => {
      const n = ++made;
      log.push(`create ${n}`);
      return () => (n === 1 ? new Response(new ReadableStream({ start: (c) => void (close = () => c.close()) })) : new Response("ok"));
    },
    dispose: (t) => void log.push(`dispose ${t}`),
  });
  const first = await handler(new Request("http://acme.x/"));
  const forgot = handler.forget("acme");
  const second = handler(new Request("http://acme.x/"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log, ["create 1"], "the new request waits for the drop");
  close!();
  await first.body!.getReader().read();
  await forgot;
  assert.equal(await (await second).text(), "ok");
  assert.deepEqual(log, ["create 1", "dispose acme", "create 2"]);
});

test("round 3: editors get drafts only of documents they may edit; patch and flow answers are projected; releases hide others' items", async () => {
  const owned = defineCollection({
    slug: "owned",
    label: "Owned",
    visibility: "public",
    fields: z.object({ owner: z.string().optional(), cost: z.number().optional() }),
    access: { write: ({ actor, doc }) => actor.kind === "user" && (actor.isAdmin || !doc || (doc.fields as { owner?: string }).owner === actor.id) },
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [owned], warn: () => {} });
  await cms.create(admin, "owned", { slug: "mine", title: "Mine", body: "x\n", fields: { owner: "u2", cost: 1 } });
  await cms.create(admin, "owned", { slug: "theirs", title: "Theirs public", body: "x\n", fields: { owner: "u9", cost: 2 } }, { publish: true });
  await cms.update(admin, "owned", "theirs", { title: "Theirs secret draft" });
  const titles = (await cms.list(editor, "owned", { drafts: true })).map((d) => d.title).sort();
  assert.deepEqual(titles, ["Mine", "Theirs public"], "someone else's draft is not shown, its published copy is");

  const p = await cms.patch(editor, "owned", "mine", [{ op: "append", markdown: "more" }]);
  assert.doesNotMatch(JSON.stringify(p), /"cost"/, "patch answers through the same projection");

  const rel = await cms.releases.create(admin, { name: "Mixed" });
  await cms.releases.add(admin, rel.id, [{ collection: "owned", slug: "mine" }, { collection: "owned", slug: "theirs" }]);
  const seen = await cms.releases.get(editor, rel.id);
  assert.deepEqual([seen.items.map((i) => i.slug), seen.hiddenItems, seen.canPublish], [["mine"], 1, false]);
});

test("review round 3: releases are guarded on the server, not only on the screen", async () => {
  const owned = defineCollection({
    slug: "owned",
    label: "Owned",
    visibility: "public",
    fields: z.object({ owner: z.string().optional() }),
    access: {
      write: ({ actor, doc }) => actor.kind === "user" && (actor.isAdmin || !doc || (doc.fields as { owner?: string }).owner === actor.id),
      publish: ({ actor }) => actor.kind === "user" && actor.isAdmin,
    },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [owned], warn: () => {} });
  await cms.create(admin, "owned", { slug: "mine", title: "Mine", body: "x\n", fields: { owner: "u2" } });
  await cms.create(admin, "owned", { slug: "theirs", title: "Secret title", body: "x\n", fields: { owner: "u9" } });
  const rel = await cms.releases.create(admin, { name: "Mixed" });
  await cms.releases.add(admin, rel.id, [{ collection: "owned", slug: "mine" }, { collection: "owned", slug: "theirs" }]);
  const theirs = (await cms.releases.get(admin, rel.id)).items.find((i) => i.slug === "theirs")!;

  const refused = (e: { code: string }) => e.code === "forbidden_release";
  await assert.rejects(cms.releases.rename(editor, rel.id, { name: "Mine now" }), refused);
  await assert.rejects(cms.releases.remove(editor, rel.id), refused);
  await assert.rejects(cms.releases.schedule(editor, rel.id, { publishAt: null }), refused);
  await assert.rejects(cms.releases.removeItem(editor, rel.id, theirs.documentId), (e: { code: string }) => e.code === "not_found");
  await assert.rejects(cms.releases.publish(editor, rel.id), (e: { code: string; current?: { blocked: { slug: string; title: string; hidden?: boolean }[] } }) => {
    assert.equal(e.code, "release_blocked");
    assert.doesNotMatch(JSON.stringify(e.current), /Secret title|theirs/, "a hidden item blocks without being named");
    assert.ok(e.current!.blocked.some((b) => b.hidden));
    return true;
  });

  // A scheduled release goes out later as the scheduler: only someone who may publish adds to it.
  await cms.releases.remove(admin, rel.id);
  const sched = await cms.releases.create(admin, { name: "Friday" });
  await cms.releases.add(admin, sched.id, [{ collection: "owned", slug: "theirs" }]);
  await cms.releases.schedule(admin, sched.id, { publishAt: new Date(Date.now() + 86_400_000).toISOString() });
  await assert.rejects(cms.releases.add(editor, sched.id, [{ collection: "owned", slug: "mine" }]), (e: { code: string }) => e.code === "forbidden_publish");
});

test("review round 3: publish by document id refuses a document made later at the same address; a write in between is a conflict", async () => {
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], warn: () => {}, trash: { days: 0 } });
  const first = await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.remove(admin, "guide", "a");
  await cms.create(admin, "guide", { slug: "a", title: "Another A", body: "y\n" });
  await assert.rejects(cms.publish(admin, "guide", "a", { version: 1, expectedVersion: 1, documentId: first.id }), (e: { code: string }) => e.code === "document_replaced");
  assert.equal((await cms.get(admin, "guide", "a", { draft: true })).publishedVersion, null, "nothing was published");
});

test("review round 3: suggestions are bound to their document and hidden from someone who cannot see what the author could", async () => {
  const priced = defineCollection({
    slug: "priced",
    label: "Priced",
    visibility: "public",
    agentEdits: "suggest",
    access: { write: ({ actor }) => actor.kind === "user" },
    fields: z.object({ cost: z.number().optional() }),
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
  });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [priced], warn: () => {} });
  await cms.create(admin, "priced", { slug: "p", title: "P", body: "Old line\n", fields: { cost: 3 } });
  const bot: Actor = { ...admin, agent: { label: "Helper" } } as Actor;
  await cms.ax.edit(bot, "priced", "p", [{ oldString: "cost: 3", newString: "cost: 4" }]);
  assert.equal((await cms.ax.suggestions(admin, "priced", "p")).length, 1, "the admin sees it");
  assert.equal((await cms.ax.suggestions(editor, "priced", "p")).length, 0, "an editor who cannot see cost does not");
  const [s] = await cms.ax.suggestions(admin, "priced", "p");
  await assert.rejects(cms.ax.rejectSuggestion(editor, "priced", "p", s.id), (e: { code: string }) => e.code === "suggestion_not_found");
  assert.equal(JSON.stringify(s).includes("authorHidden"), false, "bookkeeping stays on the server");
  // A record from before the binding (no document id) is not shown to anyone.
  await repo.insertRecord({ kind: "suggestion", scope: "priced/p", data: { edits: [], by: { kind: "user", label: "Old" } }, at: new Date().toISOString() });
  assert.equal((await cms.ax.suggestions(admin, "priced", "p")).length, 1);
});

test("review round 3: search answers only from the copy it indexed; a published copy carries no draft review or schedule", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [notes()], warn: () => {} });
  await cms.create(admin, "notes", { slug: "n", title: "Zebra facts", body: "Zebras are striped.\n" }, { publish: true });
  assert.equal((await cms.search(anon, ["notes"], "zebra")).hits.length, 1);
  // The document changes under the index (another server published members-only content).
  await cms.update(admin, "notes", "n", { fields: { members: true } }, { publish: true });
  const after = await cms.search(anon, ["notes"], "zebra");
  assert.equal(after.hits.length, 0, "the old unit is not shown on the strength of a newer copy");

  await cms.create(admin, "notes", { slug: "r", title: "R", body: "x\n" }, { publish: true });
  await cms.update(admin, "notes", "r", { title: "R2" });
  await cms.requestReview(admin, "notes", "r", { note: "secret reviewer note" });
  const pub = await cms.get(anon, "notes", "r");
  assert.equal(pub.review, null);
  assert.equal(pub.title, "R");
});

test("review round 3: when the change row cannot be written, the write rolls back with it", async () => {
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [notes()], warn: () => {}, onError: () => {} });
  await cms.create(admin, "notes", { slug: "ok", title: "OK", body: "x\n" });
  const real = repo.appendChange.bind(repo);
  repo.appendChange = async () => {
    throw new Error("log is down");
  };
  await assert.rejects(cms.create(admin, "notes", { slug: "lost", title: "Lost", body: "x\n" }), /log is down/);
  await assert.rejects(cms.get(admin, "notes", "lost", { draft: true }), (e: { code: string }) => e.code === "not_found");
  repo.appendChange = real;
  await cms.settle();
});

test("review round 4: autosave answers and conflict copies leave out what the editor may not see", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [products()], warn: () => {} });
  await cms.create(admin, "products", { slug: "p", title: "P", body: "x\n", fields: { cost: 7, price: 10 } });
  const saved = await cms.autosave(editor, "products", "p", { title: "P draft" }, 1);
  assert.equal(JSON.stringify(saved).includes("cost"), false, "the stored value is kept, not shown");
  assert.equal((await cms.get(admin, "products", "p", { draft: true })).autosave?.content.fields.cost, 7);
  await cms.update(admin, "products", "p", { title: "P2" });
  await assert.rejects(cms.update(editor, "products", "p", { title: "late" }, { expectedVersion: 1 }), (e: { code: string; current?: unknown }) => {
    assert.equal(e.code, "conflict_version");
    assert.equal(JSON.stringify(e.current).includes("cost"), false);
    return true;
  });
});

test("review round 4: a release changed after it was checked is not written; the scheduler publishes only the revision it saw", async () => {
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide], warn: () => {} });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.create(admin, "guide", { slug: "b", title: "B", body: "x\n" });
  const rel = await cms.releases.create(admin, { name: "Friday" });
  await cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "a" }]);
  // The editor's add read the release while it was open; meanwhile it was scheduled.
  const stale = await repo.findRelease(rel.id);
  await cms.releases.schedule(admin, rel.id, { publishAt: new Date(Date.now() + 86_400_000).toISOString() });
  const real = repo.findRelease.bind(repo);
  repo.findRelease = async () => structuredClone(stale);
  await assert.rejects(cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "b" }]), (e: { code: string }) => e.code === "release_changed");
  repo.findRelease = real;
  assert.equal((await cms.releases.get(admin, rel.id)).items.length, 1, "nothing was added behind the scheduler's back");
});

test("review round 4: a guarded update never lands on a document in the trash", async () => {
  const repo = new MemoryRepo();
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo, collections: [guide], warn: () => {} });
  const d = await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await cms.remove(admin, "guide", "a");
  assert.equal(await repo.updateDoc(d.id, { title: "x" }, d.version), null);
});

test("review round 4: a publish check that throws shows a fixed message, not the error's text", async () => {
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    publishChecks: [
      () => {
        throw new Error("secret 12345");
      },
    ],
  });
  const errors: unknown[] = [];
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], warn: () => {}, onError: (e) => void errors.push(e) });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  const r = await cms.publishChecks(admin, "guide", "a");
  assert.equal(r.checks[0].code, "check_failed");
  assert.doesNotMatch(r.checks[0].message, /12345/);
  assert.ok(errors.length >= 1, "the error went to onError");
});

test("review round 5: someone who may publish but not edit gets the published copy back, not the draft", async () => {
  const pub = defineCollection({
    slug: "pub",
    label: "Pub",
    visibility: "public",
    access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin, publish: ({ actor }) => actor.kind === "user" },
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [pub], warn: () => {} });
  await cms.create(admin, "pub", { slug: "a", title: "Public", body: "x\n" }, { publish: true });
  await cms.update(admin, "pub", "a", { title: "Secret draft" });
  const out = await cms.publish(editor, "pub", "a", { version: 1 });
  assert.doesNotMatch(JSON.stringify(out), /Secret draft/);
  assert.equal(out.title, "Public");
});

test("review round 5: a check about no field or a containing field says nothing to someone with hidden fields", async () => {
  const p = defineCollection({
    slug: "p",
    label: "P",
    visibility: "public",
    access: { write: ({ actor }) => actor.kind === "user" },
    fields: z.object({ cost: z.number().optional() }),
    fieldAccess: { cost: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } },
    publishChecks: [(c) => [{ code: "x", message: `cost is ${(c.fields as { cost?: number }).cost}`, severity: "warning" }, { code: "y", message: "fields look odd", severity: "warning", path: "fields" }]],
  });
  const cms = createCms({ repo: new MemoryRepo(), collections: [p], warn: () => {} });
  await cms.create(admin, "p", { slug: "a", title: "A", body: "x\n", fields: { cost: 42 } });
  const r = await cms.publishChecks(editor, "p", "a");
  assert.doesNotMatch(JSON.stringify(r.checks), /42|odd/);
  assert.match(JSON.stringify((await cms.publishChecks(admin, "p", "a")).checks), /cost is 42/);
});

test("review round 5: deleting a release that changed after the check is refused", async () => {
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide], warn: () => {} });
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  const rel = await cms.releases.create(admin, { name: "R" });
  const stale = await repo.findRelease(rel.id);
  await cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "a" }]);
  const real = repo.findRelease.bind(repo);
  repo.findRelease = async () => structuredClone(stale);
  await assert.rejects(cms.releases.remove(admin, rel.id), (e: { code: string }) => e.code === "release_changed");
  repo.findRelease = real;
  assert.equal((await cms.releases.get(admin, rel.id)).items.length, 1);
});
