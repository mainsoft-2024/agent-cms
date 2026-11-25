/**
 * The copy-in admin screens: reading the registry (built JSON in
 * `dist/registry`, or the `registry/` sources in this repo), and copying
 * items into an app with `agent-cms add` (with `--diff` and `--update`).
 *
 * Node only (used by the CLI and the build script).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    // A page keeps its route (`app/admin/p/[plugin]/[[...path]]/page.tsx`); the rest go next to each other.
    files: it.files.map((f) => (f.type === "registry:page" && f.target ? f : { ...f, target: `@components/cms/${basename(f.path)}` })),
  };
}

/**
 * Build the registry for the shadcn CLI: `registry.json` (index) and one
 * `<name>.json` per item with file contents, as `shadcn build` would.
 */
export function buildPublicRegistry(src: string | { dir: string; built: boolean }, outDir: string, o: PublicRegistryOptions): string[] {
  // A folder name is the `registry/` sources of this repo; `{ built: true }` is `dist/registry`
  // of an installed package (what `agent-cms registry build` uses).
  const reg = loadRegistry(typeof src === "string" ? { dir: src, built: false } : src);
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

/** npm packages the items need (other than this package) that the app's package.json does not list. */
export function missingPackages(cwd: string, items: RegistryItem[]): string[] {
  let have: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    have = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    /* no package.json: everything is missing */
  }
  const out = new Set<string>();
  for (const it of items)
    for (const dep of it.dependencies ?? []) {
      const name = dep.replace(/(?!^)@[^@/]*$/, "");
      if (name === "@mainsoft/agent-cms" || name in have) continue;
      out.add(dep);
    }
  return [...out];
}

/** The command that adds npm packages with the app's package manager. */
export function installCommand(cwd: string, pkgs: string[]): [string, string[]] {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return ["pnpm", ["add", ...pkgs]];
  if (existsSync(join(cwd, "yarn.lock"))) return ["yarn", ["add", ...pkgs]];
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return ["bun", ["add", ...pkgs]];
  return ["npm", ["install", ...pkgs]];
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
  aliases: { ui: string; utils: string; components?: string };
  /** Where Next.js routes live (`<cwd>/src` when there is `src/app`, else `<cwd>`): a page's target is under it. */
  appRoot?: string;
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
  const appRoot = existsSync(join(cwd, "src", "app")) && !existsSync(join(cwd, "app")) ? join(cwd, "src") : cwd;
  return { dir: o.dir ? resolve(cwd, o.dir) : join(aliasToDir(cwd, components), "cms"), uiDir: aliasToDir(cwd, ui), aliases: { ui, utils, components }, appRoot };
}

/** The file as it will be written into the app (import aliases rewritten). */
export function rewriteImports(content: string, aliases: AppLayout["aliases"]): string {
  if (aliases.components && aliases.components !== "@/components") content = content.replace(/(["'])@\/components\/cms\//g, `$1${aliases.components}/cms/`);
  return content.replace(/(["'])@\/components\/ui\//g, `$1${aliases.ui}/`).replace(/(["'])@\/lib\/utils(["'])/g, `$1${aliases.utils}$2`);
}

export interface LockEntry {
  item: string;
  version: string;
  hash: string;
  /** 0.24.2: the registry file this came from (pages only), so a page the app moved is found again. */
  source?: string;
}

export interface LockFile {
  version: string;
  files: Record<string, LockEntry>;
}

export const LOCK_FILE = "agent-cms.json";

export function readLock(cwd: string): LockFile {
  const p = join(cwd, LOCK_FILE);
  if (!existsSync(p)) return { version: VERSION, files: {} };
  return JSON.parse(readFileSync(p, "utf8")) as LockFile;
}

export interface AddResult {
  /** npm packages the copied files import that the app does not list yet (`name@range`). */
  missingPackages: string[];
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
  const res: AddResult = { missingPackages: [], written: [], skipped: [], updated: [], conflicts: [], unchanged: [], missingParts: [], diff: "" };
  const diffs: string[] = [];

  for (const it of items) {
    const pageFiles = it.files.filter((f) => f.type === "registry:page" && f.target);
    for (const f of it.files) {
      // 0.24.0: a page goes to its route under the app (`app/admin/p/[plugin]/[[...path]]/page.tsx`).
      const pageRoot = layout.appRoot ?? o.cwd;
      const isPage = f.type === "registry:page" && !!f.target;
      let target = isPage ? join(pageRoot, f.target!) : join(layout.dir, basename(f.path));
      const underApp = (t: string) => {
        const r = relative(join(pageRoot, "app"), join(pageRoot, t));
        return !!r && !isAbsolute(r) && r.split(/[\\/]/)[0] !== "..";
      };
      if (f.type === "registry:page" && f.target && (isAbsolute(f.target) || !underApp(f.target)))
        throw new Error(`[agent-cms] ${it.name}: page target "${f.target}" must stay under app/`);
      let rel = relative(o.cwd, target).split("\\").join("/");
      // 0.24.2: the app moved this page (a route group like `app/admin/(app)/plugins/page.tsx`): the
      // lock still has it under its new path. Keep it there instead of writing a second route.
      // A stale entry for the default path (an older `--update` wrote it back) does not stop the search.
      if (isPage && !existsSync(target)) {
        // Only a regular file under the app's `app/` (the lock is a file anyone can edit), an exact
        // `source` match first; more than one candidate and nothing is guessed.
        const appDir = join(pageRoot, "app");
        const inApp = (k: string) => {
          if (isAbsolute(k) || k.split(/[\\/]/).includes("..")) return false;
          const abs = join(o.cwd, k);
          const r = relative(appDir, abs);
          if (!r || isAbsolute(r) || r.split(/[\\/]/)[0] === "..") return false;
          try {
            if (!lstatSync(abs).isFile()) return false;
            const real = relative(realpathSync(appDir), realpathSync(abs));
            return !!real && !isAbsolute(real) && real.split(/[\\/]/)[0] !== "..";
          } catch {
            return false;
          }
        };
        const mine = Object.entries(lock.files).filter(([k, v]) => k !== rel && v.item === it.name && inApp(k));
        const exact = mine.filter(([, v]) => v.source === f.path);
        const legacy = pageFiles.length === 1 ? mine.filter(([k, v]) => !v.source && /(^|\/)page\.[jt]sx?$/.test(k)) : [];
        const pick = exact.length ? exact : legacy;
        if (pick.length === 1) {
          if (o.mode !== "diff") delete lock.files[rel];
          rel = pick[0][0];
          target = join(o.cwd, rel);
        } else if (pick.length > 1) {
          const reason = `moved more than once in ${LOCK_FILE} (${pick.map(([k]) => k).join(", ")}): keep one entry`;
          if (o.mode === "diff") diffs.push(`!!! ${rel}: ${reason}`);
          else res.skipped.push({ file: rel, reason });
          continue;
        }
      }
      let next = rewriteImports(f.content ?? "", layout.aliases);
      if (f.type === "registry:page" && o.dir) {
        // The screens went to --dir: the page imports them from there.
        let rel = relative(dirname(target), layout.dir).split("\\").join("/");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        next = next.replace(/(["'])[^"']*\/cms\/(cms-[\w-]+)\1/g, (_, q: string, file: string) => `${q}${rel}/${file}${q}`);
      }
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
        lock.files[rel] = { item: it.name, version: VERSION, hash: sha(next), ...(isPage ? { source: f.path } : {}) };
      };
      if (cur === next) {
        lock.files[rel] = { item: it.name, version: VERSION, hash: sha(next), ...(isPage ? { source: f.path } : {}) };
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
        // Never through a link someone left at `<file>.new`.
        try {
          if (lstatSync(`${target}.new`).isSymbolicLink()) unlinkSync(`${target}.new`);
        } catch {
          /* no such file */
        }
        writeFileSync(`${target}.new`, next);
        res.conflicts.push(rel);
      }
    }
  }

  const parts = shadcnParts(reg, items);
  res.missingParts = parts.filter((p) => !existsSync(join(layout.uiDir, `${p}.tsx`)) && !existsSync(join(layout.uiDir, `${p}.jsx`)));
  res.missingPackages = missingPackages(o.cwd, items);
  res.diff = diffs.filter(Boolean).join("\n\n");
  if (o.mode !== "diff") writeFileSync(join(o.cwd, LOCK_FILE), JSON.stringify({ ...lock, version: VERSION }, null, 2) + "\n");
  return res;
}
