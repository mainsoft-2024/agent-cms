/**
 * `npm run build` step: registry sources → dist/registry/*.json (read by `agent-cms add`).
 *
 * With `--base-url <url> --out <dir>` it instead writes the registry for the
 * shadcn CLI, served from <url>: `npx shadcn add <url>/cms-shell.json`.
 *   tsx scripts/build-registry.ts --base-url https://example.com/r --out public/r
 */

import { join, resolve } from "node:path";
import { buildPublicRegistry, buildRegistry } from "../src/registry";

const root = join(import.meta.dirname ?? __dirname, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const baseUrl = arg("base-url");
if (baseUrl) {
  const out = resolve(arg("out") ?? "public/r");
  const files = buildPublicRegistry(join(root, "registry"), out, { baseUrl, packageRange: arg("range") });
  console.log(`[agent-cms] shadcn registry: ${files.length} files in ${out} for ${baseUrl}`);
} else {
  const files = buildRegistry(join(root, "registry"), join(root, "dist", "registry"));
  console.log(`[agent-cms] registry: ${files.length} files in dist/registry`);
}
