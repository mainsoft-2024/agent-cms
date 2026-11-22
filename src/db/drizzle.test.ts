/**
 * Real Postgres: pglite by default, or a server when DATABASE_URL is set (CI
 * runs both). Covers the DrizzleRepo contract, the DDL, the 0.5.x → 0.6.0
 * upgrade with `cms_gaps` left intact, table prefixes and schemas, and races.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { migrationSql, runCli } from "../cli";
import { createCms, defineCollection } from "../cms";
import { DrizzleRepo } from "../drizzle-repo";
import { isCmsError } from "../errors";
import { MemoryStorage } from "../storage";
import { cmsDdl, cmsTables, SCHEMA_VERSION, splitSql } from "../tables";
import { createCmsHandler } from "../http";
import { createTenantHandler, migrateTenant, tenantTables } from "../tenants";
import { connectPostgres } from "../db";
import type { Actor } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

const admin: Actor = { kind: "user", id: "u1", label: "Admin", isAdmin: true };
const anon: Actor = { kind: "anonymous" };
const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `/guide/${d.slug}` });
const OLD_DDL = readFileSync(join(import.meta.dirname ?? __dirname, "fixtures", "schema-0.5.sql"), "utf8");

/** A fresh, empty database for one test. */
async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = (await import("pg" as string)) as { Pool: new (o: { connectionString: string }) => { end(): Promise<void>; query(q: string): Promise<unknown> } };
    const pool = new Pool({ connectionString: url });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS content CASCADE; CREATE SCHEMA public;");
    const { drizzle } = (await import("drizzle-orm/node-postgres" as string)) as { drizzle: (p: unknown) => Db };
    return { db: drizzle(pool), close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  return { db: drizzle(client) as unknown as Db, close: () => client.close() };
}

async function run(db: Db, text: string) {
  for (const s of splitSql(text)) await db.execute(sql.raw(s));
}

async function rows<T>(db: Db, q: string): Promise<T[]> {
  const r = (await db.execute(sql.raw(q))) as unknown as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

test("db: DDL is idempotent and the repo passes the CMS flow", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    await run(db, cmsDdl());
    const repo = new DrizzleRepo(db);
    const report = await repo.inspect();
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual(report.missingColumns, []);
    assert.equal(report.schemaVersion, SCHEMA_VERSION);
    assert.equal(report.gapsTable, false);

    const cms = createCms({ repo, collections: [guide], previewSecret: "s".repeat(32), searchRefreshMs: 0 });
    await cms.create(admin, "guide", { slug: "slack", title: "Slack", body: "## Connect\n\nOpen settings." }, { publish: true });
    await cms.autosave(admin, "guide", "slack", { title: "typing" }, 1);
    assert.equal((await cms.get(admin, "guide", "slack", { draft: true })).autosave?.content.title, "typing");
    const bot: Actor = { kind: "key", id: "k", label: "bot", scopes: ["write"], collections: null };
    await cms.update(bot, "guide", "slack", { body: "## Connect\n\nOpen Settings > Apps." }, { expectedVersion: 1 });
    const [change] = await cms.agentChanges(admin, "guide", "slack");
    await cms.reviewChanges(admin, "guide", "slack", { hunks: [change.id] });
    assert.equal((await cms.agentChanges(admin, "guide", "slack")).length, 0);
    assert.equal((await cms.get(anon, "guide", "slack")).body, "## Connect\n\nOpen settings.");
    await cms.publish(admin, "guide", "slack");
    assert.equal((await cms.search(anon, ["guide"], "settings apps")).empty, false);
    const d = await cms.diff(admin, "guide", "slack", 1, 2);
    assert.equal(d.hunks.length, 1);
    const link = await cms.createPreviewLink(admin, "guide", "slack");
    assert.equal((await cms.readPreview(link.token)).version, 2);

    const { key, secret } = await cms.createKey(admin, { name: "k", scopes: ["read"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.ok(key.expiresAt);
    assert.equal((await cms.authenticateKey(secret))?.label, "k");
    const doc = await cms.get(admin, "guide", "slack");
    await cms.recordHits([doc.id], "mcp");
    await cms.recordHits([doc.id], "mcp");
    await cms.recordHits([doc.id], "rest");
    assert.equal((await cms.hitCounts(admin, "guide")).get(doc.id), 3);
    await new Promise((r) => setTimeout(r, 50));
    const audit = await cms.audit(admin);
    assert.ok(audit.entries.some((e) => e.action === "key.create"));
    assert.ok(audit.entries.some((e) => e.action === "doc.publish"));
    const page2 = await cms.audit(admin, { limit: 1, cursor: (await cms.audit(admin, { limit: 1 })).nextCursor });
    assert.equal(page2.entries.length, 1);

    const bulk = await cms.bulk(admin, "guide", "archive", [{ slug: "slack" }, { slug: "nope" }]);
    assert.deepEqual(bulk.map((b) => b.ok), [true, false]);
    assert.equal((await cms.counts(admin, "guide")).archived, 1);
    await cms.remove(admin, "guide", "slack");
    // In the trash: gone for readers, the row and its versions wait for a restore or a purge.
    assert.equal(await cms.get(admin, "guide", "slack", { draft: true }).catch((e) => e.code), "not_found");
    assert.deepEqual((await cms.trash.list(admin)).items.map((i) => [i.kind, i.slug, i.state]), [["document", "slack", "archived"]]);
    await cms.trash.restore(admin, [{ kind: "document", id: (await cms.trash.list(admin)).items[0].id }]);
    assert.equal((await cms.get(admin, "guide", "slack", { draft: true })).status, "archived");
    await cms.remove(admin, "guide", "slack");
    assert.deepEqual(await cms.trash.purge(admin, "all"), { purged: 1 });
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_versions"))[0].n, 0);
  } finally {
    await close();
  }
});

test("db: concurrent saves on one version: one wins, the other gets conflict_version", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    const cms = createCms({ repo: new DrizzleRepo(db), collections: [guide] });
    await cms.create(admin, "guide", { slug: "a", title: "A" });
    const r = await Promise.allSettled([
      cms.update(admin, "guide", "a", { summary: "one" }, { expectedVersion: 1 }),
      cms.update(admin, "guide", "a", { summary: "two" }, { expectedVersion: 1 }),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const failed = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    assert.ok(isCmsError(failed.reason) && failed.reason.code === "conflict_version");
    // Two creates with one slug: 409, not 500.
    const c = await Promise.allSettled([cms.create(admin, "guide", { slug: "b", title: "B" }), cms.create(admin, "guide", { slug: "b", title: "B" })]);
    const err = (c.find((x) => x.status === "rejected") as PromiseRejectedResult).reason;
    assert.ok(isCmsError(err) && err.code === "slug_taken");
  } finally {
    await close();
  }
});

test("db: upgrade from 0.5.x keeps cms_gaps rows untouched; the UPGRADE copy SQL moves them", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, OLD_DDL);
    await run(
      db,
      `INSERT INTO cms_documents (id, collection, slug, status, title, body, version, published_version, published, published_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'guide', 'old', 'published', 'Old', '## A\n\ntext', 1, 1,
                 '{"slug":"old","title":"Old","summary":"","body":"## A\\n\\ntext","category":null,"keywords":[],"fields":{}}'::jsonb, now());
       INSERT INTO cms_versions (document_id, version, snapshot, author_kind, author_label)
         VALUES ('11111111-1111-4111-8111-111111111111', 1, '{"slug":"old","title":"Old","summary":"","body":"## A\\n\\ntext","category":null,"keywords":[],"fields":{}}'::jsonb, 'user', 'Admin');
       INSERT INTO cms_hits (document_id, day, count) VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-01', 4);
       INSERT INTO cms_gaps (collection, kind, query, normalized, count) VALUES ('guide', 'no_result', '환불 받는 법', '법 환불', 3), ('guide', 'no_result', 'refund', 'refund', 1);`
    );
    const repo = new DrizzleRepo(db);

    // Boot refuses until migrated, and says what to run.
    const cms = createCms({ repo, collections: [guide] });
    await assert.rejects(cms.get(anon, "guide", "old"), (e: unknown) => isCmsError(e) && e.code === "schema_outdated");

    const before = await repo.inspect();
    assert.equal(before.schemaVersion, null);
    assert.ok(before.missingTables.includes("cms_audit"));
    assert.ok(before.missingColumns.includes("cms_documents.autosave"));
    assert.equal(before.gapsTable, true);
    assert.equal(before.gapsRows, 2);

    // `migrate check` says so (exit 1) and prints SQL without any DROP.
    const out: string[] = [];
    const io = { db, cwd: "/nonexistent", out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    assert.equal(await runCli(["migrate", "check"], io), 1);
    const pending = migrationSql(before, cmsTables())!;
    assert.ok(!/drop\s+table/i.test(pending.sql));
    assert.ok(!/cms_gaps/.test(pending.sql));
    await run(db, pending.sql);

    out.length = 0;
    assert.equal(await runCli(["migrate", "check"], io), 0);
    assert.equal(await runCli(["doctor"], io), 0);
    const gapsLine = out.find((l) => l.includes("cms_gaps"))!;
    assert.match(gapsLine, /^warn/);
    assert.match(gapsLine, /2 rows/);
    assert.ok(!out.some((l) => /drop table/i.test(l)), "doctor never offers to drop cms_gaps");

    // Old data reads; new features work on the old rows.
    const fresh = createCms({ repo, collections: [guide], searchRefreshMs: 0 });
    assert.equal((await fresh.get(anon, "guide", "old")).title, "Old");
    await fresh.recordHits(["11111111-1111-4111-8111-111111111111"], "mcp");
    assert.equal((await fresh.hitCounts(admin, "guide", 3650)).get("11111111-1111-4111-8111-111111111111"), 5);
    await fresh.update(admin, "guide", "old", { title: "Old 2" }, { expectedVersion: 1 });

    // cms_gaps is exactly as it was.
    const gaps = await rows<{ query: string; count: number }>(db, 'select query, count from cms_gaps order by query collate "C"');
    assert.deepEqual(gaps, [
      { query: "refund", count: 1 },
      { query: "환불 받는 법", count: 3 },
    ]);

    // UPGRADE-0.6.md step 3.
    await run(db, "CREATE TABLE IF NOT EXISTS app_search_misses (LIKE cms_gaps INCLUDING ALL); INSERT INTO app_search_misses SELECT * FROM cms_gaps ON CONFLICT DO NOTHING;");
    const [counts] = await rows<{ before: number; after: number }>(db, "SELECT (SELECT count(*)::int FROM cms_gaps) AS before, (SELECT count(*)::int FROM app_search_misses) AS after");
    assert.deepEqual(counts, { before: 2, after: 2 });
  } finally {
    await close();
  }
});

test("db: table prefix and Postgres schema options", async () => {
  const { db, close } = await freshDb();
  try {
    const tables = cmsTables({ prefix: "blog_", schema: "content" });
    await run(db, cmsDdl(tables));
    await run(db, cmsDdl(tables));
    const names = await rows<{ table_name: string }>(db, "select table_name from information_schema.tables where table_schema = 'content' order by table_name collate \"C\"");
    assert.deepEqual(
      names.map((n) => n.table_name),
      ["blog_api_keys", "blog_asset_refs", "blog_assets", "blog_audit", "blog_changes", "blog_comments", "blog_documents", "blog_hits", "blog_jobs", "blog_meta", "blog_presence", "blog_records", "blog_releases", "blog_saved_filters", "blog_versions", "blog_webhook_deliveries", "blog_webhooks"]
    );
    const repo = new DrizzleRepo(db, { tables });
    const report = await repo.inspect();
    assert.deepEqual([report.missingTables, report.missingColumns, report.schemaVersion], [[], [], SCHEMA_VERSION]);
    const cms = createCms({ repo, collections: [guide] });
    await cms.create(admin, "guide", { slug: "p", title: "P" }, { publish: true });
    assert.equal((await cms.get(anon, "guide", "p")).title, "P");
    assert.throws(() => cmsTables({ prefix: "bad-prefix" }));
  } finally {
    await close();
  }
});

test("db: schema 2 → 3 adds the agent columns and the asset tables; files and their uses round-trip", async () => {
  const { db, close } = await freshDb();
  try {
    // A 0.7.0 database: everything but what version 3 adds.
    await run(db, cmsDdl());
    await run(
      db,
      `DROP TABLE cms_webhook_deliveries; DROP TABLE cms_webhooks; DROP TABLE cms_jobs; DROP TABLE cms_asset_refs; DROP TABLE cms_assets; DROP TABLE cms_comments; DROP TABLE cms_presence; DROP TABLE cms_releases; DROP TABLE cms_saved_filters;
       ALTER TABLE cms_documents DROP COLUMN deleted_at, DROP COLUMN deleted_by, DROP COLUMN schedule, DROP COLUMN due_at, DROP COLUMN review;
       ALTER TABLE cms_versions DROP COLUMN label, DROP COLUMN pinned, DROP COLUMN approved_by, DROP COLUMN approved_at;
       ALTER TABLE cms_documents DROP COLUMN updated_by_agent; ALTER TABLE cms_versions DROP COLUMN author_agent; ALTER TABLE cms_audit DROP COLUMN actor_agent;
       UPDATE cms_meta SET value = '2'::jsonb WHERE key = 'schema_version';`
    );
    const repo = new DrizzleRepo(db);
    const cms = createCms({ repo, collections: [guide] });
    await assert.rejects(cms.get(anon, "guide", "x"), (e: unknown) => isCmsError(e) && e.code === "schema_outdated");
    const before = await repo.inspect();
    assert.equal(before.schemaVersion, 2);
    assert.deepEqual(before.missingTables.sort(), ["cms_asset_refs", "cms_assets", "cms_comments", "cms_jobs", "cms_presence", "cms_releases", "cms_saved_filters", "cms_webhook_deliveries", "cms_webhooks"]);
    const pending = migrationSql(before, cmsTables())!;
    // Not the whole DDL: the upgrade steps (all of them are safe to run again).
    assert.match(pending.steps[pending.steps.length - 7], /0\.8\.0/);
    assert.match(pending.steps[pending.steps.length - 6], /0\.10\.0/);
    assert.match(pending.steps[pending.steps.length - 5], /0\.11\.0/);
    assert.match(pending.steps[pending.steps.length - 4], /0\.12\.0/);
    assert.match(pending.steps[pending.steps.length - 3], /0\.13\.0/);
    assert.match(pending.steps[pending.steps.length - 2], /0\.15\.0/);
    assert.doesNotMatch(pending.sql, /CREATE TABLE IF NOT EXISTS "cms_documents"/);
    await run(db, pending.sql);
    await run(db, pending.sql);
    const after = await repo.inspect();
    assert.deepEqual([after.missingTables, after.missingColumns, after.schemaVersion], [[], [], SCHEMA_VERSION]);
    assert.equal(migrationSql(after, cmsTables()), null);

    // An agent acting for a person is stored on the document, the version and the audit row.
    const fresh = createCms({ repo, collections: [guide] });
    const d = await fresh.create({ ...admin, agent: { label: "docs-bot" } } as Actor, "guide", { slug: "a", title: "A", body: "## S\n\ntext" }, { publish: true });
    assert.equal(d.updatedByAgent, "docs-bot");
    assert.equal((await fresh.versions(admin, "guide", "a"))[0].authorAgent, "docs-bot");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await repo.listAudit({ limit: 5, action: "doc.publish" }))[0].actorAgent, "docs-bot");

    // Files: insert, find, list with every filter, counts, update, uses, delete.
    const base = { store: "public", kind: "image" as const, mime: "image/png", size: 6 * 1024 ** 3, width: 10, height: 20, duration: null, alt: "", tags: [] as string[], thumbKey: null, status: "ready" as const, uploadId: null, createdBy: "Admin", createdByKind: "user" as const, createdByAgent: null };
    const one = await repo.insertAsset({ ...base, id: "aaaaaaaaaaaa", key: "blog/Hero.png", folder: "blog", name: "Hero.png", tags: ["launch"], createdAt: "2026-11-01T00:00:00.000Z" });
    assert.equal(one.size, 6 * 1024 ** 3, "sizes above 4GB survive (bigint)");
    await repo.insertAsset({ ...base, id: "bbbbbbbbbbbb", key: "blog/2026/b.pdf", folder: "blog/2026", name: "b.pdf", kind: "document", mime: "application/pdf", alt: "Price list", createdAt: "2026-11-02T00:00:00.000Z" });
    await repo.insertAsset({ ...base, id: "cccccccccccc", key: "c.png", folder: "", name: "c.png", status: "pending", uploadId: "u1", createdAt: "2026-11-03T00:00:00.000Z" });
    await repo.insertAsset({ ...base, id: "dddddddddddd", store: "private", key: "blogs/d.png", folder: "blogs", name: "d.png", createdAt: "2026-11-04T00:00:00.000Z" });
    await assert.rejects(repo.insertAsset({ ...base, id: "eeeeeeeeeeee", key: "blog/Hero.png", folder: "blog", name: "Hero.png" }), "one key per store");
    const ids = async (q: Parameters<typeof repo.listAssets>[0]) => (await repo.listAssets(q)).map((a) => a.id[0]).join("");
    assert.equal(await ids({}), "dcba", "newest first");
    assert.equal(await ids({ store: "public", status: "ready" }), "ba");
    assert.equal(await ids({ store: "public", folder: "blog" }), "a");
    assert.equal(await ids({ store: "public", under: "blog" }), "ba", "under takes sub-folders, not look-alike names");
    assert.equal(await ids({ under: "blog" }), "ba");
    assert.equal(await ids({ kinds: ["document"] }), "b");
    assert.equal(await ids({ store: "public", notKinds: ["image"] }), "b");
    assert.equal(await ids({ q: "hero" }), "a");
    assert.equal(await ids({ q: "PRICE" }), "b");
    assert.equal(await ids({ q: "laun" }), "a");
    assert.equal(await ids({ tag: "launch" }), "a");
    assert.equal(await ids({ status: "pending", createdBefore: "2026-11-03T00:00:01.000Z" }), "c");
    assert.equal(await ids({ limit: 2 }), "dc");
    assert.equal(await ids({ before: "2026-11-03T00:00:00.000Z|cccccccccccc", limit: 2 }), "ba");
    assert.deepEqual((await repo.findAssets(["bbbbbbbbbbbb", "nope", "aaaaaaaaaaaa"])).map((a) => a.id).sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    assert.equal((await repo.findAssetByKey("public", "blog/Hero.png"))?.id, "aaaaaaaaaaaa");
    assert.deepEqual(
      (await repo.countAssets("public")).sort((x, y) => x.folder.localeCompare(y.folder)),
      [
        { store: "public", folder: "blog", kind: "image", n: 1 },
        { store: "public", folder: "blog/2026", kind: "document", n: 1 },
      ]
    );
    const moved = await repo.updateAsset("aaaaaaaaaaaa", { key: "brand/Hero.png", folder: "brand", alt: "A hero", tags: ["a", "b"] });
    // 0.11.0: a new file has no focal point and revision 0; both are stored.
    assert.deepEqual([one.focalX, one.focalY, one.rev], [null, null, 0]);
    const pointed = (await repo.updateAsset("aaaaaaaaaaaa", { focalX: 0.25, focalY: 0.8, rev: 1 }))!;
    assert.deepEqual([pointed.focalX, pointed.focalY, pointed.rev], [0.25, 0.8, 1]);
    assert.equal((await repo.updateAsset("aaaaaaaaaaaa", { focalX: null, focalY: null }))!.focalX, null);
    assert.deepEqual([moved?.key, moved?.folder, moved?.alt, moved?.tags], ["brand/Hero.png", "brand", "A hero", ["a", "b"]]);

    await repo.setAssetRefs(d.id, [
      { assetId: "aaaaaaaaaaaa", inDraft: true, inPublished: true },
      { assetId: "bbbbbbbbbbbb", inDraft: true, inPublished: false },
      { assetId: "zzzzzzzzzzzz", inDraft: true, inPublished: false },
    ]);
    assert.deepEqual(await repo.listAssetRefs("aaaaaaaaaaaa"), [{ assetId: "aaaaaaaaaaaa", documentId: d.id, inDraft: true, inPublished: true }]);
    await repo.setAssetRefs(d.id, [{ assetId: "bbbbbbbbbbbb", inDraft: true, inPublished: false }]);
    assert.deepEqual(await repo.listAssetRefs("aaaaaaaaaaaa"), []);
    // Deleting the file or the document clears its uses.
    await repo.deleteAsset("bbbbbbbbbbbb");
    assert.equal(await repo.findAsset("bbbbbbbbbbbb"), null);
    await repo.setAssetRefs(d.id, [{ assetId: "aaaaaaaaaaaa", inDraft: true, inPublished: false }]);
    await fresh.remove(admin, "guide", "a");
    // The document is in the trash and still names the file; emptying the trash drops the use with it.
    assert.equal((await repo.listAssetRefs("aaaaaaaaaaaa")).length, 1);
    assert.equal(await repo.findDoc("guide", "a"), null);
    assert.equal((await repo.findDoc("guide", "a", { trashed: true }))?.deletedBy, "Admin");
    await fresh.trash.purge(admin, "all");
    assert.deepEqual(await repo.listAssetRefs("aaaaaaaaaaaa"), []);
    assert.ok(await repo.findAsset("aaaaaaaaaaaa"), "the file itself stays");
  } finally {
    await close();
  }
});

test("db: the media library on a real database (uses follow saves, publishes and deletes)", async () => {
  const { db, close } = await freshDb();
  try {
    for (const stmt of splitSql(cmsDdl())) await run(db, stmt);
    const store = new MemoryStorage({ publicUrl: "https://cdn.example.com" });
    const cms = createCms({ repo: new DrizzleRepo(db), collections: [guide], media: { stores: { public: { visibility: "public", adapter: store } } } });
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 32, 0, 0, 2, 88]);
    const { asset, upload } = await cms.assets.requestUpload(admin, { name: "hero.png", size: png.length, folder: "guide", tags: ["launch"] });
    if (upload.kind === "single") await store.send(upload.url, png);
    const file = await cms.assets.completeUpload(admin, asset.id);
    assert.deepEqual([file.status, file.width, file.height, file.size], ["ready", 800, 600, 64]);
    assert.equal((await cms.assets.requestUpload(admin, { name: "hero.png", size: 10, folder: "guide" })).asset.name, "hero-2.png", "a name in use gets a number");

    await cms.create(admin, "guide", { slug: "a", title: "A", body: `![Hero](asset:${file.id}/hero.png)` }, { publish: true });
    await cms.create(admin, "guide", { slug: "b", title: "B", body: "text" });
    await cms.update(admin, "guide", "b", { body: `[the picture](asset:${file.id}/hero.png)` });
    const used = async () => (await cms.assets.get(admin, file.id)).usage.map((u) => `${u.slug}:${u.inDraft ? "d" : ""}${u.inPublished ? "p" : ""}`).sort();
    assert.deepEqual(await used(), ["a:dp", "b:d"]);
    // The published copy still shows the picture after the draft drops it.
    await cms.update(admin, "guide", "a", { body: "no picture" });
    assert.deepEqual(await used(), ["a:p", "b:d"]);
    await cms.publish(admin, "guide", "a");
    assert.deepEqual(await used(), ["b:d"]);
    // A save that fails leaves the uses as they were (same transaction).
    await assert.rejects(cms.update(admin, "guide", "b", { body: "![x](asset:zzzzzzzzzzzz/x.png)" }), (e) => isCmsError(e) && e.code === "asset_missing");
    assert.deepEqual(await used(), ["b:d"]);
    assert.deepEqual(Object.keys(await cms.assetsFor(await cms.get(admin, "guide", "b", { draft: true }))), [file.id]);
    assert.deepEqual((await cms.assets.list(admin, { tag: "launch", q: "HERO" })).assets.map((a) => a.id), [file.id]);
    assert.deepEqual((await cms.assets.folders(admin))[0].folders, [{ path: "guide", count: 1 }]);

    await assert.rejects(cms.assets.remove(admin, file.id), (e) => isCmsError(e) && e.code === "asset_in_use");
    await cms.remove(admin, "guide", "b");
    await cms.assets.remove(admin, file.id);
    // Both are in the trash; the rows go when the trash is emptied.
    assert.deepEqual((await cms.trash.list(admin)).items.map((i) => i.kind).sort(), ["asset", "document"]);
    assert.deepEqual(await cms.trash.purge(admin, "all"), { purged: 2 });
    assert.equal((await rows(db, "SELECT 1 FROM cms_asset_refs")).length, 0);
    assert.equal((await cms.assets.cleanup({ olderThanMs: -1000 })).removed, 1, "the upload that never finished");
    assert.equal((await rows(db, "SELECT 1 FROM cms_assets")).length, 0);
  } finally {
    await close();
  }
});

test("db: jobs are taken once by callers at the same moment; webhooks and deliveries round-trip", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    const repo = new DrizzleRepo(db);
    const sent: string[] = [];
    const cms = createCms({
      repo,
      collections: [guide],
      secretsKey: "k".repeat(40),
      webhooks: { resolveHost: async () => ["93.184.216.34"], fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => (sent.push(String(init?.body)), new Response(null, { status: sent.length === 1 ? 500 : 200 }))) as typeof fetch },
    });
    let runs = 0;
    cms.jobs.define("t.count", { run: () => void runs++ });
    for (let i = 0; i < 12; i++) await cms.jobs.enqueue("t.count", { i });
    const [a, b] = await Promise.all([cms.jobs.run(), cms.jobs.run()]);
    assert.deepEqual([runs, a.ran + b.ran], [12, 12]);
    assert.deepEqual(await cms.jobs.stats(), { waiting: 0, failed: 0 });
    assert.equal((await cms.jobs.list({ state: "done" })).length, 12);

    const { webhook, secret } = await cms.webhooks.create(admin, { name: "Site", url: "https://hooks.test/x", events: ["doc.published"], collections: ["guide"] });
    assert.equal((await cms.webhooks.secret(admin, webhook.id)).secret, secret);
    const [row] = await rows<{ secret_enc: string }>(db, "select secret_enc from cms_webhooks");
    assert.ok(row.secret_enc.startsWith("v1.") && !row.secret_enc.includes(secret), "the secret is stored sealed");
    await cms.create(admin, "guide", { slug: "w", title: "W" }, { publish: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await cms.cron()).jobs.retried, 1);
    assert.equal((await cms.webhooks.list(admin))[0].failures, 1);
    await run(db, "update cms_jobs set run_at = now() - interval '1 second' where done_at is null");
    assert.equal((await cms.cron()).jobs.ok, 1);
    const ds = await cms.webhooks.deliveries(admin, webhook.id);
    assert.deepEqual(ds.map((d) => [d.attempt, d.ok, d.status]).sort(), [[1, false, 500], [2, true, 200]]);
    assert.equal((await cms.webhooks.list(admin))[0].failures, 0);
    assert.equal((await cms.webhooks.update(admin, webhook.id, { enabled: false, name: "Off" })).name, "Off");
    await cms.webhooks.remove(admin, webhook.id);
    assert.deepEqual(await rows(db, "select id from cms_webhook_deliveries"), [], "deliveries go with their webhook");
    assert.equal(await repo.findWebhook("not-a-uuid"), null);
  } finally {
    await close();
  }
});

test("db: schema 6 → 7 adds cms_records; automations, runs and roles work on a real database", async () => {
  const { db, close } = await freshDb();
  try {
    // A 0.12.0 database: everything but the records table.
    await run(db, cmsDdl());
    await run(db, `DROP TABLE cms_records; UPDATE cms_meta SET value = '6'::jsonb WHERE key = 'schema_version';`);
    const repo = new DrizzleRepo(db);
    const cms = createCms({ repo, collections: [guide], cronSecret: "c".repeat(32) });
    await assert.rejects(cms.get(anon, "guide", "x"), (e: unknown) => isCmsError(e) && e.code === "schema_outdated");
    const before = await repo.inspect();
    assert.deepEqual([before.schemaVersion, before.missingTables], [6, ["cms_records"]]);
    const pending = migrationSql(before, cmsTables())!;
    assert.match(pending.steps[pending.steps.length - 3], /0\.13\.0/);
    assert.match(pending.steps[pending.steps.length - 2], /0\.15\.0: body format/);
    assert.match(pending.steps[pending.steps.length - 1], /0\.17\.0: change log/);
    await run(db, pending.sql);
    await run(db, pending.sql); // safe to run again
    assert.deepEqual([(await repo.inspect()).schemaVersion, (await repo.inspect()).missingTables], [SCHEMA_VERSION, []]);
    // Schema 8: the body format is kept on a real database.
    const fmtCms = createCms({ repo, collections: [defineCollection({ slug: "pages", label: "Pages", visibility: "public", body: { formats: ["markdown", "html"] } }), guide] });
    await fmtCms.create(admin, "pages", { slug: "landing", title: "Landing", format: "html", body: "<h1>Hi</h1>" });
    assert.equal((await fmtCms.get(admin, "pages", "landing", { draft: true })).format, "html");
    assert.equal((await fmtCms.update(admin, "pages", "landing", { title: "Landing 2" })).format, "html");
    await fmtCms.create(admin, "pages", { slug: "md", title: "Md", body: "x" });
    assert.equal((await fmtCms.get(admin, "pages", "md", { draft: true })).format, undefined);

    // Automations: made, run by cron, the run is kept, deleting takes the runs along.
    const made = await cms.automations.create(admin, { name: "Tag", enabled: true, trigger: { event: "doc.published", collection: "guide" }, conditions: [{ field: "title", op: "contains", value: "Hello" }], actions: [{ type: "add_keyword", name: "new" }] });
    await cms.create(admin, "guide", { slug: "a", title: "Hello" }, { publish: true });
    await cms.create(admin, "guide", { slug: "b", title: "Other" }, { publish: true });
    await new Promise((r) => setTimeout(r, 50));
    await cms.cron();
    assert.deepEqual((await cms.get(admin, "guide", "a", { draft: true })).keywords, ["new"]);
    const runs = await cms.automations.runs(admin, made.id);
    assert.deepEqual(runs.map((r) => r.state).sort(), ["ok", "skipped"]);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_records where kind = 'automation_run'"))[0].n, 2);
    await cms.automations.remove(admin, made.id);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_records"))[0].n, 0);

    // Roles: a writer may save and not publish; the same name twice is refused by the database.
    const writer: Actor = { kind: "user", id: "u7", label: "Park", isAdmin: false };
    const role = await cms.roles.create(admin, { name: "Writers", permissions: { guide: { write: true } } });
    await assert.rejects(cms.roles.create(admin, { name: "writers" }), (e: unknown) => isCmsError(e) && e.code === "name_taken");
    await cms.roles.addMember(admin, role.id, { id: "u7", label: "Park" });
    await cms.update(writer, "guide", "b", { title: "Other 2" });
    await assert.rejects(cms.publish(writer, "guide", "b"), (e: unknown) => isCmsError(e) && e.code === "forbidden_publish");
    await cms.roles.remove(admin, role.id);
    await assert.rejects(cms.update(writer, "guide", "b", { title: "Other 3" }), (e: unknown) => isCmsError(e) && e.code === "forbidden_write");
  } finally {
    await close();
  }
});

test("db: retention deletes old audit entries, hit counts and revoked keys; a rotated key works until its grace time ends", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
    const repo = new DrizzleRepo(db);
    const cms = createCms({ repo, collections: [guide], now: () => new Date(clock.t), cronSecret: "c".repeat(32), retention: { auditDays: 30, hitsDays: 7, revokedKeysDays: 10, deliveriesDays: 5 } });
    const doc = await cms.create(admin, "guide", { slug: "a", title: "A" }, { publish: true });
    await cms.recordHits([doc.id]);
    const first = await cms.createKey(admin, { name: "deploy", scopes: ["read"], rateLimit: 5, allowedIps: ["10.0.0.0/8"] });
    const next = await cms.rotateKey(admin, first.key.id, { graceMinutes: 30 });
    assert.ok((await cms.authenticateKey(first.secret)) && (await cms.authenticateKey(next.secret)));
    assert.deepEqual(await cms.keyPolicy(next.key.id), { perMinute: 5, allowedIps: ["10.0.0.0/8"] });
    clock.t += 31 * 60_000;
    assert.equal(await cms.authenticateKey(first.secret), null);
    assert.deepEqual((await cms.listKeys(admin)).map((k) => [k.name, k.revokedReason, k.rotatedTo === next.key.id]), [["deploy", null, false], ["deploy", "rotated", true]]);
    await new Promise((r) => setTimeout(r, 50));

    clock.t += 8 * 86_400_000;
    const dry = await cms.retention.run(admin, { dryRun: true });
    assert.deepEqual(dry.items.map((i) => [i.what, i.rows]), [["audit", 0], ["hits", 1], ["keys", 0], ["deliveries", 0]]);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_hits"))[0].n, 1);
    clock.t += 30 * 86_400_000;
    const auditBefore = (await rows<{ n: number }>(db, "select count(*)::int as n from cms_audit"))[0].n;
    const real = await cms.retention.run(admin);
    assert.deepEqual(real.items.map((i) => [i.what, i.rows]), [["audit", auditBefore], ["hits", 1], ["keys", 1], ["deliveries", 0]]);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_hits"))[0].n, 0);
    assert.deepEqual((await cms.listKeys(admin)).map((k) => k.id), [next.key.id]);
    assert.ok(await cms.authenticateKey(next.secret));
  } finally {
    await close();
  }
});

test("db: schema 8 → 9 adds the change log and indexes; paging, the log and doctor --fix work on a real database", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    // A 0.16.0 database: no change log, none of the new indexes.
    await run(db, `DROP TABLE cms_changes; DROP INDEX cms_documents_list_idx; DROP INDEX cms_audit_doc_idx; UPDATE cms_meta SET value = '8'::jsonb WHERE key = 'schema_version';`);
    const repo = new DrizzleRepo(db);
    const before = await repo.inspect();
    assert.deepEqual([before.schemaVersion, before.missingTables], [8, ["cms_changes"]]);
    const pending = migrationSql(before, cmsTables())!;
    assert.deepEqual(pending.steps, ["agent-cms 0.17.0: change log (catching up across servers), indexes for lists, trash, history and jobs"]);
    await run(db, pending.sql);
    const after = await repo.inspect();
    assert.deepEqual([after.schemaVersion, after.missingTables, after.missingIndexes], [SCHEMA_VERSION, [], []]);
    // Only an index missing: migrate check still offers the step (it is idempotent).
    await run(db, `DROP INDEX cms_jobs_done_idx;`);
    const idxOnly = await repo.inspect();
    assert.deepEqual(idxOnly.missingIndexes, ["cms_jobs_done_idx"]);
    await run(db, migrationSql(idxOnly, cmsTables())!.sql);
    assert.deepEqual((await repo.inspect()).missingIndexes, []);

    let t = Date.parse("2026-11-22T00:00:00Z");
    const cms = createCms({ repo, collections: [guide], cronSecret: "c".repeat(32), now: () => new Date((t += 1000)) });
    for (let i = 0; i < 12; i++) await cms.create(admin, "guide", { slug: `p${String(i).padStart(2, "0")}`, title: `Post ${i}`, summary: i === 3 ? "100% sure_thing" : "", body: "x\n" }, { publish: true });
    // Keyset pages on Postgres (microsecond columns, millisecond cursors): nothing twice, nothing skipped.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: Awaited<ReturnType<typeof cms.page>> = await cms.page(anon, "guide", { limit: 5, cursor });
      assert.equal(p.total, 12);
      seen.push(...p.docs.map((d) => d.slug));
      cursor = p.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => `p${String(11 - i).padStart(2, "0")}`));
    // LIKE wildcards in a search are taken literally.
    assert.deepEqual((await cms.page(anon, "guide", { q: "100%" })).docs.map((d) => d.slug), ["p03"]);
    assert.deepEqual((await cms.page(anon, "guide", { q: "1%s" })).docs.map((d) => d.slug), []);
    assert.deepEqual((await cms.page(anon, "guide", { q: "Post_1" })).docs.map((d) => d.slug), []);
    assert.deepEqual((await cms.page(anon, "guide", { q: "sure_thing" })).docs.map((d) => d.slug), ["p03"]);
    // Readers search the published copy; editors the draft.
    await cms.update(admin, "guide", "p05", { title: "Renamed draft" });
    assert.deepEqual((await cms.page(anon, "guide", { q: "renamed" })).docs, []);
    assert.deepEqual((await cms.page(admin, "guide", { drafts: true, q: "renamed" })).docs.map((d) => d.slug), ["p05"]);

    // The change log: numbered rows, read after a number, pruned by cron.
    await new Promise((r) => setTimeout(r, 50));
    const last = await repo.lastChange();
    assert.equal(last, 25, "12 creates, 12 publishes, 1 save");
    const log = await repo.changesSince(20, 10);
    assert.deepEqual(log.map((r) => r.seq), [21, 22, 23, 24, 25]);
    assert.equal(log.at(-1)!.event, "doc.updated");
    assert.equal(typeof log[0].origin, "string");
    t += 8 * 86_400_000;
    await cms.cron();
    assert.equal(await repo.lastChange(), 0, "pruned (the sequence keeps counting from where it was)");
    assert.equal(await repo.appendChange({ event: "doc.updated", collection: "guide", slug: "p01", version: 2, origin: "x", data: {} }), 26);

    // doctor --fix: rows that point at nothing go, the rest stays.
    const docId = (await cms.get(admin, "guide", "p01", { draft: true })).id;
    // A database made without the foreign keys (the app wrote its own migrations): left-over rows.
    await run(db, `SET session_replication_role = replica; INSERT INTO cms_comments (document_id, body, author_kind, author_label) VALUES (gen_random_uuid(), 'lost', 'user', 'x'), ('${docId}', 'kept', 'user', 'x'); SET session_replication_role = origin;`);
    const dirty = await repo.inspect();
    assert.equal(dirty.orphanComments, 1);
    const out: string[] = [];
    const code = await runCli(["doctor", "--fix"], { db, cwd: "/nonexistent", out: (l: string) => out.push(l), err: (l: string) => out.push(l) });
    assert.equal(code, 0, out.join("\n"));
    assert.match(out[0], /removed 0 version row\(s\), 0 file use\(s\) and 1 comment\(s\)/);
    assert.ok(out.some((l) => l.includes("all indexes exist")));
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from cms_comments"))[0].n, 1);
  } finally {
    await close();
  }
});

test("db: tenants live in schemas of their own; one never sees another's documents", async () => {
  const { db, close } = await freshDb();
  try {
    let made = 0;
    const handler = createTenantHandler({
      resolve: (req) => req.headers.get("x-site"),
      create: async (tenant) => {
        if (tenant === "ghost") throw new Error("no such site");
        made++;
        await migrateTenant(db, tenant);
        const cms = createCms({ repo: new DrizzleRepo(db, { tables: tenantTables(tenant) }), collections: [guide] });
        return createCmsHandler({ cms, resolveUser: async () => ({ kind: "user" as const, id: "u1", label: "Admin", isAdmin: true }), trustedOrigins: ["http://app.test"] });
      },
    });
    const call = (site: string | null, path: string, init: RequestInit = {}) =>
      handler(new Request(`http://app.test/api/cms${path}`, { ...init, headers: { ...(site ? { "x-site": site } : {}), origin: "http://app.test", "content-type": "application/json" } }));
    const put = await call("acme", "/collections/guide", { method: "POST", body: JSON.stringify({ doc: { slug: "hello", title: "Acme hello", body: "x" }, publish: true }) });
    assert.equal(put.status, 201, await put.clone().text());
    assert.equal((await call("acme", "/collections/guide/hello")).status, 200);
    assert.equal((await call("beta-2", "/collections/guide/hello")).status, 404, "the other site has its own documents");
    assert.equal((await call(null, "/collections/guide/hello")).status, 404);
    assert.equal((await call("Bad Name", "/collections/guide/hello")).status, 404);
    assert.equal((await call("ghost", "/collections/guide/hello")).status, 404);
    await call("acme", "/collections/guide/hello");
    assert.equal(made, 2, "each site's CMS is made once");
    assert.deepEqual(handler.tenants().sort(), ["acme", "beta-2"]);
    const schemas = await rows<{ nspname: string }>(db, "select nspname from pg_namespace where nspname like 'tenant\\_%' order by 1");
    assert.deepEqual(schemas.map((r) => r.nspname), ["tenant_acme", "tenant_beta_2"]);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from tenant_acme.cms_documents"))[0].n, 1);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from tenant_beta_2.cms_documents"))[0].n, 0);
  } finally {
    await close();
  }
});

test("db: a driver without transactions (neon-http) still saves, once, with a warning", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    // What neon-http does: refuse a transaction before running anything.
    const noTx = new Proxy(db, { get: (t, k) => (k === "transaction" ? () => Promise.reject(new Error("No transactions support in neon-http driver")) : Reflect.get(t, k)) }) as Db;
    const warned: string[] = [];
    const repo = new DrizzleRepo(noTx, { warn: (m) => warned.push(m) });
    const cms = createCms({ repo, collections: [guide] });
    await cms.create(admin, "guide", { slug: "a", title: "A", body: "x" }, { publish: true });
    await cms.update(admin, "guide", "a", { title: "B" });
    assert.equal((await cms.get(admin, "guide", "a", { draft: true })).title, "B");
    assert.equal(warned.length, 1);
    // Version checks still hold without a transaction.
    await assert.rejects(cms.update(admin, "guide", "a", { title: "C" }, { expectedVersion: 1 }), (e: unknown) => isCmsError(e) && e.code === "conflict_version");
    // transactions: true does not hide the error.
    await assert.rejects(new DrizzleRepo(noTx, { transactions: true }).tx(async () => 1), /No transactions support/);
    // What must be all or nothing (a release) is refused rather than done half way.
    const rel = await cms.releases.create(admin, { name: "Launch" });
    await cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "a" }]);
    await assert.rejects(cms.releases.publish(admin, rel.id), (e: unknown) => isCmsError(e) && e.code === "transactions_required");
    assert.equal((await cms.get(admin, "guide", "a", { draft: true })).publishedVersion, 1, "nothing went out");
  } finally {
    await close();
  }
});

test("db: connectPostgres opens pglite in memory and gives a working repo", async () => {
  const c = await connectPostgres("memory:");
  try {
    assert.equal(c.driver, "pglite");
    assert.equal(c.signal, null);
    await run(c.db, cmsDdl());
    const cms = createCms({ repo: c.repo, collections: [guide] });
    await cms.create(admin, "guide", { slug: "a", title: "A", body: "x" });
    assert.equal((await cms.page(admin, "guide", { drafts: true })).total, 1);
  } finally {
    await c.close();
  }
});

test("db: migrate check / apply include plugin tables from the config", async () => {
  const { db, close } = await freshDb();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  try {
    await run(db, cmsDdl());
    const dir = mkdtempSync(join(tmpdir(), "acms-plug-"));
    writeFileSync(join(dir, "agent-cms.config.mjs"), `export default { plugins: [{ name: "stars", sql: ['CREATE TABLE IF NOT EXISTS "stars" ("doc" text PRIMARY KEY, "n" integer NOT NULL DEFAULT 0)'] }, { name: "noop" }] };`);
    const out: string[] = [];
    const err: string[] = [];
    const io = { db, cwd: dir, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    assert.equal(await runCli(["migrate", "check"], io), 1);
    assert.match(out.join("\n"), /-- plugin stars\nCREATE TABLE IF NOT EXISTS "stars"/);
    assert.match(err.join("\n"), /plugin tables are missing/);
    out.length = 0;
    assert.equal(await runCli(["migrate", "apply"], io), 0);
    assert.match(out.join("\n"), /Plugin tables: stars\./);
    assert.equal((await rows<{ n: number }>(db, "select count(*)::int as n from stars"))[0].n, 0);
    out.length = 0;
    assert.equal(await runCli(["migrate", "check"], io), 0);
    assert.match(out.join("\n"), /up to date/);
    // The plugin's SQL changes after it was applied: its table exists, so check says a migration is needed.
    // (A second folder: the config loader keeps modules it has loaded.)
    const dir2 = mkdtempSync(join(tmpdir(), "acms-plug2-"));
    writeFileSync(join(dir2, "agent-cms.config.mjs"), `export default { plugins: [{ name: "stars", sql: ['CREATE TABLE IF NOT EXISTS "stars" ("doc" text PRIMARY KEY, "n" integer NOT NULL DEFAULT 0, "by" text)'] }] };`);
    err.length = 0;
    const io2 = { ...io, cwd: dir2 };
    assert.equal(await runCli(["migrate", "check"], io2), 1);
    assert.match(err.join("\n"), /plugin stars: its SQL changed since it was applied/);
    // After the person's own ALTER TABLE, apply records the new SQL and check is quiet again.
    await run(db, 'ALTER TABLE "stars" ADD COLUMN IF NOT EXISTS "by" text');
    assert.equal(await runCli(["migrate", "apply"], io2), 0);
    assert.equal(await runCli(["migrate", "check"], io2), 0);
  } finally {
    await close();
  }
});

test("db: versions in pages come from the database, newest first", async () => {
  const { db, close } = await freshDb();
  try {
    await run(db, cmsDdl());
    const repo = new DrizzleRepo(db);
    const cms = createCms({ repo, collections: [guide] });
    await cms.create(admin, "guide", { slug: "a", title: "v1", body: "x" });
    for (let n = 2; n <= 5; n++) await cms.update(admin, "guide", "a", { title: `v${n}` });
    const p1 = await cms.versionPage(admin, "guide", "a", { limit: 2, summary: true });
    assert.deepEqual([p1.versions.map((v) => v.version), p1.total, p1.nextCursor], [[5, 4], 5, "4"]);
    const p3 = await cms.versionPage(admin, "guide", "a", { limit: 3, cursor: "4" });
    assert.deepEqual([p3.versions.map((v) => v.version), p3.nextCursor], [[3, 2, 1], null]);
  } finally {
    await close();
  }
});

test("splitSql keeps DO $$ bodies and quoted semicolons together", () => {
  const parts = splitSql("SELECT 'a;b'; -- c;d\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT 2");
  assert.deepEqual(parts, ["SELECT 'a;b'", "DO $$ BEGIN PERFORM 1; END $$", "SELECT 2"]);
});
