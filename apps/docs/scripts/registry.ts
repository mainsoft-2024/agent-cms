/**
 * Build the shadcn registry into public/r, with item URLs on this site:
 *   npx shadcn add https://<site>/r/cms-shell.json
 * Runs before `next build` (see vercel.json).
 */
import { join } from "node:path";
import { buildPublicRegistry } from "../../../src/registry";
import { siteUrl } from "../lib/site";

const out = join(import.meta.dirname, "..", "public", "r");
const files = buildPublicRegistry(join(import.meta.dirname, "..", "..", "..", "registry"), out, { baseUrl: `${siteUrl()}/r` });
console.log(`[docs] registry: ${files.length} files in public/r for ${siteUrl()}/r`);
