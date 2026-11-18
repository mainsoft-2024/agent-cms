/** `npm run build` step: registry sources → dist/registry/*.json (shadcn registry schema). */

import { join } from "node:path";
import { buildRegistry } from "../src/registry";

const root = join(import.meta.dirname ?? __dirname, "..");
const files = buildRegistry(join(root, "registry"), join(root, "dist", "registry"));
console.log(`[agent-cms] registry: ${files.length} files in dist/registry`);
