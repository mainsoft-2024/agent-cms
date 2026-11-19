/**
 * The copy-in admin screens: reading the registry (built JSON in
 * `dist/registry`, or the `registry/` sources in this repo), and copying
 * items into an app with `agent-cms add` (with `--diff` and `--update`).
 *
 * Node only (used by the CLI and the build script).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "./diff";
import { VERSION } from "./version";

export interface RegistryFile {
  path: string;
  type: string;
  /** Present in built item JSON. */
  content?: string;
  target?: string;
}

export interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: RegistryFile[];
}

export interface Registry {
  name: string;
  homepage?: string;
  items: RegistryItem[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Where the registry lives: `dist/registry` next to the built CLI, else the repo's `registry/` (development). */
export function findRegistryDir(): { dir: string; built: boolean } {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const candidates: [string, boolean][] = [
    [join(here, "registry"), true],
    [join(here, "..", "dist", "registry"), true],
    [join(here, "..", "registry"), false],
  ];
  for (const [dir, built] of candidates) if (existsSync(join(dir, "registry.json"))) return { dir, built };
  throw new Error("[agent-cms] registry not found (is the package built?)");
}

/** Load the registry with every file's content. */
export function loadRegistry(loc: { dir: string; built: boolean } = findRegistryDir()): Registry {
  const index = JSON.parse(readFileSync(join(loc.dir, "registry.json"), "utf8")) as Registry;
  const root = loc.built ? loc.dir : resolve(loc.dir, "..");
  const items = index.items.map((it) => {
    if (loc.built) {
      const full = JSON.parse(readFileSync(join(loc.dir, `${it.name}.json`), "utf8")) as RegistryItem;
      return full;
    }
    return { ...it, files: it.files.map((f) => ({ ...f, content: readFileSync(join(root, f.path), "utf8") })) };
  });
  return { ...index, items };
}

/** Write `dist/registry/registry.json` and one JSON per item (shadcn registry-item schema). */
export function buildRegistry(srcDir: string, outDir: string): string[] {
  const reg = loadRegistry({ dir: srcDir, built: false });
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const index = { $schema: "https://ui.shadcn.com/schema/registry.json", name: reg.name, homepage: reg.homepage, items: reg.items.map((it) => ({ ...it, files: it.files.map(({ content: _c, ...f }) => f) })) };
  writeFileSync(join(outDir, "registry.json"), JSON.stringify(index, null, 2) + "\n");
  written.push("registry.json");
  for (const it of reg.items) {
    writeFileSync(join(outDir, `${it.name}.json`), JSON.stringify({ $schema: "https://ui.shadcn.com/schema/registry-item.json", ...it }, null, 2) + "\n");
    written.push(`${it.name}.json`);
  }
  return written;
}

export interface PublicRegistryOptions {
  /** URL of the folder that serves the item JSON files, e.g. `https://example.com/r`. */
  baseUrl: string;
  /** Version range written into `dependencies` for this package. Default `^<this version>`. */
  packageRange?: string;
}

/**
 * One item as the shadcn CLI expects it (`npx shadcn add <baseUrl>/<name>.json`):
 * every file goes to `<components>/cms/` (they import each other with `./`),
 * internal dependencies become URLs, and this package gets a version range.
 */
export function toShadcnItem(it: RegistryItem, own: Set<string>, o: PublicRegistryOptions): RegistryItem {
  const base = o.baseUrl.replace(/\/+$/, "");
  const range = o.packageRange ?? `^${VERSION}`;
  return {
    ...it,
    dependencies: it.dependencies?.map((d) => (d === "@mainsoft/agent-cms" ? `${d}@${range}` : d)),
    registryDependencies: it.registryDependencies?.map((d) => (own.has(d) ? `${base}/${d}.json` : d)),
    files: it.files.map((f) => ({ ...f, target: `@components/cms/${basename(f.path)}` })),
  };
}

/**
 * Build the registry for the shadcn CLI: `registry.json` (index) and one
 * `<name>.json` per item with file contents, as `shadcn build` would.
 */
export function buildPublicRegistry(srcDir: string, outDir: string, o: PublicRegistryOptions): string[] {
  const reg = loadRegistry({ dir: srcDir, built: false });
  const own = new Set(reg.items.map((i) => i.name));
  const items = reg.items.map((it) => toShadcnItem(it, own, o));
  mkdirSync(outDir, { recursive: true });
  const index = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: reg.name,
    homepage: reg.homepage,
    items: items.map((it) => ({ ...it, files: it.files.map(({ content: _c, ...f }) => f) })),
  };
  writeFileSync(join(outDir, "registry.json"), JSON.stringify(index, null, 2) + "\n");
  const written = ["registry.json"];
  for (const it of items) {
    writeFileSync(join(outDir, `${it.name}.json`), JSON.stringify({ $schema: "https://ui.shadcn.com/schema/registry-item.json", ...it }, null, 2) + "\n");
    written.push(`${it.name}.json`);
  }
  return written;
}

/** Items in install order (dependencies first) for the names asked. */
export function resolveItems(reg: Registry, names: string[]): RegistryItem[] {
  const byName = new Map(reg.items.map((i) => [i.name, i]));
  const out: RegistryItem[] = [];
  const seen = new Set<string>();
  const visit = (n: string, from?: string) => {
    const it = byName.get(n);
    if (!it) throw new Error(`[agent-cms] unknown item "${n}"${from ? ` (needed by ${from})` : ""}. Items: ${reg.items.map((i) => i.name).join(", ")}`);
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of it.registryDependencies ?? []) if (byName.has(d)) visit(d, n);
    out.push(it);
  };
  for (const n of names) visit(n);
  return out;
}

/** shadcn parts (not agent-cms items) these items need. */
export function shadcnParts(reg: Registry, items: RegistryItem[]): string[] {
  const own = new Set(reg.items.map((i) => i.name));
  return [...new Set(items.flatMap((i) => i.registryDependencies ?? []).filter((d) => !own.has(d)))].sort();
}

// ── the app side ────────────────────────────────────────────────────────────

export interface AppLayout {
  /** Directory the item files go to (absolute). */
  dir: string;
  /** Directory of the shadcn parts (absolute), to check what is missing. */
  uiDir: string;
  aliases: { ui: string; utils: string };
}

interface ComponentsJson {
  aliases?: { components?: string; ui?: string; utils?: string };
}

/** Map an alias like "@/components/ui" to a directory via tsconfig `paths` (shadcn's rule). */
function aliasToDir(cwd: string, alias: string): string {
  let base = ".";
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    try {
      // tsconfig may have comments and trailing commas.
      const text = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
      const paths = (JSON.parse(text) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths ?? {};
      const target = paths["@/*"]?.[0];
      if (target) base = target.replace(/\/\*$/, "");
    } catch {
      /* keep "." */
    }
    break;
  }
  return alias.startsWith("@/") ? resolve(cwd, base, alias.slice(2)) : resolve(cwd, alias);
}

export function appLayout(cwd: string, o: { dir?: string } = {}): AppLayout {
  const cj = join(cwd, "components.json");
  if (!existsSync(cj)) throw new Error("[agent-cms] components.json not found. The admin screens use your shadcn/ui parts: run `npx shadcn@latest init` first.");
  const aliases = (JSON.parse(readFileSync(cj, "utf8")) as ComponentsJson).aliases ?? {};
  const components = aliases.components ?? "@/components";
  const ui = aliases.ui ?? `${components}/ui`;
  const utils = aliases.utils ?? "@/lib/utils";
  return { dir: o.dir ? resolve(cwd, o.dir) : join(aliasToDir(cwd, components), "cms"), uiDir: aliasToDir(cwd, ui), aliases: { ui, utils } };
}

/** The file as it will be written into the app (import aliases rewritten). */
export function rewriteImports(content: string, aliases: AppLayout["aliases"]): string {
  return content.replace(/(["'])@\/components\/ui\//g, `$1${aliases.ui}/`).replace(/(["'])@\/lib\/utils(["'])/g, `$1${aliases.utils}$2`);
}

export interface LockFile {
  version: string;
  files: Record<string, { item: string; version: string; hash: string }>;
}

export const LOCK_FILE = "agent-cms.json";

export function readLock(cwd: string): LockFile {
  const p = join(cwd, LOCK_FILE);
  if (!existsSync(p)) return { version: VERSION, files: {} };
  return JSON.parse(readFileSync(p, "utf8")) as LockFile;
}

export interface AddResult {
  written: string[];
  skipped: { file: string; reason: string }[];
  updated: string[];
  /** Files you changed: the new version was written next to them as `<file>.new`. */
  conflicts: string[];
  unchanged: string[];
  missingParts: string[];
  diff: string;
}

export interface AddOptions {
  cwd: string;
  items: string[];
  mode: "add" | "diff" | "update";
  dir?: string;
  overwrite?: boolean;
  registry?: Registry;
}

/** Copy items into the app (or show / apply the difference to the installed copies). */
export function addItems(o: AddOptions): AddResult {
  const reg = o.registry ?? loadRegistry();
  const layout = appLayout(o.cwd, { dir: o.dir });
  const lock = readLock(o.cwd);
  const names = o.items.length ? o.items : o.mode === "add" ? [] : [...new Set(Object.values(lock.files).map((f) => f.item))];
  if (!names.length) throw new Error(`[agent-cms] name the items to add: ${reg.items.map((i) => i.name).join(", ")}`);
  const items = resolveItems(reg, names);
  const res: AddResult = { written: [], skipped: [], updated: [], conflicts: [], unchanged: [], missingParts: [], diff: "" };
  const diffs: string[] = [];

  for (const it of items) {
    for (const f of it.files) {
      const target = join(layout.dir, basename(f.path));
      const rel = relative(o.cwd, target).split("\\").join("/");
      const next = rewriteImports(f.content ?? "", layout.aliases);
      const exists = existsSync(target);
      const cur = exists ? readFileSync(target, "utf8") : null;
      const locked = lock.files[rel];

      if (o.mode === "diff") {
        if (cur === null) diffs.push(`+++ ${rel} (not installed)`);
        else if (cur !== next) diffs.push(unifiedDiff(cur, next, { from: `${rel} (yours)`, to: `${rel} (${VERSION})` }));
        continue;
      }
      const write = () => {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, next);
        lock.files[rel] = { item: it.name, version: VERSION, hash: sha(next) };
      };
      if (cur === next) {
        lock.files[rel] = { item: it.name, version: VERSION, hash: sha(next) };
        res.unchanged.push(rel);
        continue;
      }
      if (o.mode === "add") {
        if (exists && !o.overwrite) {
          res.skipped.push({ file: rel, reason: locked ? "already installed (use --diff / --update)" : "a file with this name exists (use --overwrite)" });
          continue;
        }
        write();
        res.written.push(rel);
        continue;
      }
      // update: replace files you did not change; leave yours and write <file>.new.
      if (cur === null) {
        write();
        res.written.push(rel);
      } else if (locked && sha(cur) === locked.hash) {
        write();
        res.updated.push(rel);
      } else {
        writeFileSync(`${target}.new`, next);
        res.conflicts.push(rel);
      }
    }
  }

  const parts = shadcnParts(reg, items);
  res.missingParts = parts.filter((p) => !existsSync(join(layout.uiDir, `${p}.tsx`)) && !existsSync(join(layout.uiDir, `${p}.jsx`)));
  res.diff = diffs.filter(Boolean).join("\n\n");
  if (o.mode !== "diff") writeFileSync(join(o.cwd, LOCK_FILE), JSON.stringify({ ...lock, version: VERSION }, null, 2) + "\n");
  return res;
}
