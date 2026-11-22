/**
 * `npx @mainsoft/agent-cms dev`: a CMS on this computer without setting
 * anything up. Uses the app's `server.cms` from agent-cms.config.ts when there
 * is one; otherwise a "Posts" collection kept in `.agent-cms/dev` (with
 * PGlite when it is installed: `npm i -D @electric-sql/pglite`; in memory
 * otherwise, and then gone when it stops). Secrets for previews and
 * webhooks are made once and kept in `.agent-cms/dev/secrets.json`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createCms, defineCollection, type Cms } from "./cms";
import { MemoryRepo } from "./repo";

export interface DevCms {
  cms: Cms;
  /** "pglite" (kept between runs) or "memory". */
  store: "pglite" | "memory";
  dir: string;
}

function secrets(dir: string): { preview: string; secrets: string } {
  const file = join(dir, "secrets.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as { preview: string; secrets: string };
  const s = { preview: randomBytes(32).toString("base64url"), secrets: randomBytes(32).toString("base64url") };
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

export const devPosts = defineCollection({
  slug: "posts",
  label: "Posts",
  visibility: "public",
  fields: z.object({ tags: z.array(z.string()).default([]) }),
  admin: { fields: { tags: { label: "Tags", widget: "tags" } } },
});

export async function devCms(cwd: string, log: (l: string) => void, o: { memory?: boolean } = {}): Promise<DevCms> {
  const dir = join(cwd, ".agent-cms", "dev");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(cwd, ".agent-cms", ".gitignore"))) writeFileSync(join(cwd, ".agent-cms", ".gitignore"), "dev/\n");
  const s = secrets(dir);
  let repo: unknown = null;
  let store: DevCms["store"] = "memory";
  if (!o.memory) {
    try {
      const { PGlite } = (await import("@electric-sql/pglite" as string)) as { PGlite: new (dir: string) => unknown };
      const { drizzle } = (await import("drizzle-orm/pglite" as string)) as { drizzle: (c: unknown) => { execute: (q: unknown) => Promise<unknown> } };
      const { sql } = await import("drizzle-orm");
      const { DrizzleRepo } = await import("./drizzle-repo");
      const { cmsDdl, splitSql } = await import("./tables");
      const db = drizzle(new PGlite(join(dir, "db")));
      for (const stmt of splitSql(cmsDdl())) await db.execute(sql.raw(stmt));
      repo = new DrizzleRepo(db as never);
      store = "pglite";
    } catch (e) {
      const missing = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(String(e));
      log(missing ? "[agent-cms] keeping documents in memory (they are gone when this stops). To keep them: npm i -D @electric-sql/pglite" : `[agent-cms] PGlite failed (${e instanceof Error ? e.message : String(e)}); keeping documents in memory`);
    }
  }
  const cms = createCms({
    repo: (repo as never) ?? new MemoryRepo(),
    collections: [devPosts],
    previewSecret: s.preview,
    secretsKey: s.secrets,
  }) as unknown as Cms;
  return { cms, store, dir };
}
