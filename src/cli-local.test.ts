import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const quiet = (cwd: string, reg: Registry, lines: string[] = []) => ({ cwd, registry: reg, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), run: () => 0 });

test("add: a page goes to its route under app/ (src/app too); the rest to components/cms; a components alias is followed", async () => {
  const page = { path: "registry/pages/plugin-page.tsx", type: "registry:page", target: "app/admin/p/[plugin]/[[...path]]/page.tsx", content: `import { CmsPluginPage } from "@/components/cms/cms-plugin-page";\n` };
  const reg: Registry = { name: "agent-cms", items: [{ name: "cms-plugin-page", type: "registry:component", files: [{ path: "registry/cms/cms-plugin-page.tsx", type: "registry:component", content: "export {}\n" }, page] }] };
  for (const src of [false, true]) {
    const dir = app({ src });
    assert.equal(await runCli(["add", "cms-plugin-page", "--yes"], quiet(dir, reg)), 0);
    const root = src ? join(dir, "src") : dir;
    assert.ok(existsSync(join(root, "components/cms/cms-plugin-page.tsx")));
    assert.match(readFileSync(join(root, "app/admin/p/[plugin]/[[...path]]/page.tsx"), "utf8"), /from "@\/components\/cms\/cms-plugin-page"/);
    assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "agent-cms.json"), "utf8")).files).some((f) => f.endsWith("app/admin/p/[plugin]/[[...path]]/page.tsx")));
  }
  assert.equal(rewriteImports(`from "@/components/cms/use-cms"`, { ui: "~/ui", utils: "~/u", components: "~/components" }), `from "~/components/cms/use-cms"`);
});

test("add --dir: a page imports the screens from that folder", async () => {
  const page = { path: "registry/pages/plugins-page.tsx", type: "registry:page", target: "app/admin/plugins/page.tsx", content: `import { CmsPlugins } from "@/components/cms/cms-plugins";\n` };
  const reg: Registry = { name: "agent-cms", items: [{ name: "cms-plugins", type: "registry:component", files: [{ path: "registry/cms/cms-plugins.tsx", type: "registry:component", content: "export {}\n" }, page] }] };
  const dir = app({ src: false });
  assert.equal(await runCli(["add", "cms-plugins", "--yes", "--dir", "components/custom"], quiet(dir, reg)), 0);
  assert.ok(existsSync(join(dir, "components/custom/cms-plugins.tsx")));
  assert.match(readFileSync(join(dir, "app/admin/plugins/page.tsx"), "utf8"), /from "\.\.\/\.\.\/\.\.\/components\/custom\/cms-plugins"/);
});

test("add --update: a page the app moved (a route group) is updated where it is, not written again (0.24.2)", async () => {
  const pageV = (v: string) => ({ path: "registry/pages/plugins-page.tsx", type: "registry:page", target: "app/admin/plugins/page.tsx", content: `import { CmsPlugins } from "@/components/cms/cms-plugins";\n// ${v}\n` });
  const reg = (v: string): Registry => ({ name: "agent-cms", items: [{ name: "cms-plugins", type: "registry:component", files: [{ path: "registry/cms/cms-plugins.tsx", type: "registry:component", content: `export const v = "${v}";\n` }, pageV(v)] }] });
  const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, "agent-cms.json"), "utf8")) as { files: Record<string, { source?: string; hash: string }> };
  const move = (dir: string, withSource: boolean) => {
    mkdirSync(join(dir, "app/admin/(app)/plugins"), { recursive: true });
    renameSync(join(dir, "app/admin/plugins/page.tsx"), join(dir, "app/admin/(app)/plugins/page.tsx"));
    const lock = lockOf(dir);
    const entry = lock.files["app/admin/plugins/page.tsx"];
    assert.equal(entry.source, "registry/pages/plugins-page.tsx");
    if (!withSource) delete entry.source; // a lock written before 0.24.2
    delete lock.files["app/admin/plugins/page.tsx"];
    lock.files["app/admin/(app)/plugins/page.tsx"] = entry;
    writeFileSync(join(dir, "agent-cms.json"), JSON.stringify(lock));
  };
  for (const withSource of [true, false]) {
    const dir = app({ src: false });
    assert.equal(await runCli(["add", "cms-plugins", "--yes"], quiet(dir, reg("1"))), 0);
    move(dir, withSource);
    assert.equal(await runCli(["add", "--update", "--yes"], quiet(dir, reg("2"))), 0);
    assert.ok(!existsSync(join(dir, "app/admin/plugins/page.tsx")), "no second route");
    assert.match(readFileSync(join(dir, "app/admin/(app)/plugins/page.tsx"), "utf8"), /\/\/ 2/);
    assert.deepEqual(Object.keys(lockOf(dir).files).filter((k) => k.endsWith("page.tsx")), ["app/admin/(app)/plugins/page.tsx"]);
    // Plain `add` again does not write a second route either.
    assert.equal(await runCli(["add", "cms-plugins", "--yes"], quiet(dir, reg("2"))), 0);
    assert.ok(!existsSync(join(dir, "app/admin/plugins/page.tsx")));
  }

  // A stale default entry left by an older --update (both keys in the lock, only the moved file on disk).
  const stale = app({ src: false });
  assert.equal(await runCli(["add", "cms-plugins", "--yes"], quiet(stale, reg("1"))), 0);
  move(stale, true);
  const ls = lockOf(stale);
  ls.files["app/admin/plugins/page.tsx"] = { ...ls.files["app/admin/(app)/plugins/page.tsx"] };
  writeFileSync(join(stale, "agent-cms.json"), JSON.stringify(ls));
  assert.equal(await runCli(["add", "--update", "--yes"], quiet(stale, reg("2"))), 0);
  assert.ok(!existsSync(join(stale, "app/admin/plugins/page.tsx")), "no second route from a stale key");
  assert.deepEqual(Object.keys(lockOf(stale).files).filter((k) => k.endsWith("page.tsx")), ["app/admin/(app)/plugins/page.tsx"]);

  // A lock key outside app/ (the lock is editable) is never followed; two candidates are not guessed.
  const outside = app({ src: false });
  assert.equal(await runCli(["add", "cms-plugins", "--yes"], quiet(outside, reg("1"))), 0);
  const victim = join(outside, "..", `victim-${Date.now()}`);
  mkdirSync(join(victim), { recursive: true });
  writeFileSync(join(victim, "page.tsx"), "keep me\n");
  const lock = lockOf(outside);
  const entry = lock.files["app/admin/plugins/page.tsx"];
  delete lock.files["app/admin/plugins/page.tsx"];
  rmSync(join(outside, "app/admin/plugins/page.tsx"));
  lock.files[relative(outside, join(victim, "page.tsx"))] = { ...entry, hash: sha256("keep me\n") };
  lock.files["lib/page.tsx"] = { ...entry };
  writeFileSync(join(outside, "agent-cms.json"), JSON.stringify(lock));
  assert.equal(await runCli(["add", "--update", "--yes"], quiet(outside, reg("2"))), 0);
  assert.equal(readFileSync(join(victim, "page.tsx"), "utf8"), "keep me\n");
  assert.ok(existsSync(join(outside, "app/admin/plugins/page.tsx")), "written at the default route instead");

  const twice = app({ src: false });
  assert.equal(await runCli(["add", "cms-plugins", "--yes"], quiet(twice, reg("1"))), 0);
  move(twice, true);
  mkdirSync(join(twice, "app/admin/(b)/plugins"), { recursive: true });
  writeFileSync(join(twice, "app/admin/(b)/plugins/page.tsx"), readFileSync(join(twice, "app/admin/(app)/plugins/page.tsx")));
  const l2 = lockOf(twice);
  l2.files["app/admin/(b)/plugins/page.tsx"] = { ...l2.files["app/admin/(app)/plugins/page.tsx"] };
  writeFileSync(join(twice, "agent-cms.json"), JSON.stringify(l2));
  const lines: string[] = [];
  assert.equal(await runCli(["add", "--update", "--yes"], quiet(twice, reg("2"), lines)), 0);
  assert.ok(!existsSync(join(twice, "app/admin/plugins/page.tsx")));
  assert.match(lines.join("\n"), /moved more than once/);
});

test("add --update: a route the lock gives to another item is left alone (0.25.1)", async () => {
  const page = (name: string, v: string) => ({ path: `registry/pages/${name}-page.tsx`, type: "registry:page", target: `app/admin/${name}/page.tsx`, content: `// ${name} ${v}\n` });
  const reg = (v: string): Registry => ({
    name: "agent-cms",
    items: [
      { name: "cms-a", type: "registry:component", files: [page("a", v)] },
      { name: "cms-b", type: "registry:component", files: [page("b", v)] },
    ],
  });
  const dir = app({ src: false });
  assert.equal(await runCli(["add", "cms-a", "--yes"], quiet(dir, reg("1"))), 0);
  // The app moved a's page to where b's page would go.
  mkdirSync(join(dir, "app/admin/b"), { recursive: true });
  renameSync(join(dir, "app/admin/a/page.tsx"), join(dir, "app/admin/b/page.tsx"));
  const lock = JSON.parse(readFileSync(join(dir, "agent-cms.json"), "utf8")) as { files: Record<string, unknown> };
  lock.files["app/admin/b/page.tsx"] = lock.files["app/admin/a/page.tsx"];
  delete lock.files["app/admin/a/page.tsx"];
  writeFileSync(join(dir, "agent-cms.json"), JSON.stringify(lock));
  const lines: string[] = [];
  assert.equal(await runCli(["add", "cms-b", "--yes", "--overwrite"], quiet(dir, reg("1"), lines)), 0);
  assert.equal(readFileSync(join(dir, "app/admin/b/page.tsx"), "utf8"), "// a 1\n", "a's page is not overwritten by b");
  assert.match(lines.join("\n"), /gives this file to cms-a/);
  assert.equal(await runCli(["add", "--update", "--yes"], quiet(dir, reg("2"))), 0);
  assert.equal(readFileSync(join(dir, "app/admin/b/page.tsx"), "utf8"), "// a 2\n", "a's moved page is updated as a's");
  const after = JSON.parse(readFileSync(join(dir, "agent-cms.json"), "utf8")) as { files: Record<string, { item: string }> };
  assert.equal(after.files["app/admin/b/page.tsx"].item, "cms-a");

  // b installed too, its page moved into a group while a's page sits on b's default route: b's update finds its own page.
  const two = app({ src: false });
  assert.equal(await runCli(["add", "cms-a", "cms-b", "--yes"], quiet(two, reg("1"))), 0);
  mkdirSync(join(two, "app/admin/(g)/b"), { recursive: true });
  renameSync(join(two, "app/admin/b/page.tsx"), join(two, "app/admin/(g)/b/page.tsx"));
  renameSync(join(two, "app/admin/a/page.tsx"), join(two, "app/admin/b/page.tsx"));
  const l2 = JSON.parse(readFileSync(join(two, "agent-cms.json"), "utf8")) as { files: Record<string, unknown> };
  l2.files["app/admin/(g)/b/page.tsx"] = l2.files["app/admin/b/page.tsx"];
  l2.files["app/admin/b/page.tsx"] = l2.files["app/admin/a/page.tsx"];
  delete l2.files["app/admin/a/page.tsx"];
  writeFileSync(join(two, "agent-cms.json"), JSON.stringify(l2));
  assert.equal(await runCli(["add", "--update", "--yes"], quiet(two, reg("2"))), 0);
  assert.equal(readFileSync(join(two, "app/admin/b/page.tsx"), "utf8"), "// a 2\n");
  assert.equal(readFileSync(join(two, "app/admin/(g)/b/page.tsx"), "utf8"), "// b 2\n");
  assert.ok(!existsSync(join(two, "app/admin/a/page.tsx")));
});

test("add: a page target outside app/ is refused", async () => {
  for (const target of ["../escape/page.tsx", "app/../../escape.tsx", "/tmp/escape.tsx", "lib/page.tsx"]) {
    const reg: Registry = { name: "agent-cms", items: [{ name: "evil", type: "registry:component", files: [{ path: "registry/pages/x.tsx", type: "registry:page", target, content: "export {}\n" }] }] };
    const lines: string[] = [];
    const dir = app({ src: false });
    assert.notEqual(await runCli(["add", "evil", "--yes"], quiet(dir, reg, lines)), 0, target);
    assert.match(lines.join("\n"), /must stay under app\//, target);
  }
});

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
      // 0.24.0: a page keeps its Next.js route (shadcn's `registry:page`); every other file lands in components/cms.
      if (file.type === "registry:page") assert.ok(["app/admin/p/[plugin]/[[...path]]/page.tsx", "app/admin/plugins/page.tsx"].includes(file.target ?? ""), file.target);
      else assert.match(file.target ?? "", /^@components\/cms\/[\w-]+\.tsx?$/);
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

test("doctor: each plugin package must use the app's React and @mainsoft/agent-cms (0.24.1)", async () => {
  const { reactCheck } = await import("./cli");
  const dir = mkdtempSync(join(tmpdir(), "agent-cms-react-plugins-"));
  const pkg = (p: string, json: object) => {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, "package.json"), JSON.stringify(json));
  };
  pkg("", { name: "site", dependencies: { "@mainsoft/agent-cms": "*", react: "*", good: "*", "own-react": "*", "own-cms": "*", lodash: "*" } });
  pkg("node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: VERSION, exports: { ".": "./index.js" } });
  pkg("node_modules/react", { name: "react", version: "19.0.0", main: "index.js" });
  pkg("node_modules/lodash", { name: "lodash" });
  pkg("node_modules/good", { name: "good", peerDependencies: { "@mainsoft/agent-cms": ">=0.24", react: ">=18" } });
  pkg("node_modules/own-react", { name: "own-react", peerDependencies: { "@mainsoft/agent-cms": ">=0.24" } });
  pkg("node_modules/own-react/node_modules/react", { name: "react", version: "18.3.1", main: "index.js" });
  pkg("node_modules/own-cms", { name: "own-cms", dependencies: { "@mainsoft/agent-cms": "0.23.0" } });
  pkg("node_modules/own-cms/node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: "0.23.0" });
  const out = (reactCheck(dir) ?? "").split("\n");
  assert.match(out[0], /^ok {4}one React/);
  assert.ok(out.some((l) => /^ok {4}plugin good /.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^warn {2}plugin own-react uses another copy of React/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^warn {2}plugin own-cms uses another copy of @mainsoft\/agent-cms/.test(l)), out.join("\n"));
  assert.ok(!out.some((l) => /lodash/.test(l)));
});

test("doctor: plugin packages: missing peers are not ok, both copies are named, odd manifests are skipped, no React needed (0.24.1)", async () => {
  const { reactCheck } = await import("./cli");
  const dir = mkdtempSync(join(tmpdir(), "agent-cms-react-plugins2-"));
  const pkg = (p: string, json: unknown) => {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, "package.json"), JSON.stringify(json));
  };
  // A server-only app: no React at all.
  pkg("", { name: "api", dependencies: { "@mainsoft/agent-cms": "*", both: "*", broken: "*", server: "*", "maybe-admin": "*" }, optionalDependencies: { "with-admin": "*" } });
  pkg("node_modules/with-admin", { name: "with-admin", peerDependencies: { "@mainsoft/agent-cms": "*", react: ">=18" } });
  pkg("node_modules/maybe-admin", { name: "maybe-admin", peerDependencies: { "@mainsoft/agent-cms": "*", react: ">=18" }, peerDependenciesMeta: { react: { optional: true } } });
  pkg("node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: VERSION });
  pkg("node_modules/broken", null);
  pkg("node_modules/server", { name: "server", peerDependencies: { "@mainsoft/agent-cms": "*" } });
  pkg("node_modules/both", { name: "both", dependencies: { "@mainsoft/agent-cms": "0.23.0", react: "18" } });
  pkg("node_modules/both/node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: "0.23.0" });
  const out = (reactCheck(dir) ?? "").split("\n");
  assert.ok(out.some((l) => /^ok {4}plugin server uses the app's @mainsoft\/agent-cms$/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^warn {2}plugin both uses another copy of @mainsoft\/agent-cms/.test(l)), out.join("\n"));
  assert.ok(!out.some((l) => /broken/.test(l)));
  // 0.24.2: no React in the app, and a plugin wants it as a (non-optional) peer.
  assert.ok(out.some((l) => /^warn {2}plugin with-admin needs react as a peer and cannot find it/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^ok {4}plugin maybe-admin uses the app's @mainsoft\/agent-cms$/.test(l)), out.join("\n"));

  // A linked plugin outside the app that cannot find its peers.
  const app = mkdtempSync(join(tmpdir(), "agent-cms-react-plugins3-"));
  const outside = mkdtempSync(join(tmpdir(), "agent-cms-linked-"));
  const at = (root: string, p: string, json: unknown) => {
    mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, p, "package.json"), JSON.stringify(json));
  };
  at(app, "", { name: "site", dependencies: { "@mainsoft/agent-cms": "*", react: "*", linked: "*" } });
  at(app, "node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: VERSION });
  at(app, "node_modules/react", { name: "react", version: "19.0.0", main: "index.js" });
  at(outside, "", { name: "linked", peerDependencies: { "@mainsoft/agent-cms": "*", react: "*" } });
  symlinkSync(outside, join(app, "node_modules", "linked"), "dir");
  const lines = (reactCheck(app) ?? "").split("\n");
  assert.ok(lines.some((l) => /^warn {2}plugin linked cannot find @mainsoft\/agent-cms/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^warn {2}plugin linked cannot find react/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /^ok {4}plugin linked/.test(l)));
});

test("plugin init writes a plugin package; refuses a bad name and a folder with files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cms-plugin-"));
  const lines: string[] = [];
  assert.equal(await runCli(["plugin", "init", "read-stats"], quiet(dir, registry("1"), lines)), 0);
  const root = join(dir, "read-stats");
  for (const f of ["package.json", "tsconfig.json", "src/index.ts", "src/admin.tsx", "src/index.test.ts", "README.md"]) assert.ok(existsSync(join(root, f)), f);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "read-stats");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.deepEqual(Object.keys(pkg.exports), [".", "./admin"]);
  assert.equal(pkg.peerDependencies["@mainsoft/agent-cms"], `^${VERSION}`);
  assert.ok(pkg.peerDependencies.zod);
  assert.equal(pkg.peerDependenciesMeta.react.optional, true);
  const server = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(server, /definePlugin\(\{\n  name: "read-stats"/);
  assert.match(server, new RegExp(`engine: ">=${VERSION.split(".").slice(0, 2).join("\\.")}"`));
  assert.match(server, /ctx\.route\("GET", "hello"/);
  assert.match(server, /name: "read_stats_hello"/);
  const admin = readFileSync(join(root, "src/admin.tsx"), "utf8");
  assert.match(admin, /defineAdminPlugin\(/);
  assert.match(admin, /useCmsAdmin\(\)/);
  assert.match(admin, /usePluginT\("read-stats"\)/);
  assert.match(admin, /ko: \{ title: "인사"/);
  assert.match(readFileSync(join(root, "src/index.test.ts"), "utf8"), /from "@mainsoft\/agent-cms\/testing"/);
  assert.match(lines.join("\n"), /write read-stats\/src\/index\.ts/);

  lines.length = 0;
  assert.equal(await runCli(["plugin", "init", "read-stats"], quiet(dir, registry("1"), lines)), 1, "the folder has files");
  assert.match(lines.join("\n"), /already exists and is not empty/);
  for (const bad of ["Stats", "a", "9lives", "under_score"]) assert.equal(await runCli(["plugin", "init", bad], quiet(dir, registry("1"))), 1, bad);
  assert.equal(await runCli(["plugin"], quiet(dir, registry("1"))), 1, "usage");

  // --dir: an empty folder is fine.
  mkdirSync(join(dir, "empty"));
  assert.equal(await runCli(["plugin", "init", "other", "--dir", "empty"], quiet(dir, registry("1"))), 0);
  assert.ok(existsSync(join(dir, "empty/src/index.ts")));
});

test("doctor: one React for the app and the package, or a warning with the fix", async () => {
  const { reactCheck } = await import("./cli");
  // A fresh folder for each case: Node remembers where it found a module.
  const fresh = (o: { appReact?: boolean; ownReact?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-cms-react-"));
    const pkg = (p: string, json: object) => {
      mkdirSync(join(dir, p), { recursive: true });
      writeFileSync(join(dir, p, "package.json"), JSON.stringify(json));
    };
    pkg("node_modules/@mainsoft/agent-cms", { name: "@mainsoft/agent-cms", version: VERSION, exports: { "./package.json": "./package.json" } });
    if (o.appReact !== false) pkg("node_modules/react", { name: "react", version: "19.0.0", main: "index.js" });
    if (o.ownReact) pkg("node_modules/@mainsoft/agent-cms/node_modules/react", { name: "react", version: "18.3.1", main: "index.js" });
    return dir;
  };
  assert.equal(reactCheck(fresh({ appReact: false })), null, "no React: nothing to say");
  assert.match(reactCheck(fresh()) ?? "", /^ok {4}one React/);
  const dir = fresh({ ownReact: true });
  const two = reactCheck(dir) ?? "";
  assert.match(two, /^warn {2}two copies of React/);
  assert.match(two, /npm ls react/);
  assert.match(two, /npm dedupe/);
  // Printed by `doctor` before it looks for the database.
  const lines: string[] = [];
  assert.equal(await runCli(["doctor"], quiet(dir, registry("1"), lines)), 1);
  assert.match(lines.join("\n"), /two copies of React/);
  assert.match(lines.join("\n"), /agent-cms\.config\.ts/);
});
