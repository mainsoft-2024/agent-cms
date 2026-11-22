/**
 * Export and import. Documents travel as markdown files with frontmatter, one per document:
 * `guide/getting-started.md`, plus `_meta.json` and `_assets/manifest.json` (the files the
 * documents use). The CLI reads and writes a folder; the admin screen moves the same files as
 * one bundle. An import never deletes, makes drafts, and can first say what it would do.
 */
import type { DocInput } from "./cms";
import { unifiedDiff } from "./diff";
import type { CmsErrorCode, CmsErrorOptions, Diagnostic, ErrorParams } from "./errors";
import { docFromMarkdown, docToMarkdown, parseFrontmatter } from "./frontmatter";
import type { CmsRepo } from "./repo";
import type { Actor, AuditAction, CmsDoc } from "./types";
import { VERSION } from "./version";

export interface TransferFile {
  /** `collection/slug.md`, `_meta.json`, `_assets/manifest.json`. */
  path: string;
  text: string;
}
export const IMPORT_CONFLICTS = ["file-wins", "db-wins", "newest"] as const;
export type ImportConflict = (typeof IMPORT_CONFLICTS)[number];
export interface ImportOptions {
  /** A document with the same address exists: `file-wins` saves the file as a new version (default), `db-wins` skips it, `newest` follows the later change. */
  onConflict?: ImportConflict;
  /** Put every file into this collection (files without a folder need it). */
  collection?: string;
  /** Publish what was public when it was exported. */
  publish?: boolean;
  /** Only say what would happen. */
  dryRun?: boolean;
  /** Include the changed lines of each document. */
  diff?: boolean;
  /** Only these files (by `path`). */
  only?: string[];
  /** Old file id → new file id, for `asset:ID` references (the CLI fills it after uploading `_assets/`). */
  assetMap?: Record<string, string>;
}
export interface ImportItem {
  path: string;
  collection: string;
  slug: string;
  title: string;
  /** What the import does with it. */
  change: "new" | "update" | "same" | "skip" | "error";
  fromVersion: number | null;
  toVersion: number | null;
  diagnostics: Diagnostic[];
  /** Why it was skipped or failed. */
  reason: string | null;
  diff?: string;
  /** Published by this import (with `publish`). */
  published?: boolean;
  /**
   * Saved, but publishing it failed (the save stands): why. Import again with `publish` and
   * `only` set to these paths to publish just them; documents already saved come out `same`
   * and are only published.
   */
  publishError?: string | null;
}

export interface TransferContext {
  repo: CmsRepo;
  now: () => Date;
  fail: (code: CmsErrorCode, params?: ErrorParams, o?: CmsErrorOptions) => Error;
  audit: (actor: Actor, action: AuditAction, o?: { detail?: Record<string, unknown> }) => void;
  ready: () => Promise<void> | void;
  message: (e: unknown) => string;
  collections: () => string[];
  can: (actor: Actor, collection: string, what: "read" | "write" | "publish") => boolean;
  list: (actor: Actor, collection: string, o: { drafts?: boolean }) => Promise<CmsDoc[]>;
  diagnose: (actor: Actor, collection: string, input: DocInput, o: { slug?: string }) => Promise<Diagnostic[]>;
  create: (actor: Actor, collection: string, input: DocInput, o: { note?: string }) => Promise<CmsDoc>;
  update: (actor: Actor, collection: string, slug: string, input: DocInput, o: { note?: string; expectedVersion?: number }) => Promise<CmsDoc>;
  publish: (actor: Actor, collection: string, slug: string, o?: { version?: number; expectedVersion?: number }) => Promise<CmsDoc>;
  assetsOf: (actor: Actor, docs: CmsDoc[]) => Promise<{ id: string; store: string; key: string; name: string; alt: string; tags: string[] }[]>;
}

export const IMPORT_MAX_FILES = 500;
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

export function createTransfer(ctx: TransferContext) {
  const { fail } = ctx;

  return {
    /** Every document the caller may read (drafts where they may write), as files. */
    async export(actor: Actor, o: { collections?: string[]; drafts?: boolean } = {}): Promise<{ files: TransferFile[]; documents: number }> {
      await ctx.ready();
      if (actor.kind === "anonymous") throw fail("unauthorized");
      const cols = (o.collections?.length ? o.collections : ctx.collections()).filter((c) => ctx.can(actor, c, "read"));
      for (const c of o.collections ?? []) if (!ctx.collections().includes(c)) throw fail("unknown_collection", { collection: c });
      const files: TransferFile[] = [];
      const docs: CmsDoc[] = [];
      for (const col of cols) {
        const drafts = !!o.drafts && ctx.can(actor, col, "write");
        for (const d of await ctx.list(actor, col, { drafts })) {
          docs.push(d);
          files.push({ path: `${col}/${d.slug}.md`, text: docToMarkdown(d, { status: d.publishedVersion !== null && d.status !== "archived" ? "published" : d.status, updatedAt: d.updatedAt }) });
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      const assets = await ctx.assetsOf(actor, docs);
      if (assets.length) files.push({ path: "_assets/manifest.json", text: JSON.stringify({ assets }, null, 2) });
      files.push({ path: "_meta.json", text: JSON.stringify({ agentCms: VERSION, exportedAt: ctx.now().toISOString(), collections: cols, documents: docs.length, drafts: !!o.drafts }, null, 2) });
      return { files, documents: docs.length };
    },

    /** Read files into documents. With `dryRun` nothing is saved; the answer is the same list either way. */
    async import(actor: Actor, files: TransferFile[], o: ImportOptions = {}): Promise<{ items: ImportItem[]; applied: boolean }> {
      await ctx.ready();
      if (actor.kind === "anonymous") throw fail("unauthorized");
      const mode = o.onConflict ?? "file-wins";
      if (!(IMPORT_CONFLICTS as readonly string[]).includes(mode)) throw fail("invalid_request", { issues: "onConflict" });
      const mds = files.filter((f) => /\.(md|markdown)$/i.test(f.path) && !f.path.startsWith("_"));
      if (mds.length > IMPORT_MAX_FILES) throw fail("too_many_files", { max: IMPORT_MAX_FILES });
      const swap = (s: string) => (o.assetMap ? s.replace(/asset:([a-z0-9]{12})/g, (m, id: string) => (o.assetMap![id] ? `asset:${o.assetMap![id]}` : m)) : s);
      const items: ImportItem[] = [];
      for (const f of mds) {
        const parts = f.path.replace(/\\/g, "/").split("/").filter(Boolean);
        const name = parts[parts.length - 1].replace(/\.(md|markdown)$/i, "");
        const col = o.collection ?? (parts.length > 1 ? parts[parts.length - 2] : "");
        const item: ImportItem = { path: f.path, collection: col, slug: name, title: name, change: "error", fromVersion: null, toVersion: null, diagnostics: [], reason: null };
        items.push(item);
        try {
          if (!col || !ctx.collections().includes(col)) throw fail("unknown_collection", { collection: col || f.path });
          if (!ctx.can(actor, col, "write")) throw fail("forbidden_write", { collection: col });
          const text = swap(f.text);
          const { data } = parseFrontmatter(text);
          const doc = docFromMarkdown(text, name);
          item.slug = doc.slug ?? name;
          item.title = doc.title ?? name;
          const cur = await ctx.repo.findDoc(col, item.slug);
          const wasPublic = data.status === "published";
          item.fromVersion = cur?.version ?? null;
          if (cur?.deletedAt) throw fail("slug_in_trash", { slug: item.slug });
          item.diagnostics = await ctx.diagnose(actor, col, doc, { slug: cur ? item.slug : undefined });
          const same = !!cur && stable({ t: cur.title, s: cur.summary, b: cur.body.trim(), c: cur.category, k: cur.keywords, f: { ...cur.fields, ...(doc.fields ?? {}) } }) === stable({ t: doc.title ?? cur.title, s: doc.summary ?? cur.summary, b: (doc.body ?? "").trim(), c: doc.category === undefined ? cur.category : doc.category, k: doc.keywords ?? cur.keywords, f: cur.fields });
          if (o.diff && cur && !same) item.diff = unifiedDiff(cur.body, doc.body ?? "", { from: `v${cur.version}`, to: f.path });
          if (!cur) item.change = "new";
          else if (same) item.change = "same";
          else if (mode === "db-wins") [item.change, item.reason] = ["skip", "exists"];
          else if (mode === "newest" && typeof data.updatedAt === "string" && Date.parse(data.updatedAt) <= Date.parse(cur.updatedAt)) [item.change, item.reason] = ["skip", "older"];
          else item.change = "update";
          if (item.change === "new" || item.change === "update") item.toVersion = (cur?.version ?? 0) + 1;
          if (item.diagnostics.some((d) => d.severity === "error")) {
            item.change = "error";
            item.toVersion = null;
            item.reason = item.diagnostics.find((d) => d.severity === "error")!.message;
            continue;
          }
          // A document saved by an earlier run whose publish failed: publishing is all that is left.
          const publishLeft = item.change === "same" && !!o.publish && wasPublic && !!cur && cur.publishedVersion !== cur.version && cur.status !== "archived";
          if (o.dryRun || (o.only && !o.only.includes(f.path)) || item.change === "skip" || (item.change === "same" && !publishLeft)) continue;
          if (item.change !== "same") {
            const note = "import";
            const saved = cur ? await ctx.update(actor, col, item.slug, doc, { note, expectedVersion: cur.version }) : await ctx.create(actor, col, doc, { note });
            item.toVersion = saved.version;
          }
          // Publishing is its own step: when it fails the save stands and the item says so.
          if (o.publish && wasPublic) {
            try {
              if (!ctx.can(actor, col, "publish")) throw fail("forbidden_publish", { collection: col });
              // Exactly what this import saved: an edit made meanwhile is a conflict, not published.
              await ctx.publish(actor, col, item.slug, { version: item.toVersion ?? cur?.version, expectedVersion: item.toVersion ?? cur?.version });
              item.published = true;
              item.publishError = null;
            } catch (e) {
              item.published = false;
              item.publishError = ctx.message(e);
            }
          }
        } catch (e) {
          item.change = "error";
          item.toVersion = null;
          item.reason = ctx.message(e);
        }
      }
      const applied = !o.dryRun;
      if (applied) ctx.audit(actor, "import.run", { detail: { files: mds.length, created: items.filter((i) => i.change === "new" && i.toVersion).length, updated: items.filter((i) => i.change === "update" && i.toVersion).length, failed: items.filter((i) => i.change === "error").length, published: items.filter((i) => i.published).length, publishFailed: items.filter((i) => i.publishError).length } });
      return { items: o.only && applied ? items.filter((i) => o.only!.includes(i.path)) : items, applied };
    },
  };
}

export type CmsTransfer = ReturnType<typeof createTransfer>;
