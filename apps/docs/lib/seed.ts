import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { docFromMarkdown } from "@mainsoft/agent-cms/frontmatter";
import { sql } from "drizzle-orm";
import type { SiteCms } from "./cms";
import { db } from "./db";

/** Collection → folder under content/ (the starter pages). */
export const CONTENT_DIRS = { docs: "en", "docs-ko": "ko", components: "components", changelog: "changelog" } as const;

export function contentRoot() {
  // content/ is shipped with `outputFileTracingIncludes` in next.config.ts.
  return process.env.DOCS_CONTENT_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "content");
}

const SEED = "docs seed";
const system = { kind: "system", label: SEED } as const;

/**
 * Keep the starter pages (content/*.md) and the database in step, as the
 * system. Local development and CI (pglite) run this on start; a hosted
 * database runs it when `DOCS_SEED=1`.
 *
 * - A page the database does not have is created and published.
 * - A page whose file changed is updated and published, but only while its
 *   latest version is still the seed's. Once someone (a person or an agent)
 *   edits a page in the CMS, the database is its source and the file is ignored.
 * - Nothing is ever deleted: a page whose file is gone stays until someone removes it.
 *
 * `site_starter_pages` remembers the hash of each file it has handled, so a
 * start with nothing new costs one query.
 *
 * A Korean page is stamped with the English page's version at the time its
 * file is handled (`sourceVersion`): the two files are written together, so
 * a Korean file that changed is a translation of the English page as it is
 * now. When only the English file changes later, the stamp stays behind and
 * the Korean page says that the English one is newer, which is then true.
 */
/** Bump to have every Korean page handled once more (the stamp used to stay at the file's `sourceVersion: 1`). */
const KO_STAMP = "ko-stamp-2";
export async function syncStarter(cms: SiteCms, root = contentRoot()): Promise<{ created: number; updated: number; kept: number }> {
  const d = await db();
  const seen = new Map<string, string>();
  for (const r of (await d.execute(sql`select collection, slug, hash from site_starter_pages`)).rows as { collection: string; slug: string; hash: string }[]) seen.set(`${r.collection}/${r.slug}`, r.hash);
  const out = { created: 0, updated: 0, kept: 0 };
  for (const [collection, dir] of Object.entries(CONTENT_DIRS) as [keyof typeof CONTENT_DIRS, string][]) {
    let files: string[] = [];
    try {
      files = (await readdir(/*turbopackIgnore: true*/ path.join(root, dir))).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const text = await readFile(/*turbopackIgnore: true*/ path.join(root, dir, f), "utf8");
      const hash = createHash("sha256").update(collection === "docs-ko" ? `${text}\n${KO_STAMP}` : text).digest("hex").slice(0, 32);
      const input = docFromMarkdown(text, f.replace(/\.md$/, ""));
      const slug = String(input.slug);
      if (seen.get(`${collection}/${slug}`) === hash) continue;
      try {
        const cur = await cms.get(system, collection, slug, { draft: true }).catch(() => null);
        let stamped = false;
        if (collection === "docs-ko") {
          const english = await cms.get(system, "docs", slug).catch(() => null);
          if (english?.publishedVersion) {
            input.fields = { ...(input.fields ?? {}), sourceVersion: english.publishedVersion };
            stamped = Number((cur?.fields as { sourceVersion?: number } | undefined)?.sourceVersion ?? 0) !== english.publishedVersion;
          }
        }
        if (!cur) {
          await cms.create(system, collection, input as never, { publish: true, note: "starter content" });
          out.created++;
        } else if (cur.updatedBy !== SEED) {
          out.kept++; // edited in the CMS: that version wins
        } else if (stamped || cur.title !== (input.title ?? cur.title) || cur.body.trim() !== String(input.body ?? "").trim() || cur.summary !== (input.summary ?? "") || (input.category ?? null) !== cur.category) {
          await cms.update(system, collection, slug, input as never, { publish: true, note: "starter content updated" });
          out.updated++;
        }
        await d.execute(sql`INSERT INTO site_starter_pages (collection, slug, hash) VALUES (${collection}, ${slug}, ${hash})
          ON CONFLICT (collection, slug) DO UPDATE SET hash = excluded.hash, updated_at = now()`);
      } catch (e) {
        // One bad page (a slug in the trash, a failed check) must not stop the site from starting.
        console.error(`[seed] ${collection}/${slug}`, e);
      }
    }
  }
  return out;
}
