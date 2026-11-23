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
  /**
   * Days a redirect's visits per day are kept (with `redirects` on). Default 90: the redirects screen
   * shows 30 days and `GET /redirects/:id/hits` reads at most 90. 0 keeps them forever. The running
   * total on each redirect stays either way.
   */
  redirectHitsDays?: number;
  /**
   * Days form submissions are kept (with `forms` on), with their files. Default 365. 0 keeps
   * them forever.
   */
  submissionsDays?: number;
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
  /** Redirects are on (their daily visits get the 90-day default). */
  redirects?: boolean;
  /** Forms are on (submissions get the 365-day default). */
  forms?: boolean;
  /** Deletes submissions sent before `before` with their files (they live in private storage); returns how many. */
  purgeSubmissions?: (before: string) => Promise<number>;
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
      { what: "redirect_hits", days: ctx.redirects ? (o.redirectHitsDays ?? 90) : o.redirectHitsDays },
      { what: "form_submissions", days: ctx.forms ? (o.submissionsDays ?? 365) : o.submissionsDays },
    ];
    return out.filter((r): r is { what: PruneTarget; days: number } => typeof r.days === "number" && Number.isFinite(r.days) && r.days > 0);
  };

  async function sweep(dryRun: boolean): Promise<RetentionReport> {
    const now = ctx.now();
    const items: RetentionReport["items"] = [];
    for (const r of rules()) {
      const cut = new Date(now.getTime() - r.days * DAY);
      // Hit counts (and redirect visits) are per calendar day in the CMS's time zone.
      const before = r.what === "hits" || r.what === "redirect_hits" ? ctx.dayIn(ctx.timeZone, cut) : cut.toISOString();
      const rows = r.what === "form_submissions" && !dryRun && ctx.purgeSubmissions ? await ctx.purgeSubmissions(before) : await ctx.repo.prune(r.what, before, dryRun);
      items.push({ ...r, before, rows });
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
