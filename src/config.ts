/**
 * `agent-cms.config.ts`: what the local CLI commands (`init`, `doctor`,
 * `migrate`, `add`, `storage`) need to know about the app. Loaded with jiti, so it can
 * be TypeScript and import the app's own modules.
 *
 *   import { defineConfig } from "@mainsoft/agent-cms/config";
 *   export default defineConfig({
 *     db: async () => (await import("./lib/db")).db,
 *   });
 */

import type { PgDatabase } from "drizzle-orm/pg-core";
import type { MediaOptions } from "./assets";
import type { CmsTablesOptions } from "./tables";

export interface AgentCmsConfig {
  /** The app's Drizzle database (for `doctor` and `migrate`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: () => PgDatabase<any, any, any> | Promise<PgDatabase<any, any, any>>;
  /** Same options as `cmsTables()` when the app uses a prefix or schema. */
  tables?: CmsTablesOptions;
  /** The same `media` the app passes to `createCms` (for `agent-cms storage check | cleanup`). */
  media?: MediaOptions | (() => MediaOptions | Promise<MediaOptions>);
  /** Where `agent-cms add` copies the admin screens. Default: `<components alias>/cms` from components.json. */
  ui?: { dir?: string };
}

export function defineConfig(c: AgentCmsConfig): AgentCmsConfig {
  return c;
}

export const CONFIG_FILES = ["agent-cms.config.ts", "agent-cms.config.mts", "agent-cms.config.js", "agent-cms.config.mjs"] as const;

/** Find and load the config from `cwd` (null when there is none). */
export async function loadConfig(cwd: string): Promise<{ path: string; config: AgentCmsConfig } | null> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const f of CONFIG_FILES) {
    const path = join(cwd, f);
    if (!existsSync(path)) continue;
    const { createJiti } = await import("jiti");
    const jiti = createJiti(join(cwd, "_"), { interopDefault: true });
    const mod = (await jiti.import(path)) as AgentCmsConfig | { default: AgentCmsConfig };
    const config = (mod && "default" in mod ? mod.default : mod) as AgentCmsConfig;
    return { path, config: config ?? {} };
  }
  return null;
}
