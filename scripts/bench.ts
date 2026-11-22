/**
 * How fast is the CMS with a lot of content? (106, 0.17.0)
 *
 *   npm run bench                         # 10,000 documents in PGlite (Postgres in the process)
 *   npm run bench -- --docs 50000         # more
 *   DATABASE_URL=postgres://… npm run bench   # a real server (uses tables with the prefix bench_; drops them after)
 *   npm run bench -- --json > out.json    # for comparing runs
 *
 * Measures what readers and editors do most: read one document, page through a list (first and
 * deep page), search, save, publish, and the same reads through the read cache. Prints p50, p95
 * and operations per second. Numbers depend on the machine; compare runs on the same one.
 */
import { performance } from "node:perf_hooks";
import { connectPostgres } from "../src/db";
import { memoryCache } from "../src/changes";
import { createCms, defineCollection } from "../src/cms";
import { cmsDdl, cmsTables, splitSql } from "../src/tables";
import { DrizzleRepo } from "../src/drizzle-repo";
import { sql } from "drizzle-orm";
import type { Actor } from "../src/types";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DOCS = Number(arg("docs", "10000"));
const RUNS = Number(arg("runs", "200"));
const JSON_OUT = process.argv.includes("--json");
const log = (s: string) => !JSON_OUT && console.log(s);

const admin: Actor = { kind: "user", id: "bench", label: "Bench", isAdmin: true };
const anon: Actor = { kind: "anonymous" };
const WORDS = "content agent markdown release editor search publish draft version media library schedule preview webhook review comment index cache page".split(" ");
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(seed * 31 + i * 7) % WORDS.length]).join(" ");

async function main() {
  const url = process.env.DATABASE_URL ?? "memory:";
  const conn = await connectPostgres(url, { listen: false });
  const tables = cmsTables({ prefix: url === "memory:" ? "cms_" : "bench_" });
  for (const s of splitSql(cmsDdl(tables))) await conn.db.execute(sql.raw(s));
  const repo = new DrizzleRepo(conn.db, { tables });
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `/guide/${d.slug}`, categories: ["a", "b", "c", "d"] });
  const cms = createCms({ repo, collections: [guide], warn: () => {} });
  const cached = createCms({ repo, collections: [guide], warn: () => {}, cache: memoryCache({ max: 5000 }), changes: { log: false } });

  log(`[bench] ${conn.driver}, seeding ${DOCS} documents…`);
  const t0 = performance.now();
  // Straight into the tables (the API path is measured below); 500 rows a statement.
  const T = tables;
  const now = Date.now();
  for (let i = 0; i < DOCS; i += 500) {
    const rows = [];
    for (let j = i; j < Math.min(DOCS, i + 500); j++) {
      const body = `## Part ${j}\n\n${words(120, j)}\n\n- ${words(8, j + 1)}\n- ${words(8, j + 2)}\n`;
      const at = new Date(now - j * 60_000);
      rows.push({ collection: "guide", slug: `doc-${j}`, title: `Document ${j} ${words(3, j)}`, summary: words(12, j), body, category: ["a", "b", "c", "d"][j % 4], status: "published" as const, version: 1, publishedVersion: 1, publishedAt: at, updatedAt: at, createdAt: at, published: { title: `Document ${j} ${words(3, j)}`, summary: words(12, j), body, category: ["a", "b", "c", "d"][j % 4], fields: {} } });
    }
    const ids = await conn.db.insert(T.documents).values(rows as never).returning({ id: T.documents.id });
    await conn.db.insert(T.versions).values(ids.map((r, k) => ({ documentId: r.id, version: 1, snapshot: rows[k].published, authorKind: "system", authorLabel: "bench" })) as never);
  }
  log(`[bench] seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const results: { name: string; p50: number; p95: number; opsPerSec: number }[] = [];
  async function measure(name: string, fn: (i: number) => Promise<unknown>, runs = RUNS) {
    for (let i = 0; i < Math.min(10, runs); i++) await fn(i); // warm up
    const times: number[] = [];
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      await fn(i);
      times.push(performance.now() - s);
    }
    const total = performance.now() - start;
    times.sort((a, b) => a - b);
    const r = { name, p50: times[Math.floor(runs * 0.5)], p95: times[Math.floor(runs * 0.95)], opsPerSec: (runs / total) * 1000 };
    results.push(r);
    log(`${name.padEnd(34)} p50 ${r.p50.toFixed(2).padStart(8)} ms   p95 ${r.p95.toFixed(2).padStart(8)} ms   ${r.opsPerSec.toFixed(0).padStart(6)}/s`);
  }

  const pick = (i: number) => `doc-${(i * 7919) % DOCS}`;
  await measure("read one (reader)", (i) => cms.get(anon, "guide", pick(i)));
  await measure("read one (reader, cached)", (i) => cached.get(anon, "guide", pick(i % 50)));
  await measure("list first page (reader)", () => cms.page(anon, "guide", { limit: 20 }));
  await measure("list first page (reader, cached)", () => cached.page(anon, "guide", { limit: 20 }));
  let cursor: string | null = null;
  await measure("list next page (reader)", async () => {
    const p: Awaited<ReturnType<typeof cms.page>> = await cms.page(anon, "guide", { limit: 20, cursor });
    cursor = p.nextCursor;
  });
  await measure("list filtered + text (editor)", (i) => cms.page(admin, "guide", { drafts: true, limit: 20, category: "b", q: WORDS[i % WORDS.length] }));
  await measure("search (first builds the index)", (i) => cms.search(anon, ["guide"], WORDS[i % WORDS.length]), Math.min(RUNS, 50));
  await measure("save a draft", (i) => cms.update(admin, "guide", pick(i), { summary: `edited ${i}` }), Math.min(RUNS, 100));
  await measure("publish", (i) => cms.publish(admin, "guide", pick(i)), Math.min(RUNS, 100));

  await cms.settle();
  await cached.settle();
  if (JSON_OUT) console.log(JSON.stringify({ driver: conn.driver, docs: DOCS, runs: RUNS, node: process.version, results }, null, 2));
  if (url !== "memory:") await conn.db.execute(sql.raw(`DROP TABLE IF EXISTS ${["changes", "comments", "asset_refs", "assets", "versions", "audit", "hits", "presence", "jobs", "webhook_deliveries", "webhooks", "records", "saved_filters", "releases", "api_keys", "meta", "documents"].map((n) => `"bench_${n}"`).join(", ")} CASCADE`));
  await conn.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
