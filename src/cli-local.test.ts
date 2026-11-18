import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "./cli";
import type { Registry } from "./registry";
import { resolveItems, rewriteImports, shadcnParts } from "./registry";

function app(o: { src?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-cms-app-"));
  writeFileSync(join(dir, "components.json"), JSON.stringify({ aliases: { components: "@/components", ui: "@/components/ui", utils: "@/lib/utils" } }));
  writeFileSync(join(dir, "tsconfig.json"), `{ // comment\n "compilerOptions": { "paths": { "@/*": ["./${o.src ? "src/" : ""}*"] } }, }`);
  if (o.src) mkdirSync(join(dir, "src", "app"), { recursive: true });
  mkdirSync(join(dir, o.src ? "src/components/ui" : "components/ui"), { recursive: true });
  writeFileSync(join(dir, o.src ? "src/components/ui/button.tsx" : "components/ui/button.tsx"), "export {}");
  return dir;
}

const registry = (v: string): Registry => ({
  name: "agent-cms",
  items: [
    { name: "cms-lib", type: "registry:lib", files: [{ path: "registry/cms/use-cms.ts", type: "registry:lib", content: `export const v = "${v}";\n` }] },
    {
      name: "cms-doc-list",
      type: "registry:component",
      description: "Document list",
      registryDependencies: ["cms-lib", "button", "checkbox"],
      files: [{ path: "registry/cms/cms-doc-list.tsx", type: "registry:component", content: `import { Button } from "@/components/ui/button";\nimport { cn } from "@/lib/utils";\nimport { v } from "./use-cms";\nexport const list = "${v}";\n` }],
    },
  ],
});

const quiet = (cwd: string, reg: Registry, lines: string[] = []) => ({ cwd, registry: reg, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), run: () => 0 });

test("registry: dependency order, shadcn parts, alias rewrite", () => {
  const reg = registry("1");
  assert.deepEqual(resolveItems(reg, ["cms-doc-list"]).map((i) => i.name), ["cms-lib", "cms-doc-list"]);
  assert.deepEqual(shadcnParts(reg, reg.items), ["button", "checkbox"]);
  assert.equal(rewriteImports(`from "@/components/ui/button"; from '@/lib/utils'`, { ui: "~/ui", utils: "~/lib/cn" }), `from "~/ui/button"; from '~/lib/cn'`);
  assert.throws(() => resolveItems(reg, ["nope"]), /unknown item "nope"/);
});

test("add: copies items with dependencies, rewrites aliases, lists missing parts, writes the lock", async () => {
  const dir = app({ src: true });
  const lines: string[] = [];
  assert.equal(await runCli(["add", "cms-doc-list"], quiet(dir, registry("1"), lines)), 0);
  const file = join(dir, "src/components/cms/cms-doc-list.tsx");
  assert.ok(existsSync(file));
  assert.ok(existsSync(join(dir, "src/components/cms/use-cms.ts")));
  const lock = JSON.parse(readFileSync(join(dir, "agent-cms.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.files).sort(), ["src/components/cms/cms-doc-list.tsx", "src/components/cms/use-cms.ts"]);
  assert.equal(lock.files["src/components/cms/cms-doc-list.tsx"].item, "cms-doc-list");
  assert.ok(lines.some((l) => l.includes("npx shadcn@latest add checkbox")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("add button")), "button exists already");
  // Adding again never overwrites.
  lines.length = 0;
  await runCli(["add", "cms-doc-list"], quiet(dir, registry("1"), lines));
  assert.ok(lines.some((l) => l.startsWith("same")));
});

test("add --diff and --update: untouched files update, edited files get a .new copy", async () => {
  const dir = app();
  await runCli(["add", "cms-doc-list"], quiet(dir, registry("1")));
  const list = join(dir, "components/cms/cms-doc-list.tsx");
  const lib = join(dir, "components/cms/use-cms.ts");
  writeFileSync(list, readFileSync(list, "utf8") + "// my change\n");

  const lines: string[] = [];
  assert.equal(await runCli(["add", "--diff"], quiet(dir, registry("2"), lines)), 0);
  const diff = lines.join("\n");
  assert.match(diff, /-export const v = "1";\n\+export const v = "2";/);
  assert.match(diff, /-\/\/ my change/);

  lines.length = 0;
  assert.equal(await runCli(["add", "--update"], quiet(dir, registry("2"), lines)), 0);
  assert.equal(readFileSync(lib, "utf8"), 'export const v = "2";\n');
  assert.match(readFileSync(list, "utf8"), /my change/, "your edit is kept");
  assert.match(readFileSync(`${list}.new`, "utf8"), /list = "2"/);
  assert.ok(lines.some((l) => l.startsWith("keep") && l.includes("cms-doc-list.tsx")));
  assert.ok(lines.some((l) => l.startsWith("update") && l.includes("use-cms.ts")));
});

test("add --yes runs the shadcn CLI for missing parts", async () => {
  const dir = app();
  const calls: string[][] = [];
  const io = { ...quiet(dir, registry("1")), run: (cmd: string, args: string[]) => (calls.push([cmd, ...args]), 0) };
  assert.equal(await runCli(["add", "cms-doc-list", "--yes"], io), 0);
  assert.deepEqual(calls, [["npx", "--yes", "shadcn@latest", "add", "checkbox"]]);
});

test("add without components.json explains what to do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cms-bare-"));
  const lines: string[] = [];
  assert.equal(await runCli(["add", "cms-doc-list"], quiet(dir, registry("1"), lines)), 1);
  assert.match(lines.join("\n"), /shadcn@latest init/);
});

test("init writes the config, route, schema re-export and .env lines once", async () => {
  const dir = app({ src: true });
  const lines: string[] = [];
  assert.equal(await runCli(["init"], quiet(dir, registry("1"), lines)), 0);
  for (const f of ["agent-cms.config.ts", "src/lib/cms.ts", "src/lib/cms-schema.ts", "src/app/api/cms/[...path]/route.ts", ".env.example"]) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, "src/lib/cms.ts"), "utf8"), /visibility: "public"/);
  assert.match(readFileSync(join(dir, "src/lib/cms-schema.ts"), "utf8"), /cmsAudit/);
  assert.doesNotMatch(readFileSync(join(dir, "src/lib/cms-schema.ts"), "utf8"), /Gaps/);
  lines.length = 0;
  await runCli(["init"], quiet(dir, registry("1"), lines));
  assert.ok(lines.filter((l) => l.startsWith("skip")).length === 4);
  assert.equal(readFileSync(join(dir, ".env.example"), "utf8").match(/AGENT_CMS_KEY=/g)?.length, 1);
});

test("migrate print needs no database; doctor without one explains", async () => {
  const dir = app();
  const lines: string[] = [];
  assert.equal(await runCli(["migrate", "print"], quiet(dir, registry("1"), lines)), 0);
  assert.match(lines.join("\n"), /CREATE TABLE IF NOT EXISTS "cms_audit"/);
  assert.doesNotMatch(lines.join("\n"), /cms_gaps/);
  lines.length = 0;
  assert.equal(await runCli(["doctor"], quiet(dir, registry("1"), lines)), 1);
  assert.match(lines.join("\n"), /agent-cms\.config\.ts/);
});
