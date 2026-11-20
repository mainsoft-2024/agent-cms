/**
 * Retention: how long the CMS keeps what piles up. Nothing here touches documents or their
 * versions (a collection's `versions.max` decides those) or the trash (`trash.days`).
 *
 *   createCms({ retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90 } })
 *
 * A cron call runs it once a day. `cms.retention.run(actor, { dryRun: true })`, `POST /retention`
 * and `npx @mainsoft/agent-cms retention --dry-run` say how many rows would go without deleting.
 */
import type { CmsRepo, PruneTarget } from "./repo";
import type { Actor } from "./types";

export interface RetentionOptions {
  /** Days the audit log is kept. Default: forever. */
  auditDays?: number;
  /** Days read counts (`cms_hits`) are kept. Default: forever. The dashboard reads at most 30 days. */
  hitsDays?: number;
  /** Days a revoked API key stays in the list. Default: forever. */
  revokedKeysDays?: number;
  /** Days webhook deliveries are kept, when that should be shorter than the built-in 30. */
  deliveriesDays?: number;
}

export interface RetentionReport {
  dryRun: boolean;
  at: string;
  items: { what: PruneTarget; days: number; before: string; rows: number }[];
}

export interface RetentionContext {
  repo: CmsRepo;
  options: RetentionOptions;
  now: () => Date;
  timeZone: string;
  dayIn: (timeZone: string, d: Date) => string;
  assertAdmin: (actor: Actor) => void;
  audit: (actor: Actor, detail: Record<string, unknown>) => void;
}

const DAY = 86_400_000;
const META = "retention_ran_on";

export function createRetention(ctx: RetentionContext) {
  const rules = (): { what: PruneTarget; days: number }[] => {
    const o = ctx.options;
    const out: { what: PruneTarget; days: number | undefined }[] = [
      { what: "audit", days: o.auditDays },
      { what: "hits", days: o.hitsDays },
      { what: "keys", days: o.revokedKeysDays },
      { what: "deliveries", days: o.deliveriesDays },
    ];
    return out.filter((r): r is { what: PruneTarget; days: number } => typeof r.days === "number" && Number.isFinite(r.days) && r.days > 0);
  };

  async function sweep(dryRun: boolean): Promise<RetentionReport> {
    const now = ctx.now();
    const items: RetentionReport["items"] = [];
    for (const r of rules()) {
      const cut = new Date(now.getTime() - r.days * DAY);
      // Hit counts are per calendar day in the CMS's time zone.
      const before = r.what === "hits" ? ctx.dayIn(ctx.timeZone, cut) : cut.toISOString();
      items.push({ ...r, before, rows: await ctx.repo.prune(r.what, before, dryRun) });
    }
    return { dryRun, at: now.toISOString(), items };
  }

  return {
    /** The rules in force (those with a number of days). */
    rules,
    /** Delete what is older than the rules allow, or with `dryRun` count it. Admins only. */
    async run(actor: Actor, o: { dryRun?: boolean } = {}): Promise<RetentionReport> {
      ctx.assertAdmin(actor);
      const report = await sweep(!!o.dryRun);
      if (!o.dryRun) ctx.audit(actor, { items: report.items.map(({ what, rows }) => ({ what, rows })) });
      return report;
    },
    /** Called by the cron run: at most once per calendar day, and only when a rule is set. */
    async tick(): Promise<RetentionReport | null> {
      if (!rules().length) return null;
      const today = ctx.dayIn(ctx.timeZone, ctx.now());
      if ((await ctx.repo.getMeta(META)) === today) return null;
      await ctx.repo.setMeta(META, today);
      const report = await sweep(false);
      if (report.items.some((i) => i.rows > 0)) ctx.audit({ kind: "system", label: "retention" } as Actor, { items: report.items.map(({ what, rows }) => ({ what, rows })) });
      return report;
    },
  };
}

export type Retention = ReturnType<typeof createRetention>;
