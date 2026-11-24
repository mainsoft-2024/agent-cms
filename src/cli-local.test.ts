import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "./cli";
import type { Registry, RegistryItem } from "./registry";
import { buildPublicRegistry, resolveItems, rewriteImports, shadcnParts, toShadcnItem } from "./registry";
import { CMS_FONTS_CSS } from "./fonts";
import { VERSION } from "./version";

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

test("shadcn registry: one folder, internal deps as URLs, package pinned", () => {
  const reg = registry("1");
  const own = new Set(reg.items.map((i) => i.name));
  const list = reg.items[1]!;
  const item = toShadcnItem({ ...list, dependencies: ["@mainsoft/agent-cms", "lucide-react"] }, own, { baseUrl: "https://docs.example/r/" });
  assert.deepEqual(item.registryDependencies, ["https://docs.example/r/cms-lib.json", "button", "checkbox"]);
  assert.deepEqual(item.dependencies, [`@mainsoft/agent-cms@^${VERSION}`, "lucide-react"]);
  assert.equal(item.files[0]!.target, "@components/cms/cms-doc-list.tsx");
  assert.equal(toShadcnItem(reg.items[0]!, own, { baseUrl: "x", packageRange: "file:a.tgz" }).files[0]!.target, "@components/cms/use-cms.ts");

  // The real registry: every file lands in components/cms, every internal dep is a URL.
  const out = mkdtempSync(join(tmpdir(), "agent-cms-r-"));
  const files = buildPublicRegistry(join(import.meta.dirname, "..", "registry"), out, { baseUrl: "https://docs.example/r" });
  assert.ok(files.includes("registry.json") && files.includes("cms-shell.json"));
  for (const f of files.filter((x) => x !== "registry.json")) {
    const it = JSON.parse(readFileSync(join(out, f), "utf8")) as RegistryItem & { $schema?: string };
    assert.equal(it.$schema, "https://ui.shadcn.com/schema/registry-item.json");
    for (const file of it.files) {
      assert.match(file.target ?? "", /^@components\/cms\/[\w-]+\.tsx?$/);
      assert.ok(file.content?.length, `${f}: ${file.path} has content`);
    }
    for (const d of it.registryDependencies ?? []) assert.ok(/^https:\/\/docs\.example\/r\/cms-[\w-]+\.json$/.test(d) || /^[a-z-]+$/.test(d), `${f}: ${d}`);
    assert.ok(!(it.registryDependencies ?? []).some((d) => d.startsWith("cms-")), `${f}: no bare internal names`);
  }
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
  // 0.22.2: the admin fonts, scoped to the admin and said where to import.
  const css = readFileSync(join(dir, "src/app/cms-fonts.css"), "utf8");
  assert.match(css, /Wanted Sans Variable/);
  assert.match(css, /Geist Mono/);
  assert.match(css, /body:has\(\.cms-root\)/);
  assert.ok(css.trimStart().startsWith("/*") && css.indexOf("@import") < css.indexOf("{"), "@import comes before any rule");
  assert.match(lines.join("\n"), /import "\.\.\/cms-fonts\.css" in your admin layout/);
  lines.length = 0;
  await runCli(["init"], quiet(dir, registry("1"), lines));
  assert.ok(lines.filter((l) => l.startsWith("skip")).length === 5);
  assert.equal(readFileSync(join(dir, ".env.example"), "utf8").match(/AGENT_CMS_KEY=/g)?.length, 1);
});

test("the example app's cms-fonts.css is the one init writes", () => {
  assert.equal(readFileSync(join(import.meta.dirname, "../examples/next/app/cms-fonts.css"), "utf8"), CMS_FONTS_CSS);
});

test("init --no-fonts leaves the fonts to the app", async () => {
  const dir = app();
  const lines: string[] = [];
  assert.equal(await runCli(["init", "--no-fonts"], quiet(dir, registry("1"), lines)), 0);
  assert.ok(!existsSync(join(dir, "app/cms-fonts.css")));
  assert.doesNotMatch(lines.join("\n"), /cms-fonts/);
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
