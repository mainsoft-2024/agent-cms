import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { docFromMarkdown } from "@mainsoft/agent-cms/frontmatter";
import type { SiteCms } from "./cms";

/** Collection → folder under content/ (the starter pages). */
export const CONTENT_DIRS = { docs: "en", "docs-ko": "ko", components: "components", changelog: "changelog" } as const;

export function contentRoot() {
  // content/ is shipped with `outputFileTracingIncludes` in next.config.ts.
  return process.env.DOCS_CONTENT_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "content");
}

/**
 * Put the starter pages into empty collections and publish them, as the
 * system. Local development and CI (pglite) run this on start. A hosted
 * database is seeded on first start when `DOCS_SEED=1`; collections that
 * already have pages are left alone, so from then on the database is the
 * source and edits happen in /admin.
 */
export async function seedIfEmpty(cms: SiteCms, root = contentRoot()): Promise<number> {
  const system = { kind: "system", label: "docs seed" } as const;
  let n = 0;
  for (const [collection, dir] of Object.entries(CONTENT_DIRS) as [keyof typeof CONTENT_DIRS, string][]) {
    if ((await cms.list(system, collection, { drafts: true })).length) continue;
    let files: string[] = [];
    try {
      files = (await readdir(/*turbopackIgnore: true*/ path.join(root, dir))).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const input = docFromMarkdown(await readFile(/*turbopackIgnore: true*/ path.join(root, dir, f), "utf8"), f.replace(/\.md$/, ""));
      await cms.create(system, collection, input as never, { publish: true, note: "starter content" });
      n++;
    }
  }
  return n;
}
