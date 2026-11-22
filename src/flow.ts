/**
 * The editing and publishing flow around a document (0.10.0): scheduled
 * publishing, the trash, review requests, comments, releases, version labels,
 * saved filters and who has a document open. `cms.ts` owns the rules of a
 * single document; this file builds on them through `FlowContext`, so both
 * stay readable.
 */

import type { createAssets } from "./assets";
import type { AnyCollection } from "./cms";
import { isCmsError, type CmsErrorCode, type CmsErrorOptions, type Diagnostic, type ErrorParams } from "./errors";
import { sectionRanges } from "./patch";
import type { CmsRepo } from "./repo";
import { docState, type Actor, type ActorKind, type AuditAction, type AuditEntry, type CmsComment, type CmsDoc, type CmsRelease, type CmsVersion, type DocContent, type DocSummary, type Presence, type ReleaseItem, type ReviewRequest, type SavedFilter, type Schedule } from "./types";

export interface FlowContext {
  repo: CmsRepo;
  now: () => Date;
  nowIso: () => string;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  audit: (actor: Actor, action: AuditAction, o?: { collection?: string | null; slug?: string | null; version?: number | null; outcome?: AuditEntry["outcome"]; detail?: Record<string, unknown> }) => void;
  actorRef: (actor: Actor) => { kind: ActorKind; id: string | null; label: string; agent: string | null };
  collection: (slug: string) => AnyCollection;
  collections: () => AnyCollection[];
  can: (actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null) => boolean;
  assert: (actor: Actor, col: string, what: "read" | "write" | "publish", doc?: CmsDoc | null) => void;
  isAdmin: (actor: Actor) => boolean;
  ready: () => Promise<void> | void;
  /** The document as an editor sees it, or `not_found` / a permission error. */
  editable: (actor: Actor, col: string, slug: string) => Promise<CmsDoc>;
  conflict: (cur: CmsDoc, expected: number, actor: Actor, col: string) => Error;
  publishIn: (r: CmsRepo, actor: Actor, doc: CmsDoc, n: number) => Promise<CmsDoc>;
  unpublishIn: (r: CmsRepo, actor: Actor, doc: CmsDoc) => Promise<CmsDoc>;
  changed: (prev: CmsDoc | null, doc: CmsDoc | null, o?: { quiet?: boolean }) => void;
  /** Everything wrong with this content of `doc` (errors and warnings). */
  problems: (doc: CmsDoc, c: DocContent, r: CmsRepo) => Promise<Diagnostic[]>;
  needsReview: (actor: Actor, col: string) => boolean;
  assertReviewed: (r: CmsRepo, actor: Actor, doc: CmsDoc, n: number) => Promise<void>;
  summaryOf: (d: CmsDoc) => DocSummary;
  message: (e: unknown) => string;
  report: (err: unknown, where: string) => void;
  /** 0: delete at once. */
  trashDays: number;
  assets: ReturnType<typeof createAssets>;
  /** The payload of a signed preview token (throws when it is bad or expired). */
  previewPayload: (token: string) => { c: string; s: string; v: number; exp: number; cm?: 1 };
}

export interface TrashRef {
  kind: "document" | "asset";
  id: string;
}

export interface TrashItem extends TrashRef {
  title: string;
  /** Collection label and slug, or store and path. */
  where: string;
  collection: string | null;
  slug: string | null;
  /** What it was before: draft, published, archived; a file's kind for files. */
  state: string;
  deletedAt: string;
  deletedBy: string | null;
  /** When it is deleted for good (null: never, `trash.days` is 0). */
  purgeAt: string | null;
  canRestore: boolean;
}

export interface CommentThread extends CmsComment {
  /** Where it sits now: on the quoted text, on its section only, or nowhere (both are gone). */
  located: "quote" | "section" | "lost";
  /** 1-based line in the body, null when lost. */
  line: number | null;
  replies: CmsComment[];
}

export interface ReleaseView extends CmsRelease {
  items: (ReleaseItem & {
    /** The document's latest version, null when it is gone. */
    currentVersion: number | null;
    /** The document changed after it was added. */
    stale: boolean;
    state: string | null;
    canPublish: boolean;
  })[];
  canPublish: boolean;
}

export interface BlockedItem {
  collection: string;
  slug: string;
  title: string;
  code: string;
  message: string;
}

export interface ScheduledRun {
  published: string[];
  unpublished: string[];
  failed: { collection: string; slug: string; code: string; message: string }[];
  releases: { id: string; name: string; ok: boolean; message?: string }[];
  purged: { documents: number; assets: number };
}

/** A person, key or app label that is "here" for 45 seconds after its last sign of life. */
export const PRESENCE_MS = 45_000;
export const COMMENT_MAX = 4000;
const QUOTE_MAX = 500;
const NAME_MAX = 80;
const FILTER_KEYS = ["q", "state", "category", "by"] as const;
const DAY = 86_400_000;

export function createFlow(ctx: FlowContext) {
  const { repo, fail, audit, actorRef, can, assert, nowIso } = ctx;
  const scheduler: Actor = { kind: "system", label: "scheduler", via: "app" };
  const errorsOf = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
  const known = (col: string) => ctx.collections().some((c) => c.slug === col);

  // ── scheduled publishing ──────────────────────────────────────────────────

  function future(v: unknown, field: string): string | null {
    if (v === null || v === undefined || v === "") return null;
    const t = Date.parse(String(v));
    if (!Number.isFinite(t) || t <= ctx.now().getTime()) throw fail("schedule_invalid", { field });
    return new Date(t).toISOString();
  }

  /**
   * Publish (and/or unpublish) at a time. What goes public is the version that
   * is current now, not whatever the draft holds then.
   */
  async function schedule(actor: Actor, col: string, slug: string, o: { publishAt?: string | null; unpublishAt?: string | null; expectedVersion?: number }): Promise<CmsDoc> {
    await ctx.ready();
    ctx.collection(col);
    const publishAt = future(o.publishAt, "publishAt");
    const unpublishAt = future(o.unpublishAt, "unpublishAt");
    if (!publishAt && !unpublishAt) throw fail("schedule_invalid", { field: "publishAt" });
    if (publishAt && unpublishAt && unpublishAt <= publishAt) throw fail("schedule_invalid", { field: "unpublishAt" });
    const who = actorRef(actor);
    const doc = await repo.tx(async (r) => {
      const cur = await r.findDoc(col, slug);
      if (!cur) throw fail("not_found", { collection: col, slug });
      assert(actor, col, "publish", cur);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw ctx.conflict(cur, o.expectedVersion, actor, col);
      if (publishAt) {
        await ctx.assertReviewed(r, actor, cur, cur.version);
        const errors = errorsOf(await ctx.problems(cur, cur, r));
        if (errors.length) throw fail(errors[0].code, errors[0].params, { diagnostics: errors });
      } else if (cur.publishedVersion === null) throw fail("not_published");
      const s: Schedule = { publishAt, unpublishAt, version: cur.version, by: who.label, byKind: who.kind, byId: who.id, byAgent: who.agent, at: nowIso() };
      return (await r.updateDoc(cur.id, { schedule: s, dueAt: publishAt ?? unpublishAt, updatedAt: cur.updatedAt }))!;
    });
    audit(actor, "doc.schedule", { collection: col, slug, version: doc.schedule!.version, detail: { publishAt, unpublishAt } });
    return doc;
  }

  async function unschedule(actor: Actor, col: string, slug: string): Promise<CmsDoc> {
    await ctx.ready();
    ctx.collection(col);
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    assert(actor, col, "publish", cur);
    if (!cur.schedule) throw fail("not_scheduled");
    const doc = (await repo.updateDoc(cur.id, { schedule: null, dueAt: null, updatedAt: cur.updatedAt }))!;
    audit(actor, "doc.unschedule", { collection: col, slug, version: cur.schedule.version });
    return doc;
  }

  /**
   * Do everything whose time has come: scheduled publishes and unpublishes,
   * scheduled releases, and emptying the trash. Call it from a cron (the
   * `/_cron` route does). Safe to call from two places at once: each document
   * is re-read inside its own transaction.
   */
  async function runScheduled(o: { now?: Date } = {}): Promise<ScheduledRun> {
    await ctx.ready();
    const at = (o.now ?? ctx.now()).toISOString();
    const out: ScheduledRun = { published: [], unpublished: [], failed: [], releases: [], purged: { documents: 0, assets: 0 } };
    for (const d of await repo.listDocs({ dueBefore: at })) {
      if (!known(d.collection) || !d.schedule) continue;
      let prev: CmsDoc | null = null;
      let did: "published" | "unpublished" | null = null;
      try {
        const doc = await repo.tx(async (r) => {
          const cur = (prev = await r.findDocById(d.id));
          const s = cur?.schedule;
          if (!cur || !s || !cur.dueAt || cur.dueAt > at) return null; // another runner got here first
          if (s.publishAt && s.publishAt <= at) {
            const snap = s.version === cur.version ? cur : (await r.getVersion(cur.id, s.version))?.snapshot;
            if (!snap) throw fail("version_not_found", { version: s.version });
            const errors = errorsOf(await ctx.problems(cur, { ...snap, slug: cur.slug }, r));
            if (errors.length) throw fail(errors[0].code, errors[0].params, { diagnostics: errors });
            did = "published";
            return ctx.publishIn(r, scheduler, cur, s.version);
          }
          did = "unpublished";
          return ctx.unpublishIn(r, scheduler, cur);
        });
        const what = did as "published" | "unpublished" | null; // assigned inside the transaction
        if (!doc || !what) continue;
        audit(scheduler, what === "published" ? "doc.publish" : "doc.unpublish", { collection: d.collection, slug: d.slug, version: doc.publishedVersion ?? doc.version, detail: { scheduledBy: d.schedule.by, scheduledAt: d.schedule.at } });
        ctx.changed(prev, doc);
        out[what].push(`${d.collection}/${d.slug}`);
      } catch (e) {
        // Nothing went out. The schedule is cleared so it does not fail again every minute.
        await repo.updateDoc(d.id, { schedule: null, dueAt: null, updatedAt: d.updatedAt }).catch((err) => ctx.report(err, "runScheduled"));
        const code = isCmsError(e) ? e.code : "internal";
        if (!isCmsError(e)) ctx.report(e, "runScheduled");
        audit(scheduler, "doc.schedule", { collection: d.collection, slug: d.slug, version: d.schedule.version, outcome: "failed", detail: { code, scheduledBy: d.schedule.by } });
        out.failed.push({ collection: d.collection, slug: d.slug, code, message: ctx.message(e) });
      }
    }
    for (const rel of await repo.listReleases()) {
      if (rel.state !== "scheduled" || !rel.publishAt || rel.publishAt > at) continue;
      try {
        await publishRelease(scheduler, rel.id);
        out.releases.push({ id: rel.id, name: rel.name, ok: true });
      } catch (e) {
        if (!isCmsError(e)) ctx.report(e, "runScheduled");
        const message = ctx.message(e);
        await repo.updateRelease(rel.id, { state: "open", publishAt: null, lastError: message }, "scheduled").catch((err) => ctx.report(err, "runScheduled"));
        audit(scheduler, "release.publish", { outcome: "failed", detail: { id: rel.id, name: rel.name, code: isCmsError(e) ? e.code : "internal" } });
        out.releases.push({ id: rel.id, name: rel.name, ok: false, message });
      }
    }
    if (ctx.trashDays > 0) {
      const cutoff = new Date(Date.parse(at) - ctx.trashDays * DAY).toISOString();
      for (const d of await repo.listDocs({ trashed: true })) {
        if (!d.deletedAt || d.deletedAt > cutoff) continue;
        await repo.deleteDoc(d.id);
        audit(scheduler, "doc.purge", { collection: d.collection, slug: d.slug, detail: { auto: true } });
        out.purged.documents++;
      }
      out.purged.assets = await ctx.assets.purgeOlder(cutoff);
    }
    await repo.prunePresence(new Date(Date.parse(at) - 3_600_000).toISOString()).catch((err) => ctx.report(err, "runScheduled"));
    return out;
  }

  // ── trash ─────────────────────────────────────────────────────────────────

  const purgeAt = (deletedAt: string) => (ctx.trashDays > 0 ? new Date(Date.parse(deletedAt) + ctx.trashDays * DAY).toISOString() : null);

  /** What is in the trash and this actor may see: documents of collections they edit, files of stores they read. */
  async function trashList(actor: Actor, o: { kind?: TrashRef["kind"] } = {}): Promise<{ items: TrashItem[]; days: number; canPurge: boolean }> {
    await ctx.ready();
    if (actor.kind === "anonymous") throw fail("unauthorized");
    const items: TrashItem[] = [];
    if (o.kind !== "asset") {
      for (const d of await repo.listDocs({ trashed: true })) {
        if (!known(d.collection) || !can(actor, d.collection, "write", d)) continue;
        items.push({ kind: "document", id: d.id, title: d.title, where: `${ctx.collection(d.collection).label} / ${d.slug}`, collection: d.collection, slug: d.slug, state: docState(d).state, deletedAt: d.deletedAt!, deletedBy: d.deletedBy, purgeAt: purgeAt(d.deletedAt!), canRestore: can(actor, d.collection, "publish", d) });
      }
    }
    if (o.kind !== "document" && ctx.assets.enabled) {
      for (const a of await ctx.assets.trashed(actor)) {
        items.push({ kind: "asset", id: a.id, title: a.name, where: `${a.store} / ${a.key}`, collection: null, slug: null, state: a.kind, deletedAt: a.deletedAt!, deletedBy: a.deletedBy, purgeAt: purgeAt(a.deletedAt!), canRestore: ctx.assets.can(actor, a.store, "delete") });
      }
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { items, days: ctx.trashDays, canPurge: ctx.isAdmin(actor) };
  }

  const refs = (v: unknown): TrashRef[] => (Array.isArray(v) ? v.filter((x): x is TrashRef => !!x && (x.kind === "document" || x.kind === "asset") && typeof x.id === "string").slice(0, 200) : []);

  /** Put things back as they were. A document that was published is public again at once. */
  async function trashRestore(actor: Actor, items: readonly TrashRef[]): Promise<{ restored: number; results: { kind: TrashRef["kind"]; id: string; ok: boolean; error?: { code: string; message: string } }[] }> {
    await ctx.ready();
    let restored = 0;
    const list = refs(items);
    const results: { kind: TrashRef["kind"]; id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
    // One item: its error is the answer. Several: each is tried and gets its own outcome.
    for (const it of list) {
      try {
        await restoreOne(actor, it);
        restored++;
        results.push({ kind: it.kind, id: it.id, ok: true });
      } catch (e) {
        if (list.length === 1 || !(e instanceof Error && "code" in e)) throw e;
        results.push({ kind: it.kind, id: it.id, ok: false, error: { code: String((e as { code: unknown }).code), message: e.message } });
      }
    }
    return { restored, results };
  }

  async function restoreOne(actor: Actor, it: TrashRef): Promise<void> {
    {
      if (it.kind === "asset") {
        await ctx.assets.untrash(actor, it.id);
      } else {
        const d = await repo.findDocById(it.id, { trashed: true });
        if (!d?.deletedAt || !known(d.collection)) throw fail("trash_not_found", { id: it.id });
        assert(actor, d.collection, "publish", d);
        const doc = (await repo.updateDoc(d.id, { deletedAt: null, deletedBy: null, updatedAt: nowIso() }))!;
        audit(actor, "doc.undelete", { collection: d.collection, slug: d.slug, version: d.version });
        ctx.changed(null, doc, { quiet: true }); // told as doc.restored, not as a new document
      }
    }
  }

  /** Delete for good (admins only). `"all"` empties the trash. */
  async function trashPurge(actor: Actor, items: readonly TrashRef[] | "all"): Promise<{ purged: number }> {
    await ctx.ready();
    if (actor.kind === "anonymous") throw fail("unauthorized");
    if (!ctx.isAdmin(actor)) throw fail("forbidden_trash");
    const list = items === "all" ? (await trashList(actor)).items : refs(items);
    let purged = 0;
    for (const it of list) {
      if (it.kind === "asset") {
        if (!(await ctx.assets.purge(actor, it.id))) continue;
      } else {
        const d = await repo.findDocById(it.id, { trashed: true });
        if (!d?.deletedAt) continue;
        await repo.deleteDoc(d.id);
        audit(actor, "doc.purge", { collection: d.collection, slug: d.slug, version: d.version });
      }
      purged++;
    }
    return { purged };
  }

  // ── review requests ───────────────────────────────────────────────────────

  const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

  /** Ask for a review of the current version. Anyone who can edit may ask. */
  async function requestReview(actor: Actor, col: string, slug: string, o: { note?: string | null } = {}): Promise<CmsDoc> {
    const cur = await ctx.editable(actor, col, slug);
    const who = actorRef(actor);
    const review: ReviewRequest = { state: "requested", version: cur.version, by: who.label, byKind: who.kind, byId: who.id, byAgent: who.agent, at: nowIso(), note: text(o.note, 2000) };
    const doc = (await repo.updateDoc(cur.id, { review, updatedAt: cur.updatedAt }))!;
    audit(actor, "review.request", { collection: col, slug, version: cur.version });
    return doc;
  }

  /** The open request of `cur`, or the reason this actor cannot answer it. Answering is a person's job. */
  function answerable(actor: Actor, col: string, cur: CmsDoc): ReviewRequest {
    assert(actor, col, "publish", cur);
    if (actor.kind !== "user" || actor.agent) throw fail("review_people_only");
    const rv = cur.review;
    if (!rv || rv.state !== "requested") throw fail("review_not_requested");
    if (ctx.collection(col).review?.everyone === "required" && rv.byKind === "user" && !rv.byAgent && rv.byId === actor.id) throw fail("review_self");
    return rv;
  }

  /** Approve the version under review and (unless `publish: false`) publish exactly that version. */
  async function approveReview(actor: Actor, col: string, slug: string, o: { publish?: boolean } = {}): Promise<CmsDoc> {
    await ctx.ready();
    ctx.collection(col);
    let prev: CmsDoc | null = null;
    let version = 0;
    const doc = await repo.tx(async (r) => {
      const cur = (prev = await r.findDoc(col, slug));
      if (!cur) throw fail("not_found", { collection: col, slug });
      const rv = answerable(actor, col, cur);
      version = rv.version;
      await r.updateVersion(cur.id, rv.version, { approvedBy: actorRef(actor).label, approvedAt: nowIso() });
      if (o.publish === false) return (await r.updateDoc(cur.id, { review: null, updatedAt: cur.updatedAt }))!;
      return ctx.publishIn(r, actor, cur, rv.version);
    });
    audit(actor, "review.approve", { collection: col, slug, version, detail: { requestedBy: (prev as CmsDoc | null)?.review?.by ?? null, published: o.publish !== false } });
    if (o.publish !== false) audit(actor, "doc.publish", { collection: col, slug, version });
    ctx.changed(prev, doc);
    return doc;
  }

  /** Send it back with a note. The request stays on the document as "changes requested". */
  async function rejectReview(actor: Actor, col: string, slug: string, o: { note?: string | null } = {}): Promise<CmsDoc> {
    await ctx.ready();
    ctx.collection(col);
    const cur = await repo.findDoc(col, slug);
    if (!cur) throw fail("not_found", { collection: col, slug });
    const rv = answerable(actor, col, cur);
    const review: ReviewRequest = { ...rv, state: "changes_requested", note: text(o.note, 2000), answeredBy: actorRef(actor).label, answeredAt: nowIso() };
    const doc = (await repo.updateDoc(cur.id, { review, updatedAt: cur.updatedAt }))!;
    audit(actor, "review.reject", { collection: col, slug, version: rv.version, detail: { requestedBy: rv.by } });
    return doc;
  }

  /** Documents waiting for a review, in the collections this actor edits. */
  async function reviewRequests(actor: Actor, o: { collection?: string } = {}): Promise<DocSummary[]> {
    await ctx.ready();
    if (actor.kind === "anonymous") throw fail("unauthorized");
    if (o.collection) assert(actor, o.collection, "write");
    const cols = (o.collection ? [ctx.collection(o.collection)] : ctx.collections()).filter((c) => can(actor, c.slug, "write"));
    const out: DocSummary[] = [];
    for (const c of cols) for (const d of await repo.listDocs({ collection: c.slug })) if (d.review?.state === "requested") out.push(ctx.summaryOf(d));
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ── comments ──────────────────────────────────────────────────────────────

  function place(body: string, c: CmsComment): Pick<CommentThread, "located" | "line"> {
    const lines = body.replace(/\r/g, "").split("\n");
    const sec = sectionRanges(body).find((s) => s.anchor === c.anchor);
    const quote = c.quote.trim();
    if (quote) {
      const first = quote.split("\n")[0];
      const from = sec?.start ?? 0;
      const to = sec?.end ?? lines.length;
      for (let i = from; i < to; i++) if (lines[i].includes(first)) return { located: "quote", line: i + 1 };
      if (!sec) for (let i = 0; i < lines.length; i++) if (lines[i].includes(first)) return { located: "quote", line: i + 1 };
    }
    if (sec) return { located: "section", line: sec.start + 1 };
    return c.anchor === "" && !quote ? { located: "section", line: 1 } : { located: "lost", line: null };
  }

  async function threads(doc: CmsDoc): Promise<CommentThread[]> {
    const rows = await repo.listComments(doc.id);
    return rows.filter((c) => !c.threadId).map((c) => ({ ...c, ...place(doc.body, c), replies: rows.filter((r) => r.threadId === c.id) }));
  }

  async function insertComment(doc: CmsDoc, author: Pick<CmsComment, "authorKind" | "authorId" | "authorLabel" | "authorAgent">, input: { body: string; anchor?: string | null; quote?: string | null; threadId?: string | null }): Promise<CmsComment> {
    const body = String(input.body ?? "").trim();
    if (!body || body.length > COMMENT_MAX) throw fail("comment_invalid", { max: COMMENT_MAX });
    let anchor = String(input.anchor ?? "");
    let quote = String(input.quote ?? "").slice(0, QUOTE_MAX);
    let threadId: string | null = null;
    if (input.threadId) {
      // One level of answers: an answer to an answer joins the same thread.
      const root = await repo.findComment(String(input.threadId));
      if (!root || root.documentId !== doc.id) throw fail("comment_not_found");
      threadId = root.threadId ?? root.id;
      anchor = root.anchor;
      quote = "";
    }
    return repo.insertComment({ documentId: doc.id, threadId, anchor, quote, body, ...author, createdAt: nowIso() });
  }

  const authorOf = (actor: Actor) => {
    const who = actorRef(actor);
    return { authorKind: who.kind, authorId: who.id, authorLabel: who.label, authorAgent: who.agent };
  };

  /** Comments of a document, as threads, each with where it sits in the current body. */
  async function comments(actor: Actor, col: string, slug: string): Promise<CommentThread[]> {
    return threads(await ctx.editable(actor, col, slug));
  }

  async function addComment(actor: Actor, col: string, slug: string, input: { body: string; anchor?: string | null; quote?: string | null; threadId?: string | null }): Promise<CmsComment> {
    return insertComment(await ctx.editable(actor, col, slug), authorOf(actor), input);
  }

  async function resolveComment(actor: Actor, col: string, slug: string, id: string, o: { resolved?: boolean } = {}): Promise<CmsComment> {
    const doc = await ctx.editable(actor, col, slug);
    const c = await repo.findComment(String(id));
    if (!c || c.documentId !== doc.id) throw fail("comment_not_found");
    const done = o.resolved !== false;
    return (await repo.updateComment(c.threadId ?? c.id, { resolvedAt: done ? nowIso() : null, resolvedBy: done ? actorRef(actor).label : null }))!;
  }

  async function previewDoc(token: string): Promise<CmsDoc> {
    await ctx.ready();
    const p = ctx.previewPayload(token);
    if (!p.cm) throw fail("comments_off");
    ctx.collection(p.c);
    const doc = await repo.findDoc(p.c, p.s);
    if (!doc) throw fail("not_found", { collection: p.c, slug: p.s });
    return doc;
  }

  /** Comments for someone holding a preview link that allows them. */
  async function previewComments(token: string): Promise<CommentThread[]> {
    return threads(await previewDoc(token));
  }

  async function addPreviewComment(token: string, input: { name?: string | null; body: string; anchor?: string | null; quote?: string | null; threadId?: string | null }): Promise<CmsComment> {
    const doc = await previewDoc(token);
    return insertComment(doc, { authorKind: "guest", authorId: null, authorLabel: text(input.name, 60) ?? "Guest", authorAgent: null }, input);
  }

  // ── version labels ────────────────────────────────────────────────────────

  /** Name a version and/or pin it (a pinned version is never pruned). */
  async function labelVersion(actor: Actor, col: string, slug: string, n: number, o: { label?: string | null; pinned?: boolean }): Promise<CmsVersion> {
    const doc = await ctx.editable(actor, col, slug);
    if (!(await repo.getVersion(doc.id, n))) throw fail("version_not_found", { version: n });
    await repo.updateVersion(doc.id, n, { label: o.label === undefined ? undefined : text(o.label, 60), pinned: o.pinned === undefined ? undefined : !!o.pinned });
    return { ...(await repo.getVersion(doc.id, n))!, published: n === doc.publishedVersion };
  }

  // ── releases ──────────────────────────────────────────────────────────────

  function needEditor(actor: Actor) {
    if (actor.kind === "anonymous") throw fail("unauthorized");
    if (!ctx.collections().some((c) => can(actor, c.slug, "write"))) throw fail("forbidden");
  }

  async function loadRelease(id: string, open = false): Promise<CmsRelease> {
    await ctx.ready();
    const rel = await repo.findRelease(String(id));
    if (!rel) throw fail("release_not_found");
    if (open && rel.state === "published") throw fail("release_closed");
    return rel;
  }

  async function viewRelease(actor: Actor, rel: CmsRelease): Promise<ReleaseView> {
    const items: ReleaseView["items"] = [];
    for (const it of rel.items) {
      const doc = known(it.collection) ? await repo.findDocById(it.documentId) : null;
      items.push({ ...it, slug: doc?.slug ?? it.slug, title: doc?.title ?? it.title, currentVersion: doc?.version ?? null, stale: !!doc && doc.version !== it.version, state: doc ? docState(doc).state : null, canPublish: !!doc && can(actor, it.collection, "publish", doc) });
    }
    return { ...rel, items, canPublish: rel.state !== "published" && items.length > 0 && items.every((i) => i.canPublish) };
  }

  async function releases(actor: Actor): Promise<CmsRelease[]> {
    await ctx.ready();
    needEditor(actor);
    return repo.listReleases();
  }

  async function release(actor: Actor, id: string): Promise<ReleaseView> {
    needEditor(actor);
    return viewRelease(actor, await loadRelease(id));
  }

  const nameOf = (v: unknown) => {
    const name = text(v, NAME_MAX + 1);
    if (!name || name.length > NAME_MAX) throw fail("name_invalid", { max: NAME_MAX });
    return name;
  };

  async function createRelease(actor: Actor, input: { name: string }): Promise<ReleaseView> {
    await ctx.ready();
    needEditor(actor);
    const who = actorRef(actor);
    return viewRelease(actor, await repo.insertRelease({ name: nameOf(input.name), createdBy: who.label, createdById: who.id, createdAt: nowIso() }));
  }

  async function renameRelease(actor: Actor, id: string, input: { name: string }): Promise<ReleaseView> {
    needEditor(actor);
    const rel = await loadRelease(id, true);
    return viewRelease(actor, (await repo.updateRelease(rel.id, { name: nameOf(input.name), updatedAt: nowIso() }))!);
  }

  /** Delete a release that has not gone out. A published one stays as a record. */
  async function removeRelease(actor: Actor, id: string): Promise<void> {
    needEditor(actor);
    const rel = await loadRelease(id, true);
    await repo.deleteRelease(rel.id);
  }

  /**
   * Put documents in a release (or pin them again at their latest version).
   * The version is fixed now: later edits do not go out with the release
   * unless the document is added again.
   */
  async function addToRelease(actor: Actor, id: string, input: readonly { collection: string; slug: string; action?: ReleaseItem["action"] }[]): Promise<ReleaseView> {
    needEditor(actor);
    const rel = await loadRelease(id, true);
    const items = [...rel.items];
    const others = (await repo.listReleases()).filter((r) => r.id !== rel.id && r.state !== "published");
    for (const it of input.slice(0, 200)) {
      const doc = await ctx.editable(actor, it.collection, it.slug);
      const action = it.action === "unpublish" ? "unpublish" : "publish";
      if (action === "unpublish" && doc.publishedVersion === null) throw fail("not_published");
      const other = others.find((r) => r.items.some((x) => x.documentId === doc.id));
      if (other) throw fail("in_other_release", { release: other.name, slug: doc.slug });
      const item: ReleaseItem = { documentId: doc.id, collection: doc.collection, slug: doc.slug, title: doc.title, action, version: doc.version };
      const at = items.findIndex((x) => x.documentId === doc.id);
      if (at >= 0) items[at] = item;
      else items.push(item);
    }
    return viewRelease(actor, (await repo.updateRelease(rel.id, { items, lastError: null, updatedAt: nowIso() }))!);
  }

  async function removeFromRelease(actor: Actor, id: string, documentId: string): Promise<ReleaseView> {
    needEditor(actor);
    const rel = await loadRelease(id, true);
    return viewRelease(actor, (await repo.updateRelease(rel.id, { items: rel.items.filter((x) => x.documentId !== documentId), updatedAt: nowIso() }))!);
  }

  /**
   * Everything in the release goes out in one transaction, or nothing does:
   * a missing permission, a failed check or a missing review on any document
   * stops all of it, and the error lists what blocked (`current.blocked`).
   */
  async function publishRelease(actor: Actor, id: string): Promise<CmsRelease> {
    await ctx.ready();
    if (actor.kind === "anonymous") throw fail("unauthorized");
    const done: { item: ReleaseItem; prev: CmsDoc; doc: CmsDoc }[] = [];
    const rel = await repo.tx(async (r) => {
      const cur = await r.findRelease(String(id));
      if (!cur) throw fail("release_not_found");
      if (cur.state === "published") throw fail("release_closed");
      if (!cur.items.length) throw fail("release_empty");
      const blocked: BlockedItem[] = [];
      const ok: { item: ReleaseItem; doc: CmsDoc }[] = [];
      for (const item of cur.items) {
        const block = (code: CmsErrorCode, params: ErrorParams = {}, message?: string) => blocked.push({ collection: item.collection, slug: item.slug, title: item.title, code, message: message ?? ctx.message(fail(code, params)) });
        const doc = known(item.collection) ? await r.findDocById(item.documentId) : null;
        if (!doc) block("not_found", { collection: item.collection, slug: item.slug });
        else if (!can(actor, doc.collection, "publish", doc)) block("forbidden_publish", { collection: doc.collection });
        else if (item.action === "unpublish") ok.push({ item, doc });
        else {
          const v = await r.getVersion(doc.id, item.version);
          const errors = v ? errorsOf(await ctx.problems(doc, { ...v.snapshot, slug: doc.slug }, r)) : [];
          if (!v) block("version_not_found", { version: item.version });
          else if (ctx.needsReview(actor, doc.collection) && !v.approvedBy) block("review_required", { collection: doc.collection });
          else if (errors.length) block(errors[0].code, errors[0].params, errors[0].message);
          else ok.push({ item, doc });
        }
      }
      if (blocked.length) throw fail("release_blocked", { count: blocked.length }, { current: { blocked } });
      for (const { item, doc } of ok) {
        const out = item.action === "publish" ? await ctx.publishIn(r, actor, doc, item.version) : await ctx.unpublishIn(r, actor, doc);
        // The version that went out carries the release's name, unless someone named it already.
        if (item.action === "publish" && !(await r.getVersion(doc.id, item.version))?.label) await r.updateVersion(doc.id, item.version, { label: cur.name.slice(0, 60) });
        done.push({ item, prev: doc, doc: out });
      }
      const at = nowIso();
      const saved = await r.updateRelease(cur.id, { state: "published", publishAt: null, publishedAt: at, publishedBy: actorRef(actor).label, lastError: null, updatedAt: at }, cur.state);
      if (!saved) throw fail("release_closed");
      return saved;
    });
    for (const d of done) {
      audit(actor, d.item.action === "publish" ? "doc.publish" : "doc.unpublish", { collection: d.doc.collection, slug: d.doc.slug, version: d.item.version, detail: { release: rel.name } });
      ctx.changed(d.prev, d.doc);
    }
    audit(actor, "release.publish", { detail: { id: rel.id, name: rel.name, documents: done.length } });
    return rel;
  }

  /** Publish the release at a time. The person scheduling must be allowed to publish every document in it. */
  async function scheduleRelease(actor: Actor, id: string, o: { publishAt: string | null }): Promise<ReleaseView> {
    needEditor(actor);
    const rel = await loadRelease(id, true);
    if (o.publishAt === null) return viewRelease(actor, (await repo.updateRelease(rel.id, { state: "open", publishAt: null, updatedAt: nowIso() }))!);
    const publishAt = future(o.publishAt, "publishAt");
    if (!publishAt) throw fail("schedule_invalid", { field: "publishAt" });
    if (!rel.items.length) throw fail("release_empty");
    for (const it of rel.items) {
      const doc = known(it.collection) ? await repo.findDocById(it.documentId) : null;
      if (!doc) throw fail("not_found", { collection: it.collection, slug: it.slug });
      assert(actor, doc.collection, "publish", doc);
      if (it.action === "publish") await ctx.assertReviewed(repo, actor, doc, it.version);
    }
    return viewRelease(actor, (await repo.updateRelease(rel.id, { state: "scheduled", publishAt, lastError: null, updatedAt: nowIso() }))!);
  }

  /** The open release a document is in, if any (so a screen can warn before a separate publish). */
  async function releaseOf(documentId: string): Promise<{ id: string; name: string; state: CmsRelease["state"]; publishAt: string | null } | null> {
    const rel = (await repo.listReleases()).find((r) => r.state !== "published" && r.items.some((x) => x.documentId === documentId));
    return rel ? { id: rel.id, name: rel.name, state: rel.state, publishAt: rel.publishAt } : null;
  }

  // ── saved filters ─────────────────────────────────────────────────────────

  /** Filters this actor sees for a collection: their own and the shared ones. */
  async function filters(actor: Actor, col: string): Promise<(SavedFilter & { mine: boolean })[]> {
    await ctx.ready();
    assert(actor, col, "write");
    const me = actor.kind === "user" ? actor.id : null;
    return (await repo.listFilters(col)).filter((f) => f.shared || f.ownerId === me).map((f) => ({ ...f, mine: f.ownerId === me }));
  }

  async function saveFilter(actor: Actor, col: string, input: { name: string; query: Record<string, unknown>; shared?: boolean }): Promise<SavedFilter> {
    await ctx.ready();
    assert(actor, col, "write");
    if (actor.kind !== "user") throw fail("forbidden");
    if (input.shared && !ctx.isAdmin(actor)) throw fail("forbidden_filter");
    const name = text(input.name, 61);
    if (!name || name.length > 60) throw fail("name_invalid", { max: 60 });
    const query: Record<string, string> = {};
    for (const k of FILTER_KEYS) if (typeof input.query?.[k] === "string" && input.query[k]) query[k] = (input.query[k] as string).slice(0, 200);
    return repo.insertFilter({ collection: col, name, query, ownerId: actor.id, ownerLabel: actor.label, shared: !!input.shared, createdAt: nowIso() });
  }

  async function removeFilter(actor: Actor, id: string): Promise<void> {
    await ctx.ready();
    const f = await repo.findFilter(String(id));
    if (!f) throw fail("filter_not_found");
    assert(actor, f.collection, "write");
    if (!(actor.kind === "user" && actor.id === f.ownerId) && !ctx.isAdmin(actor)) throw fail("forbidden_filter");
    await repo.deleteFilter(f.id);
  }

  // ── presence ──────────────────────────────────────────────────────────────

  const presenceId = (actor: Actor) => (actor.kind === "user" ? (actor.agent ? `agent:${actor.id}:${actor.agent.label}` : `user:${actor.id}`) : actor.kind === "key" ? `key:${actor.id}` : actor.kind === "system" ? `system:${actor.label}` : "anonymous");
  const pos = (v: unknown): Presence["cursor"] => {
    const p = v as { line?: unknown; ch?: unknown } | null;
    return p && Number.isInteger(p.line) && Number.isInteger(p.ch) ? { line: Math.max(0, p.line as number), ch: Math.max(0, p.ch as number) } : null;
  };
  const since = () => new Date(ctx.now().getTime() - PRESENCE_MS).toISOString();

  function presenceRow(actor: Actor, doc: CmsDoc, o: { cursor?: unknown; selection?: unknown } = {}): Presence {
    const who = actorRef(actor);
    return { documentId: doc.id, actorId: presenceId(actor), label: who.label, kind: who.kind, agent: who.agent, cursor: pos(o.cursor), selection: pos(o.selection), seenAt: nowIso() };
  }

  /**
   * "I have this document open" (the editor says it every 15 seconds). Answers
   * with who else is here and the document's latest version, so the editor
   * knows when to fetch someone else's save.
   */
  async function touchPresence(actor: Actor, col: string, slug: string, o: { cursor?: unknown; selection?: unknown } = {}): Promise<{ version: number; updatedBy: string | null; others: Presence[] }> {
    const doc = await ctx.editable(actor, col, slug);
    const row = presenceRow(actor, doc, o);
    await repo.touchPresence(row);
    return { version: doc.version, updatedBy: doc.updatedBy, others: (await repo.listPresence(since(), [doc.id])).filter((p) => p.actorId !== row.actorId) };
  }

  async function leavePresence(actor: Actor, col: string, slug: string): Promise<void> {
    const doc = await ctx.editable(actor, col, slug);
    await repo.dropPresence(doc.id, presenceId(actor));
  }

  /** Who is in which document of a collection right now (for the list screen). */
  async function presenceIn(actor: Actor, col: string): Promise<{ slug: string; people: Presence[] }[]> {
    await ctx.ready();
    assert(actor, col, "write");
    const docs = await repo.listDocs({ collection: col });
    const bySlug = new Map(docs.map((d) => [d.id, d.slug]));
    const out = new Map<string, Presence[]>();
    for (const p of await repo.listPresence(since(), docs.map((d) => d.id))) {
      const slug = bySlug.get(p.documentId);
      if (slug) out.set(slug, [...(out.get(slug) ?? []), p]);
    }
    return [...out].map(([slug, people]) => ({ slug, people }));
  }

  /** An agent's save leaves a sign of life, so people editing see it is there. Never awaited. */
  function markAgent(actor: Actor, doc: CmsDoc): void {
    if (actor.kind !== "key" && !(actor.kind === "user" && actor.agent)) return;
    void repo.touchPresence(presenceRow(actor, doc)).catch((e) => ctx.report(e, "presence"));
  }

  return {
    schedule,
    unschedule,
    runScheduled,
    trash: { list: trashList, restore: trashRestore, purge: trashPurge },
    requestReview,
    approveReview,
    rejectReview,
    reviewRequests,
    comments,
    addComment,
    resolveComment,
    previewComments,
    addPreviewComment,
    labelVersion,
    releases: { list: releases, get: release, create: createRelease, rename: renameRelease, remove: removeRelease, add: addToRelease, removeItem: removeFromRelease, publish: publishRelease, schedule: scheduleRelease, of: releaseOf },
    filters: { list: filters, save: saveFilter, remove: removeFilter },
    presence: { touch: touchPresence, leave: leavePresence, in: presenceIn },
    markAgent,
  };
}
