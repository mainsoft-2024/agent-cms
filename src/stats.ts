/**
 * The dashboard's numbers (`GET /_stats`): documents by state, changes per day by people and by
 * agents, the most read documents and the latest activity. Read from the tables that are already
 * there; a caller only sees collections they may read.
 */
import type { CmsRepo } from "./repo";
import type { Actor, AuditEntry, CmsDoc, DocCounts } from "./types";

export const STATS_DAYS = [7, 14, 30] as const;

export interface CmsStats {
  days: number;
  totals: { documents: number; published: number; review: number; scheduled: number };
  /** One entry per day, oldest first. */
  changes: { day: string; people: number; agents: number }[];
  top: { collection: string; slug: string; title: string; hits: number }[];
  recent: { at: string; who: string; agent: boolean; action: string; collection: string | null; slug: string | null; title: string | null; version: number | null }[];
}

export interface StatsContext {
  repo: CmsRepo;
  now: () => Date;
  dayOf: (d: Date) => string;
  ready: () => Promise<void> | void;
  collections: () => string[];
  can: (actor: Actor, collection: string, what: "read" | "write", doc?: CmsDoc | null) => boolean;
  counts: (actor: Actor, collection: string) => Promise<DocCounts>;
  isAdmin: (actor: Actor) => boolean;
  /** Changes whenever a document is written here: cached numbers from before are not reused. */
  generation?: () => number;
  /** The published copy of a document (without the draft's review, schedule or last editor), or null. */
  publicView?: (doc: CmsDoc) => CmsDoc | null;
  /** Whether a collection's rules decide per document. */
  rulesPerDocument?: (col: string) => boolean;
}

/** Audit actions worth a line in "recent activity". */
const SHOWN = new Set(["doc.publish", "doc.unpublish", "doc.schedule", "doc.delete", "review.request", "review.approve", "asset.upload", "release.publish"]);

export function createStats(ctx: StatsContext) {
  // No cache of answers (0.18.0): what a person may see is decided on every call, so a change of
  // role, ownership or a write on another server shows at once.
  return async function stats(actor: Actor, o: { days?: number } = {}): Promise<CmsStats> {
    await ctx.ready();
    const days = (STATS_DAYS as readonly number[]).includes(o.days ?? 14) ? (o.days ?? 14) : 14;
    const nowMs = ctx.now().getTime();

    // Collections the person may read, or edit (an editor's list shows those even without read).
    const readable = ctx.collections().filter((c) => ctx.can(actor, c, "read") || ctx.can(actor, c, "write"));
    const totals = { documents: 0, published: 0, review: 0, scheduled: 0 };
    const docs = new Map<string, CmsDoc>();
    // What this person may edit (stored rows) and, of the rest, what they may read (published copies).
    const editable = new Set<string>();
    for (const col of readable) {
      const editor = ctx.can(actor, col, "write");
      const list = await ctx.repo.listDocs({ collection: col });
      for (const d of list) {
        if (d.deletedAt) continue;
        if (editor && ctx.can(actor, col, "write", d)) {
          docs.set(d.id, d);
          editable.add(d.id);
          continue;
        }
        const pub = ctx.publicView ? ctx.publicView(d) : d.publishedVersion === null || !d.published || d.status === "archived" ? null : ({ ...d, ...(d.published as object), version: d.publishedVersion, review: null, schedule: null } as CmsDoc);
        if (pub && ctx.can(actor, col, "read", pub)) docs.set(d.id, pub);
      }
    }
    // Totals count only those documents, so the cards match what the lists show this person.
    for (const d of docs.values()) {
      totals.documents++;
      if (d.publishedVersion !== null && d.status !== "archived") totals.published++;
      if (editable.has(d.id) && d.review?.state === "requested") totals.review++;
      if (editable.has(d.id) && d.schedule) totals.scheduled++;
    }

    const since = new Date(nowMs - (days - 1) * 86_400_000);
    const first = ctx.dayOf(since);
    const byDay = new Map<string, { people: number; agents: number }>();
    for (let i = 0; i < days; i++) byDay.set(ctx.dayOf(new Date(since.getTime() + i * 86_400_000)), { people: 0, agents: 0 });
    // Only what the caller may edit: a version list is an editor's view.
    const stamps = (await ctx.repo.versionsSince(new Date(since.getTime() - 86_400_000).toISOString(), 5000)).filter((v) => {
      const d = docs.get(v.documentId);
      return !!d && editable.has(v.documentId);
    });
    for (const v of stamps) {
      const slot = byDay.get(ctx.dayOf(new Date(v.createdAt)));
      if (!slot) continue;
      if (v.authorKind === "user" && !v.authorAgent) slot.people++;
      else slot.agents++;
    }

    const counts = new Map<string, number>();
    for (const col of readable) for (const [id, n] of await ctx.repo.hitCounts(first, col)) if (docs.has(id)) counts.set(id, n);
    const top = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, hits]) => ({ collection: docs.get(id)!.collection, slug: docs.get(id)!.slug, title: docs.get(id)!.title, hits }));

    const recent: CmsStats["recent"] = stamps.slice(0, 10).map((v) => {
      const d = docs.get(v.documentId)!;
      return { at: v.createdAt, who: v.authorAgent ?? v.authorLabel, agent: v.authorKind !== "user" || !!v.authorAgent, action: v.version === 1 ? "doc.create" : "doc.save", collection: d.collection, slug: d.slug, title: d.title, version: v.version };
    });
    if (ctx.isAdmin(actor)) {
      const entries: AuditEntry[] = await ctx.repo.listAudit({ before: null, limit: 60 });
      const titles = new Map([...docs.values()].map((d) => [`${d.collection}/${d.slug}`, d.title]));
      for (const e of entries) {
        if (!SHOWN.has(e.action) || e.outcome !== "ok") continue;
        // A document the person may not see stays out of their dashboard, admin or not, when rules say so.
        // A deleted document is gone from every list: show its deletion only where the collection
        // has no per-document rules (in one with rules, nobody can tell whether it was theirs to see).
        if (e.collection && e.slug && (e.action === "doc.delete" ? ctx.rulesPerDocument?.(e.collection) !== false || !readable.includes(e.collection) : ![...docs.values()].some((d) => d.collection === e.collection && d.slug === e.slug))) continue;
        recent.push({ at: e.at, who: e.actorAgent ?? e.actorLabel, agent: e.actorKind !== "user" || !!e.actorAgent, action: e.action, collection: e.collection, slug: e.slug, title: titles.get(`${e.collection}/${e.slug}`) ?? (typeof e.detail.name === "string" ? e.detail.name : null), version: e.version });
      }
    }
    recent.sort((a, b) => b.at.localeCompare(a.at));

    return { days, totals, changes: [...byDay].map(([day, n]) => ({ day, ...n })), top, recent: recent.slice(0, 10) };
  };
}
