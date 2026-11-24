import type { HtmlPolicy } from "./html-inspect";
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

/** `html` (0.15.0): may add or change HTML blocks and HTML documents (with write). */
export const KEY_SCOPES = ["read", "write", "publish", "admin", "html"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** How a request came in. Used for usage counts (`cms_hits.source`) and the audit log. */
export const VIAS = ["rest", "mcp", "ai", "cli", "app", "automation"] as const;
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
/** One finding of a publish check. */
export interface PublishCheckResult {
  code: string;
  message: string;
  severity: "error" | "warning";
  /** `body`, `title`, `fields.cover`… */
  path?: string;
  /** 1-based body line, when the finding is in the body. */
  line?: number;
}

export interface DocContent {
  slug: string;
  title: string;
  summary: string;
  body: string;
  /** How `body` is written. Absent means "markdown"; "html" only in collections with `body.formats` including it (0.15.0). */
  format?: "markdown" | "html";
  category: string | null;
  keywords: string[];
  fields: Record<string, unknown>;
  /** Search engine and sharing details (0.21.0, collections with `seo`). Absent: none set. */
  seo?: DocSeo | null;
}

/** What a document says to search engines and link previews (0.21.0). Empty parts fall back to the title, summary and first image. */
export interface DocSeo {
  title?: string | null;
  description?: string | null;
  /** A file id from the media library (`asset:` target), or a URL. */
  image?: string | null;
  canonical?: string | null;
  noindex?: boolean;
}

/** One document pointing at another through a relation field (0.21.0). */
export interface DocRef {
  fromId: string;
  toId: string;
  /** The field path, `author` or `related`. */
  field: string;
  inDraft: boolean;
  inPublished: boolean;
}

/** A heading's old anchor that still leads to it (0.21.0). */
export interface AnchorAlias {
  documentId: string;
  old: string;
  current: string;
  createdAt: string;
}

/** An old address that sends readers to a new one (0.21.0). */
export interface CmsRedirect {
  id: string;
  from: string;
  to: string;
  /** The document the target follows (its address is used when it moves again). */
  toDocumentId: string | null;
  status: 301 | 302;
  /** "auto": made when a published document's address changed. "manual": made by a person. */
  source: "auto" | "manual";
  hits: number;
  lastHitAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 0.22.0: where a form submission stands. `spam`: the honeypot was filled, or a person marked it. */
export type FormSubmissionStatus = "new" | "read" | "spam" | "archived";

/** One submission of a form (`cms_form_submissions`, 0.22.0). The address is kept as a hash only. */
export interface FormSubmission {
  id: string;
  formId: string;
  /** The form's version when it was sent (the fields then may differ from now). */
  formVersion: number;
  data: Record<string, unknown>;
  /** Files sent with it: their storage keys, in private storage. */
  files: { field: string; id: string; key: string; name: string; size: number; mime: string }[];
  status: FormSubmissionStatus;
  /** HMAC of the sender's address (never the address itself). */
  ipHash: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A redirect as the admin list shows it (0.21.0). */
export interface RedirectListItem extends CmsRedirect {
  /** Visits over the last 30 days. */
  hits30d: number;
  /** Visits per day over the last 30 days, oldest first (today last). */
  daily: number[];
  /** The document a redirect follows (`toDocumentId`); null when it follows none or the document is gone. */
  target: { id: string; collection: string; slug: string; title: string; published: boolean } | null;
}

/** A starting point for a new document (0.21.0). */
export interface DocTemplate {
  key: string;
  label: string;
  /** One line shown under the label. */
  description?: string;
  /** Lucide-style icon name the admin may show. */
  icon?: string;
  title?: string;
  summary?: string;
  body?: string;
  fields?: Record<string, unknown>;
  /** "code" for templates in the collection config, "admin" for ones saved in the admin. */
  source?: "code" | "admin";
  /** Admin templates: the record id, who made it and when. */
  id?: string;
  createdBy?: string | null;
  createdAt?: string;
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
  /**
   * Set on what a write returns to someone who may change the document but not edit or read its
   * working copy (0.18.0): only the state is real; title, body and fields are empty.
   */
  receipt?: true;
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
  /** In the trash since (null: not deleted). A trashed document is invisible everywhere but the trash. */
  deletedAt: string | null;
  deletedBy: string | null;
  /** A publish or unpublish waiting for its time. */
  schedule: Schedule | null;
  /** The next time the schedule has something to do (for the runner). */
  dueAt: string | null;
  /** An open review request, or the reviewer's answer to it. */
  review: ReviewRequest | null;
  /** The parent in a collection with `tree` (0.21.0). Null: top level. */
  parentId?: string | null;
  /** Order among siblings (a sortable string, 0.21.0). */
  position?: string | null;
  /**
   * The language of this document (0.22.0, collections with `localized`). Absent in apps without
   * `locales` and in collections that are not translated.
   */
  locale?: string;
  /** On a translation: the id of its source document (0.22.0). Absent on sources. */
  groupId?: string | null;
  /** On a translation: the source version it was last aligned to (0.22.0). */
  sourceVersion?: number | null;
  /** Set on a read with `fallback` (0.22.0) when the asked language had nothing to show: the language asked for. */
  requestedLocale?: string;
}

/** What `commit()` records about a version: changed fields and body hunks. */
export type ActorKind = "user" | "key" | "system";

export interface Schedule {
  publishAt: string | null;
  unpublishAt: string | null;
  /** The version that will go public: the one that was current when it was scheduled. */
  version: number;
  by: string;
  byKind: ActorKind;
  byId: string | null;
  byAgent: string | null;
  at: string;
}

export interface ReviewRequest {
  state: "requested" | "changes_requested";
  /** The version under review (moves along while the request is open). */
  version: number;
  by: string;
  byKind: ActorKind;
  byId: string | null;
  byAgent: string | null;
  at: string;
  note: string | null;
  /** Who sent it back, with `changes_requested`. */
  answeredBy?: string | null;
  answeredAt?: string | null;
}

export interface CmsComment {
  id: string;
  documentId: string;
  /** The comment this one answers (one level only), or null. */
  threadId: string | null;
  /** Section anchor (`sectionRanges`), "" for the top of the document. */
  anchor: string;
  /** The text it was written about. */
  quote: string;
  body: string;
  authorKind: ActorKind | "guest";
  authorId: string | null;
  authorLabel: string;
  authorAgent: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ReleaseItem {
  documentId: string;
  collection: string;
  slug: string;
  title: string;
  action: "publish" | "unpublish";
  /** The version pinned when it was added. */
  version: number;
}

export interface CmsRelease {
  id: string;
  name: string;
  /** Items left out of this answer because the reader may not edit those documents (0.18.0). */
  hiddenItems?: number;
  state: "open" | "scheduled" | "published";
  publishAt: string | null;
  items: ReleaseItem[];
  createdBy: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Why the last scheduled run did nothing. */
  lastError: string | null;
}

export interface SavedFilter {
  id: string;
  collection: string;
  name: string;
  query: Record<string, string>;
  ownerId: string;
  ownerLabel: string;
  /** Visible to everyone who can edit the collection. */
  shared: boolean;
  createdAt: string;
}

export interface Presence {
  documentId: string;
  actorId: string;
  label: string;
  kind: ActorKind;
  agent: string | null;
  /** Editor position: line and column of the cursor, and of the other end of a selection. */
  cursor: { line: number; ch: number } | null;
  selection: { line: number; ch: number } | null;
  seenAt: string;
}

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
  /** A name someone gave this version ("launch copy"). */
  label: string | null;
  /** Pinned versions are never pruned. */
  pinned: boolean;
  /** Who approved this version in a review. */
  approvedBy: string | null;
  approvedAt: string | null;
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
  /** Requests per minute for this key. Null: the default of `createCms({ rateLimit })`. */
  rateLimit?: number | null;
  /** Addresses and ranges the key may be used from ("203.0.113.7", "10.0.0.0/8"). Empty: anywhere. */
  allowedIps?: string[];
  /** Why it was revoked (a person's note, or "rotated"). */
  revokedReason?: string | null;
  /** The key that replaced this one (`rotateKey`). */
  rotatedTo?: string | null;
}

export const AUDIT_ACTIONS = [
  "auth.setup",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.invite",
  "auth.invite_revoke",
  "auth.accept",
  "auth.reset_link",
  "auth.reset",
  "auth.password",
  "auth.mfa_on",
  "auth.mfa_off",
  "auth.recovery",
  "auth.passkey_add",
  "auth.passkey_remove",
  "auth.user_update",
  "auth.sessions_end",
  "auth.policy",
  "doc.suggest",
  "doc.suggest.apply",
  "doc.suggest.reject",
  "key.rotate",
  "retention.run",
  "key.create",
  "key.revoke",
  "webhook.create",
  "webhook.update",
  "webhook.delete",
  "webhook.disable",
  "webhook.secret_view",
  "automation.create",
  "automation.update",
  "automation.delete",
  "plugin.restart",
  "plugin.settings",
  "role.create",
  "role.update",
  "role.delete",
  "role.member.add",
  "role.member.remove",
  "import.run",
  "doc.publish",
  "doc.unpublish",
  "doc.archive",
  "doc.unarchive",
  "doc.delete",
  "doc.restore",
  "doc.undelete",
  "doc.purge",
  "doc.schedule",
  "doc.unschedule",
  "review.request",
  "review.approve",
  "review.reject",
  "release.publish",
  "asset.restore",
  "asset.replace",
  "preview.create",
  "asset.upload",
  "asset.move",
  "asset.delete",
  "asset.download",
  "asset.register",
  "asset.share",
  "access.denied",
  "auth.failed",
  // 0.21.0
  "doc.move",
  "redirect.create",
  "redirect.update",
  "redirect.delete",
  "template.create",
  "template.update",
  "template.delete",
  // 0.22.0
  "doc.translate",
  "doc.align",
  "form.create",
  "form.update",
  "form.delete",
  "form.submission_update",
  "form.submission_delete",
  "form.export",
  "form.file_open",
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
  /**
   * 0.21.0: "relation" (documents, from `relation()`), "gallery" (several files, from `assetIds()`),
   * "rows" (a list of objects) and "group" (an object) are chosen from the schema when left out.
   */
  widget?: "text" | "textarea" | "number" | "switch" | "select" | "multiselect" | "date" | "tags" | "json" | "image" | "file" | "gallery" | "relation" | "rows" | "group";
  /**
   * For `image` and `file` (the value is a media library file id): which
   * files the field takes, as MIME types (`image/png`), groups (`image/*`)
   * or extensions (`.pdf`). Applied on top of the store's own rule. Default
   * for `image`: `["image/*"]`.
   */
  accept?: readonly string[];
  /** For `image` and `file`: largest file (bytes) the field takes. */
  maxFileSize?: number;
  /** For `image` and `file`: the only store the field picks from and uploads to. */
  store?: string;
  /**
   * 0.22.0, collections with `localized`: whether translations have their own value of this field.
   * Default: true for text (`z.string()` without a format, and lists of them), false for everything
   * else (numbers, dates, switches, choices, relations, files, nested objects), which follows the source.
   */
  localized?: boolean;
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
  /** The point of an image that must stay in view when it is cropped (0..1 from the left and from the top), or null. */
  focalX: number | null;
  focalY: number | null;
  /** How many times the content was replaced at the same address. */
  rev: number;
  /** `pending` while it is being uploaded. */
  status: "pending" | "ready";
  uploadId: string | null;
  createdBy: string | null;
  createdByKind: "user" | "key" | "system" | null;
  createdByAgent: string | null;
  createdAt: string;
  updatedAt: string;
  /** In the trash since (null: not deleted). The object stays in the store until it is purged. */
  deletedAt: string | null;
  deletedBy: string | null;
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
  /**
   * Documents form a tree (0.21.0): each has a parent and a place among its siblings, moved with
   * `cms.move()`. `maxDepth` (default 3) counts levels from the top. Off by default.
   */
  tree?: boolean | { maxDepth?: number };
  /** One document only (0.21.0, made by `defineSingle`): site settings, a footer. Read with `cms.single()`. */
  single?: boolean;
  /** Starting points for a new document (0.21.0). Editors can add their own in the admin. */
  templates?: readonly DocTemplate[];
  /** Documents of this collection are snippets (0.21.0): `[[snippet:slug]]` in other bodies shows their published body. */
  snippets?: boolean;
  /**
   * Search engine details per document (0.21.0): title, description, share image, canonical,
   * noindex. Checks warn above `titleMax` (60) and `descriptionMax` (160) characters.
   */
  seo?: boolean | { titleMax?: number; descriptionMax?: number };
  /** Characters the house style bans from title, summary and body. */
  forbiddenChars?: readonly string[];
  search?: {
    /** Index published docs of this collection. Default true. */
    enabled?: boolean;
  };
  /** `[[link:key|label]]` keys: return the URL, or null when the key is unknown. */
  links?: { resolve: (key: string) => string | null };
  /**
   * Public URL of a document (agent results, the editor's public link, preview links). In a localized
   * collection (0.22.0) it also gets the `locale`, so each translation has its own address (sitemap `hreflang`).
   */
  url?: (doc: { slug: string; locale?: string }) => string;
  /**
   * Documents of this collection are translated (0.22.0): needs `createCms({ locales, defaultLocale })`.
   * Each translation is a document of its own (versions, drafts, publishing) with the same slug.
   */
  localized?: boolean;
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
    /** Hide the body in the admin form (0.21.0; `defineSingle` sets it unless `body: true`). */
    hideBody?: boolean;
  };
  media?: {
    /** true: an image without alt text is an error, not a warning. */
    requireAlt?: boolean;
  };
  /** Body formats this collection takes (0.15.0). Default `["markdown"]`. Add "html" for whole-HTML documents (landing pages, newsletters). */
  body?: { formats?: readonly ("markdown" | "html")[] };
  /**
   * HTML blocks (`:::html`) and HTML documents (0.15.0). HTML is saved exactly as written; this decides how it is drawn
   * and who may add it. Default: drawn safely (sanitized), added by admins, roles with "html" and keys with the "html" scope.
   */
  html?: HtmlPolicy & {
    /** Who may add or change HTML (instead of admins and the "html" role permission). */
    access?: (a: AccessArgs) => boolean;
    /** Who may add or change HTML that runs in an isolated frame (instead of admins and "html_scripts"). */
    scripts?: (a: AccessArgs) => boolean;
  };
  /**
   * What an agent's edit does (API keys and agents acting for a person). "apply" (default): a new version
   * right away. "suggest": the edit is kept as a suggestion a person applies or rejects in the editor.
   */
  agentEdits?: "apply" | "suggest";
  /**
   * Your own checks before publishing (also shown in the editor's publish dialog and in `diagnose`).
   * An "error" stops publishing; a "warning" can be published anyway.
   */
  publishChecks?: Array<(doc: DocContent, ctx: { collection: string; slug: string }) => PublishCheckResult[] | void | Promise<PublishCheckResult[] | void>>;
  /**
   * Who needs another person's approval before publishing. `agents`: API
   * keys and agents acting for a person. `everyone`: people too (nobody
   * approves their own request). Default: nobody.
   */
  review?: { agents?: "required"; everyone?: "required" };
  /**
   * Who may see and change single fields (113, 0.17.0), by path in `fields` (`price`, `seo.title`).
   * `read: false` hides the value from that reader (and from the admin form); `write: false` makes
   * it read-only: a save that changes it is refused with `forbidden_field`, and a save that leaves
   * it out keeps the stored value. Runs on every read, so keep it fast.
   */
  fieldAccess?: Record<string, { read?: (a: { actor: Actor; doc: CmsDoc }) => boolean; write?: (a: { actor: Actor; doc: CmsDoc | null }) => boolean }>;
  /**
   * Hooks for single fields (93), by path in `fields`. `beforeChange` returns the value to store
   * (normalise a phone number, fill a default); `afterRead` returns the value a reader gets
   * (format, mask). Throw in `beforeChange` to refuse the save with your message.
   */
  fieldHooks?: Record<string, { beforeChange?: (value: unknown, ctx: { actor: Actor; prev: unknown; doc: CmsDoc | null }) => unknown | Promise<unknown>; afterRead?: (value: unknown, ctx: { actor: Actor; doc: CmsDoc; draft: boolean }) => unknown | Promise<unknown> }>;
  hooks?: {
    /**
     * Before anything is read from this collection (one document, a list, a page). Throw to refuse:
     * the reader gets `hook_rejected` with your message (a paywall, a region rule, a maintenance window).
     */
    beforeRead?: Array<(ctx: { actor: Actor; collection: string; slug: string | null; draft: boolean }) => void | Promise<void>>;
    /**
     * Before the content is checked against the collection's rules (create, update, patch, restore).
     * Return fields to change them: fill a slug from the title, trim, set defaults. Throw to refuse.
     */
    beforeValidate?: Array<(change: HookInput) => void | Partial<DocContent> | Promise<void | Partial<DocContent>>>;
    /** After a version went public. Like `afterChange`, it never blocks the write; errors go to `onError`. */
    afterPublish?: Array<(doc: CmsDoc) => void | Promise<void>>;
    /** After a document was deleted (moved to the trash, or gone when there is no trash). */
    afterDelete?: Array<(doc: CmsDoc) => void | Promise<void>>;
    /**
     * Before a document leaves `get`, `list` or `page` (0.17.0: lists too, with `list: true`):
     * return a changed copy to add or hide values for this reader. Runs for every document a
     * reader gets, so keep it fast. Throw to refuse the read.
     */
    afterRead?: Array<(doc: CmsDoc, ctx: { actor: Actor; draft: boolean; list?: boolean }) => void | CmsDoc | Promise<void | CmsDoc>>;
    /**
     * Before a save that makes a version (create, update, patch, restore; not autosave). Return
     * fields to change them (`{ keywords: [...] }`); the result is validated again. Throw to refuse:
     * the caller gets `hook_rejected` with your message.
     */
    beforeChange?: Array<(change: HookChange) => void | Partial<DocContent> | Promise<void | Partial<DocContent>>>;
    /** Before a version goes public (publish, a schedule, a release, an approval). Throw to refuse. */
    beforePublish?: Array<(doc: HookDoc) => void | Promise<void>>;
    /** Before a document is deleted (moved to the trash). Throw to refuse. */
    beforeDelete?: Array<(doc: HookDoc) => void | Promise<void>>;
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
  /** 0.22.0: the language (localized collections only). */
  locale?: string;
  /** 0.22.0, lists with `fallback`: the language asked for when this row is the default language's. */
  requestedLocale?: string;
  /**
   * 0.22.0, editors' lists with `translations` (source rows of a localized collection): how each other
   * language stands against this document: `missing`, `outdated` or `current`.
   */
  translations?: Record<string, "missing" | "outdated" | "current">;
  schedule: Pick<Schedule, "publishAt" | "unpublishAt" | "version" | "by"> | null;
  review: Pick<ReviewRequest, "state" | "version" | "by" | "note"> | null;
}

export interface DocCounts {
  all: number;
  draft: number;
  published: number;
  modified: number;
  archived: number;
  scheduled: number;
  review: number;
}

/** Work written down to run later, outside a request (`cms.jobs`). */
export interface CmsJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt: string;
  /** How many times it has been started. */
  attempts: number;
  maxAttempts: number;
  lockedUntil: string | null;
  lastError: string | null;
  doneAt: string | null;
  /** Set when the last allowed attempt failed. */
  failedAt: string | null;
  createdAt: string;
}

export const WEBHOOK_EVENTS = [
  "doc.created",
  "doc.updated",
  "doc.published",
  "doc.unpublished",
  "doc.archived",
  "doc.deleted",
  "doc.restored",
  "review.requested",
  "review.approved",
  "review.rejected",
  "asset.uploaded",
  "asset.moved",
  "asset.deleted",
  "release.published",
  "comment.created",
  "doc.moved",
  "form.submitted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/**
 * 0.22.2: the subscription of a webhook that only automations send to (`events: ["automation"]`).
 * It matches no event, so the webhook gets what an automation's "send a webhook" action sends and
 * nothing else.
 */
export const WEBHOOK_AUTOMATION_ONLY = "automation" as const;
/** What a webhook can subscribe to: events, or only what automations send. */
export type WebhookSubscription = WebhookEvent | typeof WEBHOOK_AUTOMATION_ONLY;

export interface CmsWebhook {
  id: string;
  name: string;
  url: string;
  /** Empty = every event. `["automation"]` = only what automations send (0.22.2). */
  events: WebhookSubscription[];
  /** Empty = every collection. Events without a collection (files, releases) always pass. */
  collections: string[];
  /** The signing secret, sealed with `secretsKey`. Never leaves the server as is. */
  secretEnc: string;
  enabled: boolean;
  /** Failed deliveries in a row. */
  failures: number;
  /** Why it was switched off by the CMS, when it was. */
  disabledReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  /** HTTP status, or null when no answer came. */
  status: number | null;
  ok: boolean;
  responseMs: number | null;
  attempt: number;
  error: string | null;
  at: string;
}

/**
 * A small object the CMS keeps for itself (`cms_records`): an automation, a run of one, a role.
 * `kind` says what it is, `scope` groups rows (the runs of one automation), `key` is unique
 * within a kind when set.
 */
export interface CmsRecord<T = Record<string, unknown>> {
  id: string;
  kind: string;
  scope: string;
  key: string | null;
  data: T;
  createdAt: string;
  updatedAt: string;
}

/** What a `beforeValidate` hook gets: the input as it was sent, before any check. */
export interface HookInput {
  collection: string;
  input: Partial<DocContent>;
  /** The document as it is now; null when it is being created. */
  prev: CmsDoc | null;
  actor: Actor;
}
/** What a `beforeChange` hook gets. */
export interface HookChange {
  collection: string;
  slug: string;
  content: DocContent;
  /** The document as it is now; null when it is being created. */
  prev: CmsDoc | null;
  actor: Actor;
}
/** What `beforePublish` and `beforeDelete` hooks get. */
export interface HookDoc {
  collection: string;
  slug: string;
  content: DocContent;
  version: number;
  actor: Actor;
}
