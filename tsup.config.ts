import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/http.ts", "src/mcp.ts", "src/agent.ts", "src/markdown.ts", "src/types.ts", "src/tables.ts", "src/cli.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2022",
    external: ["drizzle-orm", "zod"],
  },
  {
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
