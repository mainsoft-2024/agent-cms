/**
 * agent-cms — an add-on CMS that people (an admin screen) and agents (REST,
 * MCP, CLI) edit together. Lives inside the app: no separate server. It hands
 * agents tools and never calls a model itself.
 *
 * EXTRACTION RULE: nothing under `src/` may import from a host app (`@/`) or
 * any app module (`src/parts.test.ts` enforces it).
 *
 * Browser-safe: no Node APIs here (the admin UI imports these types).
 */

import type { ZodTypeAny } from "zod";

export { CmsError, ERROR_CODES, ERROR_KINDS, formatMessage, isCmsError } from "./errors";
export type { CmsErrorCode, CmsErrorKind, CmsErrorOptions, Diagnostic, ErrorParams, Messages, MessageTemplate } from "./errors";

/**
 * draft     — the latest version is not public (an older one may be).
 * published — the latest version is the public one.
 * archived  — hidden from the public; history kept.
 */
export const DOC_STATUSES = ["draft", "published", "archived"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const KEY_SCOPES = ["read", "write", "publish", "admin"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** How a request came in. Used for usage counts (`cms_hits.source`) and the audit log. */
export const VIAS = ["rest", "mcp", "ai", "cli", "app"] as const;
export type Via = (typeof VIAS)[number];

/** Who is acting. Either an app session (user), an API key, the app itself or nobody. */
export type Actor = (
  | { kind: "anonymous" }
  | {
      kind: "user";
      id: string;
      label: string;
      email?: string | null;
      isAdmin: boolean;
      /**
       * Set when an agent acts for this person (an assistant inside the admin,
       * say). Permissions are exactly the person's; versions, the document and
       * the audit log also record the agent's name, and its edits show up as
       * agent changes to review. Only code in the app can set this: REST and
       * MCP never accept it.
       */
      agent?: { label: string };
    }
  | { kind: "key"; id: string; label: string; scopes: KeyScope[]; collections: string[] | null }
  | { kind: "system"; label: string }
) & {
  /** Set by the transports (REST, MCP, `callTool`); app code may leave it out. */
  via?: Via;
};

/** The editable content of a document; one version = one snapshot of this. */
export interface DocContent {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  keywords: string[];
  fields: Record<string, unknown>;
}

/** Unsaved editor state kept by `cms.autosave()`. Never a version. */
export interface AutosaveState {
  content: DocContent;
  at: string;
  by: string | null;
  /** The version the editor started from (the base of a 3-way merge). */
  baseVersion: number;
}

export interface CmsDoc extends DocContent {
  id: string;
  collection: string;
  status: DocStatus;
  /** Latest version number (the working copy). */
  version: number;
  /** Version that is public, or null when never published. */
  publishedVersion: number | null;
  /** The public snapshot (null when never published). */
  published: DocContent | null;
  /** First publish time; kept across unpublish and republish. */
  publishedAt: string | null;
  /** Last time it went public again after being hidden or unpublished. */
  republishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Label of whoever wrote the latest version. */
  updatedBy: string | null;
  updatedByKind: "user" | "key" | "system" | null;
  /** Name of the agent that acted for `updatedBy` (a person), or null. */
  updatedByAgent: string | null;
  /** Unsaved editor content (only for editors; never on a public read). */
  autosave: AutosaveState | null;
}

/** What `commit()` records about a version: changed fields and body hunks. */
export interface VersionChange {
  fields: string[];
  /** Body hunks (added and removed lines) against the previous version. */
  hunks: { id: string; removed: string[]; added: string[]; before?: string | null }[];
}

/** A reviewed agent change (`cms.reviewChanges`). */
export interface ReviewMark {
  hunk: string;
  by: string;
  at: string;
  action: "accepted" | "reverted";
}

export interface CmsVersion {
  id: string;
  documentId: string;
  version: number;
  snapshot: DocContent;
  authorKind: "user" | "key" | "system";
  authorId: string | null;
  authorLabel: string;
  /** Name of the agent that acted for the author (a person), or null. */
  authorAgent: string | null;
  note: string | null;
  published: boolean;
  createdAt: string;
  changed: VersionChange | null;
  reviewed: ReviewMark[];
}

/** A version without its snapshot (version lists). */
export type VersionSummary = Omit<CmsVersion, "snapshot"> & { title: string };

export interface CmsKey {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  collections: string[] | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** null = never expires. */
  expiresAt: string | null;
  createdAt: string;
}

export const AUDIT_ACTIONS = [
  "key.create",
  "key.revoke",
  "doc.publish",
  "doc.unpublish",
  "doc.archive",
  "doc.unarchive",
  "doc.delete",
  "doc.restore",
  "preview.create",
  "asset.upload",
  "asset.move",
  "asset.delete",
  "access.denied",
  "auth.failed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: string;
  at: string;
  actorKind: Actor["kind"];
  actorId: string | null;
  actorLabel: string;
  /** Name of the agent that acted for the actor (a person), or null. */
  actorAgent: string | null;
  action: AuditAction;
  collection: string | null;
  slug: string | null;
  version: number | null;
  outcome: "ok" | "denied" | "failed";
  via: Via | null;
  detail: Record<string, unknown>;
}

/** Passed to `createCms({ onSearchMiss })` when a search the caller flagged found nothing. */
export interface SearchMissEvent {
  query: string;
  /** `normalizeQuery(query)`: particles dropped, words sorted — group by this. */
  normalized: string;
  collections: string[];
  /** Anyone, anonymous included. Whether to keep it is the app's call. */
  actor: Actor;
  source: Via;
  at: string;
  /** Best results that scored below the threshold (max 3). */
  nearest: { collection: string; slug: string; anchor: string | null; score: number; coverage: number }[];
}

export interface AccessArgs {
  actor: Actor;
  collection: string;
  doc?: CmsDoc | null;
}

/** How the admin form shows one field (`admin.fields` in the collection). */
export interface FieldAdmin {
  label?: string;
  help?: string;
  widget?: "text" | "textarea" | "number" | "switch" | "select" | "multiselect" | "date" | "tags" | "json";
}

export const ASSET_KINDS = ["image", "video", "audio", "document", "other", "folder"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** A file in a store (`cms_assets`). Documents point at it by `id`. */
export interface CmsAsset {
  /** 12 lowercase letters and digits. */
  id: string;
  store: string;
  /** Path inside the store, e.g. `blog/launch-hero.jpg`. */
  key: string;
  /** Folder part of `key` ("" = top level), without slashes at either end. */
  folder: string;
  name: string;
  kind: AssetKind;
  mime: string;
  /** Bytes. */
  size: number;
  width: number | null;
  height: number | null;
  /** Seconds (video, audio). */
  duration: number | null;
  alt: string;
  tags: string[];
  thumbKey: string | null;
  /** `pending` while it is being uploaded. */
  status: "pending" | "ready";
  uploadId: string | null;
  createdBy: string | null;
  createdByKind: "user" | "key" | "system" | null;
  createdByAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One document's use of a file (`cms_asset_refs`). */
export interface AssetRef {
  assetId: string;
  documentId: string;
  inDraft: boolean;
  inPublished: boolean;
}

export interface CollectionConfig<F extends ZodTypeAny | undefined = ZodTypeAny | undefined, S extends string = string> {
  slug: S;
  label: string;
  /**
   * Required. "public": anyone may read published documents unless
   * `access.read` says otherwise. "internal": `access.read` is required (the
   * CMS refuses to start without it), so nothing is public by accident.
   */
  visibility: "public" | "internal";
  /**
   * Writes only through the host app (the `system` actor). Users and API keys
   * can read it over REST and MCP but never create, edit, publish or delete.
   */
  managed?: boolean;
  /** Allowed category values (null = free text / none). */
  categories?: readonly string[];
  /** zod object for `fields`; parsed (with defaults) on every save. */
  fields?: F;
  versions?: {
    /** Versions kept per document (0 = all). Default 100. */
    max?: number;
    /**
     * true (default): saving a published document makes a draft; the public
     * copy stays until it is published. false: a save to a published
     * document republishes it (a changelog post edited in place).
     */
    drafts?: boolean;
  };
  /** Slug rule override (default: lowercase ascii words joined by hyphens). */
  slugPattern?: RegExp;
  /** Characters the house style bans from title, summary and body. */
  forbiddenChars?: readonly string[];
  search?: {
    /** Index published docs of this collection. Default true. */
    enabled?: boolean;
  };
  /** `[[link:key|label]]` keys: return the URL, or null when the key is unknown. */
  links?: { resolve: (key: string) => string | null };
  /** Public URL of a document (agent results, the editor's public link, preview links). */
  url?: (doc: { slug: string }) => string;
  access?: {
    /** Read published documents. Default for "public": everyone. Required for "internal". */
    read?: (a: AccessArgs) => boolean;
    /** Read drafts and versions; create and edit. */
    write?: (a: AccessArgs) => boolean;
    /** Publish, archive, restore-and-publish, delete. */
    publish?: (a: AccessArgs) => boolean;
  };
  admin?: {
    /** Per field path (`tags`, `seo.title`): label, help text, widget. */
    fields?: Record<string, FieldAdmin>;
  };
  hooks?: {
    /**
     * After every write. `info.contentChanged` is false when only the draft
     * changed (the public copy is the same), e.g. to skip ISR revalidation.
     */
    afterChange?: Array<(doc: CmsDoc, info: { contentChanged: boolean }) => void | Promise<void>>;
  };
}

/** What the admin list shows for a document. */
export interface DocState {
  state: "draft" | "published" | "archived";
  /** Published, and the working copy has changes the public does not see yet. */
  modifiedSincePublish: boolean;
}

/**
 * Display state. The stored status is "draft" when a published document has
 * a newer working copy; the admin shows that as "published, modified".
 */
export function docState(doc: Pick<CmsDoc, "status" | "version" | "publishedVersion">): DocState {
  if (doc.status === "archived") return { state: "archived", modifiedSincePublish: false };
  if (doc.publishedVersion === null) return { state: "draft", modifiedSincePublish: false };
  return { state: "published", modifiedSincePublish: doc.version !== doc.publishedVersion };
}

/** List item without the body (`fields: "summary"` lists). */
export interface DocSummary {
  id: string;
  collection: string;
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  status: DocStatus;
  state: DocState["state"];
  modifiedSincePublish: boolean;
  version: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
  updatedByKind: CmsDoc["updatedByKind"];
  updatedByAgent: string | null;
  hits7d?: number;
}

export interface DocCounts {
  all: number;
  draft: number;
  published: number;
  modified: number;
  archived: number;
}
