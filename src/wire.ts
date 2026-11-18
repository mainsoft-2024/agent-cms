/** Types the REST client sends and receives (re-exported for the admin screens). Type-only, browser-safe. */

export type { AuditEntry, AutosaveState, CmsDoc, CmsKey, CmsVersion, DocCounts, DocSummary, KeyScope, VersionSummary } from "./types";

/** A document body for create / update over REST. */
export interface DocInputWire {
  slug?: string;
  title?: string;
  summary?: string;
  body?: string;
  category?: string | null;
  keywords?: string[];
  fields?: Record<string, unknown>;
}
