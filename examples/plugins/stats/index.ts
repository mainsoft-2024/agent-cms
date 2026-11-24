/**
 * stats: counts how often published documents are read.
 *
 *   import stats from "./plugins/stats";
 *   createCms({ ..., plugins: [stats({ top: 10 })] });
 *
 * - an `afterRead` hook counts each published document a reader opens (in memory, cheap);
 * - the job `stats.rollup` adds those counts to the plugin's store (the next cron call runs it);
 * - `doc.published` notes when a document went out, so it shows with 0 reads;
 * - `GET /api/cms/stats/summary` and the tool `stats_summary` give the totals;
 * - the admin page (`./admin.tsx`) shows them.
 *
 * Counts wait in memory until the job runs. On serverless hosts each instance keeps its own
 * until then; a count lost to a cold start is a few reads, which is fine for a rough number.
 * `ctx.store` lists up to 500 keys: a site with more documents keeps its counts in a table of
 * its own (the plugin's `sql`).
 */
import { definePlugin, type Actor } from "@mainsoft/agent-cms";
import { z } from "zod";

/** What the route and the tool answer. */
export interface StatsSummary {
  total: number;
  /** The most read documents, most first. */
  top: { collection: string; slug: string; reads: number }[];
  /** Published documents nobody has read yet. */
  unread: { collection: string; slug: string; publishedAt: string }[];
}

export default definePlugin({
  name: "stats",
  version: "1.0.0",
  engine: ">=0.24",
  options: z.object({
    /** How many documents `top` lists. */
    top: z.number().int().min(1).max(100).default(10),
    /** Collections to count. Default: all. */
    collections: z.array(z.string()).optional(),
  }),
  setup(ctx, options) {
    const pending = new Map<string, number>();
    let queued = false;

    // 1. Count: one read of a published document by a person or a visitor (not lists, drafts or jobs).
    ctx.hook(
      "afterRead",
      (doc, { actor, draft, list }) => {
        if (draft || list || actor.kind === "system" || doc.publishedVersion == null) return;
        const key = `${doc.collection}/${doc.slug}`;
        pending.set(key, (pending.get(key) ?? 0) + 1);
        if (!queued) {
          queued = true;
          // Not awaited: a read never waits for this. The next cron call runs the job.
          ctx.enqueue("rollup").catch((err: unknown) => {
            queued = false;
            ctx.log("warn", "could not queue the rollup", { error: String(err) });
          });
        }
      },
      options.collections ? { collections: options.collections } : undefined
    );

    // 2. Add what was counted to the store.
    ctx.job("rollup", {
      retryAfter: [30, 120],
      async run() {
        const batch = [...pending];
        pending.clear();
        queued = false;
        for (const [key, n] of batch) {
          await ctx.store.set(`reads:${key}`, ((await ctx.store.get<number>(`reads:${key}`)) ?? 0) + n);
        }
        if (batch.length) ctx.log("info", "rollup", { documents: batch.length });
      },
    });

    // 3. A document went out: remember when, so it shows as unread.
    ctx.on("doc.published", async (e) => {
      if (!e.collection || !e.slug) return;
      if (options.collections && !options.collections.includes(e.collection)) return;
      await ctx.store.set(`published:${e.collection}/${e.slug}`, new Date().toISOString());
    });

    // The numbers name documents across collections (drafts' neighbours, rules per document),
    // so only admins see them. Narrow it per document yourself if writers need it.
    async function summary(): Promise<StatsSummary> {
      const reads = (await ctx.store.list<number>("reads:"))
        .map((r) => {
          const [collection, ...rest] = r.key.slice("reads:".length).split("/");
          return { collection, slug: rest.join("/"), reads: r.value };
        });
      const seen = new Set(reads.map((r) => `${r.collection}/${r.slug}`));
      const unread = (await ctx.store.list<string>("published:"))
        .map((r) => ({ key: r.key.slice("published:".length), publishedAt: r.value }))
        .filter((r) => !seen.has(r.key))
        .map((r) => {
          const [collection, ...rest] = r.key.split("/");
          return { collection, slug: rest.join("/"), publishedAt: r.publishedAt };
        });
      return {
        total: reads.reduce((a, r) => a + r.reads, 0),
        top: reads.sort((a, b) => b.reads - a.reads).slice(0, options.top),
        unread,
      };
    }

    // 4. The numbers, for admins (the admin page reads this).
    const isAdmin = (a: Actor) => a.kind !== "anonymous" && "isAdmin" in a && a.isAdmin === true;
    ctx.route("GET", "summary", async ({ actor }) => {
      if (actor.kind === "anonymous") return Response.json({ error: "sign in first" }, { status: 401 });
      if (!isAdmin(actor)) return Response.json({ error: "admins only" }, { status: 403 });
      return Response.json(await summary());
    });

    // 5. The same for agents.
    ctx.tool({
      name: "stats_summary",
      description: "How often published documents were read: the total, the most read, and published ones nobody has read yet.",
      input: z.object({}),
      run: (actor) => {
        if (!isAdmin(actor)) throw new Error("admins only");
        return summary();
      },
    });
  },
});
