import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      http: "src/http.ts",
      mcp: "src/mcp.ts",
      ai: "src/ai.ts",
      client: "src/client.ts",
      tools: "src/tools.ts",
      agent: "src/agent.ts",
      markdown: "src/markdown.ts",
      frontmatter: "src/frontmatter.ts",
      types: "src/types.ts",
      tables: "src/tables.ts",
      cli: "src/cli.ts",
      diff: "src/diff.ts",
      errors: "src/errors.ts",
      config: "src/config.ts",
      "messages/en": "src/messages/en.ts",
      "messages/ko": "src/messages/ko.ts",
    },
    format: ["esm", "cjs"],
    shims: true,
    dts: true,
    clean: true,
    target: "es2022",
    external: ["drizzle-orm", "zod", "ai", "@modelcontextprotocol/sdk", "jiti"],
  },
  {
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    external: ["drizzle-orm", "zod", "ai", "@modelcontextprotocol/sdk", "jiti"],
  },
]);
