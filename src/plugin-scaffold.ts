/**
 * The files `npx @mainsoft/agent-cms plugin init <name>` writes (0.24.0): a plugin package with
 * a server half, an admin page, a test and a README. Kept apart from the CLI so it can be tested
 * and read on its own.
 */

import { RESERVED_ROUTES } from "./cms";
import { PLUGIN_NAME } from "./plugin";

/** Whether a name works for a plugin: lowercase letters, digits and dashes, 2 to 31 characters, not a route of the CMS. */
export const validPluginName = (name: string): boolean => PLUGIN_NAME.test(name) && !RESERVED_ROUTES.has(name);

/** The files of a new plugin, by path inside its folder. `version` is the agent-cms it is made for. */
export function pluginScaffold(name: string, version: string): Record<string, string> {
  if (!validPluginName(name)) throw new Error(`plugin name "${name}" must be lowercase letters, digits and dashes (2 to 31 characters, a letter first) and not a route of the CMS (${[...RESERVED_ROUTES].filter((r) => PLUGIN_NAME.test(r)).join(", ")})`);
  const [major, minor] = version.split(/[.-]/);
  const range = `${major}.${minor}`;
  const tool = `${name.replace(/-/g, "_")}_hello`;
  const fill = (s: string) => s.replaceAll("__NAME__", name).replaceAll("__TOOL__", tool).replaceAll("__RANGE__", range).replaceAll("__VERSION__", version);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        description: `An agent-cms plugin: ${name}`,
        type: "module",
        exports: { ".": "./src/index.ts", "./admin": "./src/admin.tsx" },
        files: ["src"],
        scripts: { test: "node --import tsx --test src/*.test.ts", typecheck: "tsc --noEmit" },
        peerDependencies: { "@mainsoft/agent-cms": `^${version}`, react: ">=18", zod: "^3.25.0 || ^4.0.0" },
        peerDependenciesMeta: { react: { optional: true } },
        devDependencies: { "@mainsoft/agent-cms": `^${version}`, "@types/node": "^22.0.0", "@types/react": "^19.0.0", react: "^19.0.0", tsx: "^4.20.0", typescript: "^5.9.0", zod: "^3.25.0" },
      },
      null,
      2
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, isolatedModules: true, types: ["node"] },
        include: ["src"],
      },
      null,
      2
    )}\n`,
    "src/index.ts": fill(`/**
 * __NAME__: the server half. Give it to the CMS:
 *
 *   import myPlugin from "__NAME__";
 *   createCms({ ..., plugins: [myPlugin({ greeting: "Hi" })] });
 */
import { definePlugin } from "@mainsoft/agent-cms";
import { z } from "zod";

export default definePlugin({
  name: "__NAME__",
  version: "0.1.0",
  // The agent-cms versions this plugin works with (checked by createCms).
  engine: ">=__RANGE__",
  // Options the app passes in code. Checked, with defaults filled in.
  options: z.object({ greeting: z.string().default("Hello") }),
  setup(ctx, options) {
    // GET /api/cms/__NAME__/hello
    ctx.route("GET", "hello", async ({ actor }) => {
      const count = ((await ctx.store.get<number>("count")) ?? 0) + 1;
      await ctx.store.set("count", count);
      const who = actor.kind === "user" ? actor.label : "there";
      return Response.json({ message: options.greeting + ", " + who, count });
    });
    // A tool agents can call (MCP, callTool).
    ctx.tool({
      name: "__TOOL__",
      description: "Say hello and tell how many times the hello route was called.",
      input: z.object({ name: z.string().max(80).optional() }),
      run: async (_actor, input: { name?: string }) => ({
        message: options.greeting + ", " + (input.name ?? "there"),
        count: (await ctx.store.get<number>("count")) ?? 0,
      }),
    });
  },
});
`),
    "src/admin.tsx": fill(`/**
 * __NAME__: the admin half. Give it to the admin's provider:
 *
 *   import myPluginAdmin from "__NAME__/admin";
 *   <CmsProvider plugins={[myPluginAdmin]}>…</CmsProvider>
 *
 * The page shows at /admin/p/__NAME__.
 */
import * as React from "react";
import { defineAdminPlugin, useCmsAdmin, usePluginT, type PluginPageProps } from "@mainsoft/agent-cms/react";

function HelloPage(_props: PluginPageProps) {
  const { client } = useCmsAdmin();
  const t = usePluginT("__NAME__");
  const [hello, setHello] = React.useState<{ message: string; count: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    client
      .request<{ message: string; count: number }>("GET", "/__NAME__/hello")
      .then(setHello)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);
  return (
    <div className="space-y-2 p-6">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {hello ? <p className="text-sm">{t("said", { message: hello.message, count: hello.count })}</p> : <p className="text-sm text-muted-foreground">{t("loading")}</p>}
    </div>
  );
}

export default defineAdminPlugin({
  name: "__NAME__",
  label: { en: "__NAME__", ko: "__NAME__" },
  pages: { "": HelloPage },
  messages: {
    en: { title: "Hello", said: "{message} (called {count} times)", loading: "Loading…" },
    ko: { title: "인사", said: "{message} ({count}번 부름)", loading: "불러오는 중" },
  },
});
`),
    "src/index.test.ts": fill(`import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestCms } from "@mainsoft/agent-cms/testing";
import plugin from "./index";

test("the hello route counts its calls", async () => {
  const t = createTestCms({ plugins: [plugin({ greeting: "Hi" })] });
  try {
    await t.ready();
    const res = await t.fetch("/__NAME__/hello");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { message: "Hi, Admin", count: 1 });
    const anon = await t.fetch("/__NAME__/hello", {}, { as: "anon" });
    assert.deepEqual(await anon.json(), { message: "Hi, there", count: 2 });
  } finally {
    await t.close();
  }
});

test("the tool says hello", async () => {
  const t = createTestCms({ plugins: [plugin] });
  try {
    const r = await t.tool("__TOOL__", { name: "Kim" }, { as: "writer" });
    assert.deepEqual(r, { ok: true, value: { message: "Hello, Kim", count: 0 } });
  } finally {
    await t.close();
  }
});
`),
    "README.md": fill(`# __NAME__

An [agent-cms](https://github.com/mainsoft-2024/agent-cms) plugin.

## Use it

Server (where you call \`createCms\`):

~~~ts
import helloPlugin from "__NAME__";

export const cms = createCms({ repo, collections, plugins: [helloPlugin({ greeting: "Hi" })] });
~~~

Admin (the frame around the admin screens):

~~~tsx
import helloAdmin from "__NAME__/admin";

<CmsProvider plugins={[helloAdmin]}>{children}</CmsProvider>
~~~

It adds:

- \`GET /api/cms/__NAME__/hello\`: a greeting and how many times it was called
- the tool \`__TOOL__\` for agents (MCP and \`callTool\`)
- a page at \`/admin/p/__NAME__\`

## Work on it

~~~sh
npm install
npm test          # src/index.test.ts, with @mainsoft/agent-cms/testing (a CMS in memory)
npm run typecheck
~~~

The package ships its TypeScript sources (\`exports\` point at \`src/\`). A Next.js app needs it in
\`transpilePackages\`; to publish for plain Node, build it first (tsup, tsc) and point \`exports\` at the output.

Made with \`npx @mainsoft/agent-cms plugin init __NAME__\` (agent-cms __VERSION__).
`),
    ".gitignore": "node_modules\n",
  };
  return files;
}
