/**
 * Background jobs. The library runs inside the host app and has no timer of its own, so work for
 * later is written to a table and run when somebody calls: the `/_cron` route, `agent-cms cron`,
 * or `cms.jobs.run()` from the app.
 */
import type { CmsRepo } from "./repo";
import type { CmsJob } from "./types";

export interface JobKind<P = Record<string, unknown>> {
  run(payload: P, job: CmsJob): unknown | Promise<unknown>;
  /** Seconds to wait after the 1st, 2nd, … failed attempt. Its length is the number of retries. Default: none. */
  retryAfter?: readonly number[];
}

export interface JobsRun {
  /** Jobs started in this call. */
  ran: number;
  ok: number;
  /** Failed and put back for another attempt. */
  retried: number;
  /** Failed for the last time. They stay in the table with `lastError`. */
  failed: number;
  /** Still waiting when the call returned (not due yet, or the time budget ran out). */
  waiting: number;
}

export interface JobsContext {
  repo: CmsRepo;
  now: () => Date;
  report: (err: unknown, where: string) => void;
  event?: (e: { type: "job"; kind: string; id: string; ok: boolean; attempt: number; ms: number; error?: string }) => void;
  /** A kind whose owner is not running (a plugin that failed, a built-in turned off): its jobs wait without using an attempt. */
  paused?: (kind: string) => boolean;
}

export const JOB_BATCH = 5;
/** How long a taken job is held. A job still running after this may be started again by another caller. */
export const JOB_LOCK_MS = 120_000;
export const JOB_DONE_KEEP_DAYS = 7;

export function createJobs(ctx: JobsContext) {
  const kinds = new Map<string, JobKind<any>>();
  const iso = (d: Date) => d.toISOString();

  return {
    /** Register what a kind of job does. Plugins call this through `ctx.job()`. */
    define<P = Record<string, unknown>>(kind: string, def: JobKind<P>) {
      if (kinds.has(kind)) throw new Error(`[agent-cms] job kind "${kind}" is defined twice`);
      kinds.set(kind, def);
    },
    kinds: () => [...kinds.keys()],
    async enqueue(kind: string, payload: Record<string, unknown> = {}, o: { runAt?: Date | string } = {}): Promise<CmsJob> {
      const def = kinds.get(kind);
      if (!def) throw new Error(`[agent-cms] unknown job kind "${kind}"`);
      const at = iso(ctx.now());
      return ctx.repo.insertJob({ kind, payload, runAt: o.runAt ? iso(new Date(o.runAt)) : at, maxAttempts: 1 + (def.retryAfter?.length ?? 0), createdAt: at });
    },
    /** Run what is due, for at most about `budgetMs` (a batch that has started is finished). */
    async run(o: { budgetMs?: number } = {}): Promise<JobsRun> {
      const started = Date.now();
      const out: JobsRun = { ran: 0, ok: 0, retried: 0, failed: 0, waiting: 0 };
      const one = async (job: CmsJob) => {
        if (ctx.paused?.(job.kind)) {
          // Put back as it was (the claim counted an attempt: give it back), and try again in a minute.
          out.waiting++;
          await ctx.repo.updateJob(job.id, { runAt: iso(new Date(ctx.now().getTime() + 60_000)), lockedUntil: null, attempts: Math.max(0, job.attempts - 1) });
          return;
        }
        const def = kinds.get(job.kind);
        const t0 = Date.now();
        let error: string | null = null;
        try {
          if (!def) throw new Error(`no handler for the job kind "${job.kind}"`);
          await def.run(job.payload, job);
        } catch (e) {
          error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
        }
        out.ran++;
        const at = ctx.now();
        if (error === null) {
          out.ok++;
          await ctx.repo.updateJob(job.id, { doneAt: iso(at), lockedUntil: null, lastError: null });
        } else if (def && job.attempts < job.maxAttempts) {
          out.retried++;
          const wait = def.retryAfter?.[job.attempts - 1] ?? 60;
          await ctx.repo.updateJob(job.id, { runAt: iso(new Date(at.getTime() + wait * 1000)), lockedUntil: null, lastError: error });
        } else {
          out.failed++;
          await ctx.repo.updateJob(job.id, { failedAt: iso(at), lockedUntil: null, lastError: error });
        }
        ctx.event?.({ type: "job", kind: job.kind, id: job.id, ok: error === null, attempt: job.attempts, ms: Date.now() - t0, ...(error ? { error } : {}) });
      };
      while (Date.now() - started < (o.budgetMs ?? 20_000)) {
        const at = ctx.now();
        const batch = await ctx.repo.claimJobs(iso(at), iso(new Date(at.getTime() + JOB_LOCK_MS)), JOB_BATCH);
        if (!batch.length) break;
        const ranBefore = out.ran;
        await Promise.all(batch.map((j) => one(j).catch((e) => ctx.report(e, "jobs"))));
        // Only paused jobs in this batch (put back for later): stop rather than claim them again.
        if (out.ran === ranBefore) break;
      }
      out.waiting = (await ctx.repo.countJobs()).waiting;
      return out;
    },
    stats: () => ctx.repo.countJobs(),
    list: (q: { state?: "waiting" | "failed" | "done"; kind?: string; limit?: number } = {}) => ctx.repo.listJobs(q),
    /** Give a job that failed for good another full round of attempts. */
    async retry(id: string): Promise<boolean> {
      const job = (await ctx.repo.listJobs({ state: "failed", limit: 1000 })).find((j) => j.id === id);
      if (!job) return false;
      await ctx.repo.updateJob(id, { failedAt: null, runAt: iso(ctx.now()), lockedUntil: null });
      return true;
    },
    /** Housekeeping the cron call does: forget jobs that finished more than a week ago. */
    prune: () => ctx.repo.pruneJobs(iso(new Date(ctx.now().getTime() - JOB_DONE_KEEP_DAYS * 86_400_000))),
  };
}

export type CmsJobs = ReturnType<typeof createJobs>;
