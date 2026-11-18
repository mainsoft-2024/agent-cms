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
import { cmsDdl, cmsTables, SCHEMA_VERSION, splitSql } from "../tables";
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
      ["blog_api_keys", "blog_audit", "blog_documents", "blog_hits", "blog_meta", "blog_versions"]
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

test("splitSql keeps DO $$ bodies and quoted semicolons together", () => {
  const parts = splitSql("SELECT 'a;b'; -- c;d\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT 2");
  assert.deepEqual(parts, ["SELECT 'a;b'", "DO $$ BEGIN PERFORM 1; END $$", "SELECT 2"]);
});
