/**
 * `agent-cms` CLI.
 *
 * In the app (local, no key needed):
 *   agent-cms init [--yes]                 config, API route, schema re-export, .env lines
 *   agent-cms user create <email> [--name N] [--admin]   a person for the CMS's own sign-in; prints a link to set the password
 *   agent-cms user reset-link <email>       a password reset link (1 hour)
 *   agent-cms doctor [--fix]               database check (tables, columns, indexes, schema version, data); --fix removes rows that point at nothing
 *   agent-cms migrate check | print | apply
 *       check: what is missing and the SQL to add it (exit 1 when behind)
 *       print: the full idempotent DDL; apply: run it
 *   agent-cms add <item...> [--diff | --update] [--yes] [--overwrite] [--dir path]
 *       copy admin screens into the app (see `agent-cms add --list`)
 *   agent-cms storage check [--origin https://your-site]
 *       try every file store for real (upload, signed addresses, large-file parts, CORS)
 *       and print what each store accepts. Needs `media` in agent-cms.config.ts.
 *   agent-cms storage cleanup              remove uploads that were started and never finished
 *   agent-cms cron [--watch] [--every 30]  call the app's /_cron once (or keep calling): scheduled publishing, webhook deliveries, jobs
 *                                          needs AGENT_CMS_URL and AGENT_CMS_CRON_SECRET (or CRON_SECRET)
 *   agent-cms webhooks list | test <id>    registered webhooks; send a ping (admin key)
 *   agent-cms storage sync [--store name] [--folder path]
 *       make every file of a bucket known to the CMS (files that got there some other way),
 *       and list files the CMS knows that are gone from the bucket
 *
 * Against a running app, with an API key (same operations as the MCP tools):
 *   agent-cms tools | collections
 *   agent-cms list <collection> [--drafts]
 *   agent-cms get <collection> <slug> [--draft]
 *   agent-cms search <query> [--collections a,b]
 *   agent-cms put <collection> <file.md> [--publish] [--note "why"] [--expected-version N] [--force]
 *       create, or update with --expected-version (the version you read with `get --draft`),
 *       so an edit someone made since is never overwritten. Frontmatter: see frontmatter.ts.
 *   agent-cms patch <collection> <slug> <ops.json> [--expected-version N] [--dry-run]
 *   agent-cms publish <collection> <slug>
 *   agent-cms read <collection> <slug> [--offset N] [--limit N] [--outline]   the document as a numbered file
 *   agent-cms grep <pattern> [--regex] [-i] [--collections a,b] [--glob "guide/2026-*"] [--context N] [--files | --count]
 *   agent-cms edit <collection> <slug> <old text> <new text> [--all] [--expected-version N]
 *   agent-cms pull <collection> <slug...> [--dir path]   documents as files you edit with any editor (.agent-cms/state.json remembers versions)
 *   agent-cms push [files...]               send changed files back; someone else's edit since is merged, or marked as a conflict
 *   agent-cms status                        pulled files changed here or in the CMS
 *   agent-cms upload <files...> [--store name] [--folder path] [--alt "text"] [--tag a,b]
 *       put files into the media library (large files go up in parts)
 *   agent-cms export <dir> [--collection a,b] [--drafts] [--with-files]
 *       every document as a markdown file: <dir>/<collection>/<slug>.md
 *   agent-cms import <dir> [--dry-run] [--diff] [--on-conflict file-wins|db-wins|newest] [--publish] [--collection c]
 *       read them back (drafts; same address: a new version). `put <collection> <dir>` does the same for one folder.
 *       With `_assets/` in the folder (export --with-files) the files are uploaded too.
 *   agent-cms import <file> --from json|csv|wordpress|notion --collection c [--types post,page] [--folder f] [--dry-run] [--publish]
 *       content from somewhere else: a JSON list, a CSV sheet, a WordPress export file
 *   agent-cms openapi                    this app's REST API as an OpenAPI 3.1 document
 *   agent-cms registry build --base-url https://site/r [--out public/r]
 *       serve the admin screens from your own site: \`npx shadcn add https://site/r/cms-shell.json\`
 *   agent-cms retention [--dry-run]      delete what the retention rules allow (admin key); --dry-run only counts
 *   agent-cms call <tool> '<json args>'         (or --args-file args.json, or --args-file - for stdin)
 *   any command: --json-errors  one JSON line on stderr when it fails (code, kind, status, message, requestId)
 *
 * Env: AGENT_CMS_URL (https://app/api/cms) and AGENT_CMS_KEY (sgk_…), or
 * `--env <file>` with those two lines. Output is JSON.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { sha256 } from "./crypto";
import { humanSize, type MediaOptions } from "./assets";
import { createCmsClient, createRestClient, CmsRemoteError, isCmsRemoteError } from "./client";
import { createCmsCore } from "./cms";
import { loadConfig, type AgentCmsConfig } from "./config";
import { DrizzleRepo, type DoctorReport } from "./drizzle-repo";
import { docFromMarkdown } from "./frontmatter";
import { docsFromNotion, filesFromDocs, filesFromSource, IMPORT_SOURCES, type ImportSource } from "./import-sources";
import { unzip } from "./zip";
import { imageSize } from "./net-guard";
import { DEFAULT_ACCEPT, DEFAULT_MAX_FILE_SIZE } from "./storage";
import { addItems, buildPublicRegistry, findRegistryDir, installCommand, loadRegistry, type Registry } from "./registry";
import { cmsDdl, cmsTables, SCHEMA_VERSION, schemaVersionSql, splitSql, upgradeSteps } from "./tables";
import { VERSION } from "./version";

export interface CliIo {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Working directory for local commands. Default process.cwd(). */
  cwd?: string;
  /** Registry to use for `add` (tests). Default: the one shipped in the package. */
  registry?: Registry;
  /** Tests: where `registry build` reads the built screens. */
  registryDir?: { dir: string; built: boolean };
  /** Database for `doctor` / `migrate` (tests). Default: `db()` from agent-cms.config.ts. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  /** Read a file as bytes (for `upload`; tests). Default: from disk, part by part. */
  readBytes?: (path: string) => Uint8Array;
  /** File stores for `storage` (tests). Default: `media` from agent-cms.config.ts. */
  media?: MediaOptions;
  /** Run a command (for `add --yes`). */
  run?: (cmd: string, args: string[], cwd: string) => number;
}

const WITH_VALUE = new Set(["--base-url", "--out", "--name", "--on-conflict", "--collection", "--env", "--note", "--collections", "--expected-version", "--dir", "--format", "--store", "--folder", "--alt", "--tag", "--origin", "--from", "--types", "--every", "--port", "--host", "--offset", "--limit", "--context", "--glob", "--args-file"]);
/** Switches without a value. Anything else that starts with "--" is refused before any request. */
const SWITCHES = new Set(["--admin", "--all", "--count", "--diff", "--draft", "--drafts", "--dry-run", "--files", "--fix", "--force", "--help", "--ignore-case", "--json", "--json-errors", "--list", "--memory", "--outline", "--overwrite", "--publish", "--regex", "--update", "--version", "--watch", "--with-files", "--yes"]);

/** Problems with the flags (unknown, missing value), or null. Checked before reading any settings. */
export function checkFlags(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break; // what follows is positional, even when it starts with "--"
    if (!a.startsWith("--")) continue;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (WITH_VALUE.has(name)) {
      if (a.includes("=")) continue;
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && v !== "--")) return `${name} needs a value`;
      i++;
      continue;
    }
    if (SWITCHES.has(name)) continue;
    const all = [...WITH_VALUE, ...SWITCHES];
    const near = all.find((k) => k.startsWith(name.slice(0, 5))) ?? all.find((k) => levenshtein(k, name) <= 2);
    return `unknown flag ${name}${near ? ` (did you mean ${near}?)` : ""}`;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

/** Positional args (flags and their values removed). */
function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.push(...argv.slice(i + 1));
      break;
    }
    if (WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const USAGE = `agent-cms ${VERSION}
a server:      dev [--port 3000] [--memory] | serve [--port <n>] [--host <h>]
in your app:   init | doctor | migrate <check|print|apply> | add <item...> [--diff|--update] | storage <check|cleanup|sync> | registry build
with a key:    tools | collections | list | get | search | put | patch | publish | upload | call | export | import | openapi | retention
               read | grep | edit | pull | push | status
options:       --env <file>  --json  --json-errors  --  (what follows is a file name, even if it starts with --)
see https://github.com/mainsoft-2024/agent-cms#cli`;

const LOCAL = new Set(["init", "doctor", "migrate", "add", "storage", "serve", "dev", "user", "registry"]);

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const cwd = io.cwd ?? process.cwd();
  const [cmd, ...args] = positional(argv);
  if (cmd === "version" || (!cmd && argv.includes("--version"))) {
    out(VERSION);
    return 0;
  }
  if (!cmd || cmd === "help" || argv.includes("--help")) {
    out(USAGE);
    return cmd ? 0 : 1;
  }
  const bad = checkFlags(argv);
  if (bad) {
    if (argv.includes("--json-errors")) err(JSON.stringify({ error: "invalid_flags", kind: "invalid", message: bad }));
    else err(`[agent-cms] ${bad}. See: npx @mainsoft/agent-cms help`);
    return 2;
  }
  try {
    if (LOCAL.has(cmd)) return await runLocal(cmd, args, argv, { ...io, cwd, out, err });
    return await runRemote(cmd, args, argv, { ...io, out, err, read });
  } catch (e) {
    // --json-errors: one JSON line on stderr for scripts (stdout stays for data); never secrets.
    if (argv.includes("--json-errors")) {
      const r = isCmsRemoteError(e) ? e : null;
      err(JSON.stringify({ error: r?.code ?? "error", kind: r?.kind ?? null, status: r?.status ?? null, message: e instanceof Error ? e.message : String(e), params: r?.extra.params ?? {}, requestId: r?.requestId ?? null }));
    } else err(`[agent-cms] ${isCmsRemoteError(e) ? `${e.code}: ` : ""}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ── remote ──────────────────────────────────────────────────────────────────

async function runRemote(cmd: string, args: string[], argv: string[], io: CliIo & { out: (l: string) => void; err: (l: string) => void; read: (p: string) => string }): Promise<number> {
  const { out, err, read } = io;
  const envFile = flag(argv, "env");
  const env = { ...(io.env ?? process.env), ...(envFile ? parseEnvFile(read(envFile)) : {}) };
  if (cmd === "cron") {
    const secret = env.AGENT_CMS_CRON_SECRET ?? env.CRON_SECRET;
    if (!env.AGENT_CMS_URL || !secret) {
      err("[agent-cms] set AGENT_CMS_URL and AGENT_CMS_CRON_SECRET (the app's `cronSecret`), or pass --env <file>.");
      return 1;
    }
    const every = Math.max(5, Number(flag(argv, "every")) || 30);
    const once = async (): Promise<number> => {
      const res = await (io.fetch ?? fetch)(`${env.AGENT_CMS_URL!.replace(/\/$/, "")}/_cron`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
      const text = await res.text();
      if (!res.ok) {
        err(`[agent-cms] cron: the app answered ${res.status}${res.status === 404 ? " (no `cronSecret` in createCms?)" : res.status === 401 ? " (the secret does not match)" : ""}`);
        return 1;
      }
      out(text);
      return 0;
    };
    if (!argv.includes("--watch")) return once();
    for (;;) {
      await once().catch((e) => err(`[agent-cms] cron: ${e instanceof Error ? e.message : e}`));
      await new Promise((r) => setTimeout(r, every * 1000));
    }
  }
  if (!env.AGENT_CMS_URL || !env.AGENT_CMS_KEY) {
    err("[agent-cms] set AGENT_CMS_URL and AGENT_CMS_KEY (or pass --env <file>).");
    return 1;
  }
  const api = createCmsClient({ url: env.AGENT_CMS_URL, key: env.AGENT_CMS_KEY, fetch: io.fetch, clientName: "cli" });
  const print = (v: unknown) => out(JSON.stringify(v, null, 2));
  const need = (n: number) => {
    if (args.length < n) throw new CmsRemoteError(`missing arguments\n${USAGE}`, "usage");
  };
  const expectedVersion = () => {
    const raw = flag(argv, "expected-version");
    const n = raw === undefined ? undefined : Number(raw);
    if (n !== undefined && !(Number.isInteger(n) && n > 0)) throw new CmsRemoteError("--expected-version must be a positive integer", "usage");
    return n;
  };

  switch (cmd) {
    case "tools":
      print((await api.listTools()).map((t) => ({ name: t.name, description: t.description })));
      return 0;
    case "collections":
      print(await api.call("list_collections"));
      return 0;
    case "list":
      need(1);
      print(await api.call("list_documents", { collection: args[0], drafts: argv.includes("--drafts") }));
      return 0;
    case "get":
      need(2);
      print(await api.call("get_document", { collection: args[0], slug: args[1], draft: argv.includes("--draft") }));
      return 0;
    case "search": {
      need(1);
      const cols = flag(argv, "collections");
      print(await api.call("search_documents", { query: args.join(" "), collections: cols ? cols.split(",") : undefined }));
      return 0;
    }
    case "publish":
      need(2);
      print(await api.call("publish_document", { collection: args[0], slug: args[1] }));
      return 0;
    case "patch": {
      need(3);
      const ops = JSON.parse(read(args[2])) as unknown;
      print(await api.call("patch_document", { collection: args[0], slug: args[1], ops: Array.isArray(ops) ? ops : [ops], expectedVersion: expectedVersion(), dryRun: argv.includes("--dry-run") }));
      return 0;
    }
    case "read": {
      need(2);
      const n = (k: string) => (flag(argv, k) ? Number(flag(argv, k)) : undefined);
      const r = (await api.call("read_document", { collection: args[0], slug: args[1], offset: n("offset"), limit: n("limit"), outline: argv.includes("--outline") || undefined })) as { content: string; outline?: { line: number; kind: string; text: string }[]; version: number; path: string; totalLines: number };
      if (argv.includes("--json")) print(r);
      else io.out(r.outline ? r.outline.map((o) => `${o.line}\t${o.kind}\t${o.text}`).join("\n") : `# ${r.path} · version ${r.version} · ${r.totalLines} lines\n${r.content}`);
      return 0;
    }
    case "grep": {
      need(1);
      const cols = flag(argv, "collections");
      const output = argv.includes("--count") ? "count" : argv.includes("--files") ? "files" : "lines";
      const r = (await api.call("grep_documents", { pattern: args[0], regex: argv.includes("--regex") || undefined, ignoreCase: argv.includes("-i") || argv.includes("--ignore-case") || undefined, collections: cols ? cols.split(",") : undefined, glob: flag(argv, "glob"), context: flag(argv, "context") ? Number(flag(argv, "context")) : undefined, output })) as { matches: { path: string; line: number; text: string }[]; files: { path: string; count: number }[]; count: number; partial: boolean; error?: string; message?: string };
      if (r.error) throw new CmsRemoteError(r.message ?? r.error, r.error);
      if (argv.includes("--json")) print(r);
      else io.out(output === "count" ? String(r.count) : output === "files" ? r.files.map((f) => f.path).join("\n") : r.matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n"));
      if (r.partial) io.err("[agent-cms] the search stopped early; narrow it (--collections, --glob)");
      return r.count ? 0 : 1;
    }
    case "edit": {
      need(4);
      print(await api.call("edit_document", { collection: args[0], slug: args[1], edits: [{ oldString: args[2], newString: args[3], replaceAll: argv.includes("--all") || undefined }], expectedVersion: expectedVersion(), note: flag(argv, "note") }));
      return 0;
    }
    case "pull":
    case "push":
    case "status":
      return files(cmd, args, argv, api, io, read);
    case "openapi": {
      // What this key may read, as an OpenAPI 3.1 document: `openapi > openapi.json`.
      const res = await (io.fetch ?? fetch)(`${env.AGENT_CMS_URL.replace(/\/$/, "")}/openapi.json`, { headers: { authorization: `Bearer ${env.AGENT_CMS_KEY}`, "x-agent-cms-client": "cli" } });
      if (!res.ok) throw new CmsRemoteError(`the app answered ${res.status} for /openapi.json${res.status === 404 ? " (it runs a version before 0.13.0)" : ""}`, "http");
      print(await res.json());
      return 0;
    }
    case "retention": {
      // What the retention rules would delete (--dry-run), or delete it now. Needs an admin key.
      const rest = createRestClient({ url: env.AGENT_CMS_URL, fetch: io.fetch, headers: { authorization: `Bearer ${env.AGENT_CMS_KEY}`, "x-agent-cms-client": "cli" } });
      print(await rest.runRetention({ dryRun: argv.includes("--dry-run") }));
      return 0;
    }
    case "export": {
      need(1);
      const auth = { authorization: `Bearer ${env.AGENT_CMS_KEY}`, "x-agent-cms-client": "cli" };
      const rest = createRestClient({ url: env.AGENT_CMS_URL, fetch: io.fetch, headers: auth });
      const r = await rest.exportDocs({ collections: flag(argv, "collection")?.split(",").filter(Boolean), drafts: argv.includes("--drafts") });
      const safe = (path: string) => !path.split("/").some((p) => p === ".." || p === "" || p.includes("\\"));
      for (const f of r.files) {
        if (!safe(f.path)) continue;
        const p = join(args[0], f.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.text);
      }
      let saved = 0;
      const missed: string[] = [];
      if (argv.includes("--with-files")) {
        // The files the documents use, next to the manifest: _assets/<id>/<name>.
        const manifest = r.files.find((f) => f.path === "_assets/manifest.json");
        const assets = manifest ? (JSON.parse(manifest.text) as { assets: { id: string; name: string }[] }).assets : [];
        for (const a of assets) {
          if (!safe(`${a.id}/${a.name}`)) continue;
          const res = await (io.fetch ?? fetch)(`${env.AGENT_CMS_URL.replace(/\/$/, "")}/files/${encodeURIComponent(a.id)}/${encodeURIComponent(a.name)}?download=1`, { headers: auth }).catch(() => null);
          if (!res?.ok) {
            missed.push(a.name);
            continue;
          }
          const p = join(args[0], "_assets", a.id, a.name);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, new Uint8Array(await res.arrayBuffer()));
          saved++;
        }
      }
      print({ documents: r.documents, files: r.files.length, ...(argv.includes("--with-files") ? { assets: saved, ...(missed.length ? { missed } : {}) } : {}), dir: args[0] });
      return missed.length ? 1 : 0;
    }
    case "import": {
      need(1);
      const from = flag(argv, "from");
      if (from) {
        // Content from somewhere else: a JSON list, a CSV sheet or a WordPress export file.
        if (!(IMPORT_SOURCES as readonly string[]).includes(from)) throw new CmsRemoteError(`--from must be one of: ${IMPORT_SOURCES.join(", ")}`, "usage");
        const collection = flag(argv, "collection");
        if (from === "notion") {
          // A Notion export: the zip as downloaded, or the folder it unpacks to.
          if (!collection) throw new CmsRemoteError("say where the pages go: --collection <name>", "usage");
          const budget = { bytes: 2 * 1024 * 1024 * 1024, entries: 50_000 };
          const entries = statSync(args[0]).isDirectory() ? walkDir(args[0]) : await unzip(new Uint8Array(readFileSync(args[0])), { budget });
          // Notion puts a zip inside the zip for big exports (one level, same budget).
          const inner = entries.filter((e) => /\.zip$/i.test(e.name));
          for (const z of inner) entries.push(...(await unzip(z.data, { budget })));
          const { docs, assets, skipped } = docsFromNotion(entries.filter((e) => !/\.zip$/i.test(e.name)));
          if (!docs.length) throw new CmsRemoteError(`no pages (.md files) in ${args[0]}. In Notion: ⋯ → Export → "Markdown & CSV", include subpages`, "usage");
          for (const sk of skipped.slice(0, 5)) err(`skipped ${sk}`);
          return importFiles(filesFromDocs(docs, { collection }), null, collection, argv, env.AGENT_CMS_URL, env.AGENT_CMS_KEY, { ...io, out, err }, assets);
        }
        const files = filesFromSource(from as Exclude<ImportSource, "notion">, read(args[0]), { collection, types: flag(argv, "types")?.split(",").map((t) => t.trim()).filter(Boolean) });
        if (!collection && files.some((f) => !f.path.includes("/"))) throw new CmsRemoteError("say where the documents go: --collection <name>", "usage");
        return importFiles(files, null, undefined, argv, env.AGENT_CMS_URL, env.AGENT_CMS_KEY, { ...io, out, err });
      }
      return importDir(args[0], undefined, argv, env.AGENT_CMS_URL, env.AGENT_CMS_KEY, { ...io, out, err });
    }
    case "put": {
      need(2);
      if (existsSync(args[1]) && statSync(args[1]).isDirectory()) return importDir(args[1], args[0], argv, env.AGENT_CMS_URL, env.AGENT_CMS_KEY, { ...io, out, err });
      const [collection, file] = args;
      const doc = docFromMarkdown(read(file), basename(file).replace(/\.(md|markdown)$/i, ""));
      const publish = argv.includes("--publish");
      const note = flag(argv, "note");
      const expected = expectedVersion();
      const current = await api.call<{ version: number }>("get_document", { collection, slug: doc.slug, draft: true }).catch((e: unknown) => {
        if (isCmsRemoteError(e) && e.code === "not_found") return null;
        throw e;
      });
      if (current && expected === undefined && !argv.includes("--force")) {
        // Never overwrite on a version read just now: someone may have edited
        // since this file was written. Say which version the file is based on.
        throw new CmsRemoteError(`${collection}/${doc.slug} already exists (v${current.version}). Read it (get --draft), edit, then put with --expected-version <the version you read>.`, "conflict_version");
      }
      const result = current
        ? await api.call("update_document", { collection, slug: doc.slug, doc, expectedVersion: expected ?? current.version, publish, note })
        : await api.call("create_document", { collection, doc, publish, note });
      print(result);
      return 0;
    }
    case "webhooks": {
      const rest = createRestClient({ url: env.AGENT_CMS_URL, fetch: io.fetch, headers: { authorization: `Bearer ${env.AGENT_CMS_KEY}`, "x-agent-cms-client": "cli" } });
      if (args[0] === "test") {
        if (!args[1]) {
          err("[agent-cms] usage: agent-cms webhooks test <id>");
          return 1;
        }
        const d = await rest.testWebhook(args[1]);
        print(d);
        return d.ok ? 0 : 1;
      }
      print((await rest.webhooks()).webhooks);
      return 0;
    }
    case "upload": {
      need(1);
      const rest = createRestClient({ url: env.AGENT_CMS_URL, fetch: io.fetch, headers: { authorization: `Bearer ${env.AGENT_CMS_KEY}`, "x-agent-cms-client": "cli" } });
      const done = [];
      for (const path of args) done.push(await uploadFile(rest, path, { store: flag(argv, "store"), folder: flag(argv, "folder"), alt: flag(argv, "alt"), tags: flag(argv, "tag")?.split(",").map((t) => t.trim()).filter(Boolean) }, io));
      print(done);
      return 0;
    }
    case "call": {
      need(1);
      // Arguments inline, or from a file / stdin (`--args-file -`) when they are long or need no shell quoting.
      const file = flag(argv, "args-file");
      if (file && args[1]) throw new Error("give the arguments inline or with --args-file, not both");
      const source = file === "-" ? readFileSync(0, "utf8") : file ? read(file) : args[1];
      let parsed: unknown = {};
      try {
        parsed = source ? JSON.parse(source) : {};
      } catch (e) {
        throw new Error(`the arguments ${file ? `in ${file === "-" ? "stdin" : file}` : ""} are not JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      print(await api.call(args[0], parsed as Record<string, unknown>));
      return 0;
    }
    default:
      err(`unknown command: ${cmd}\n${USAGE}`);
      return 1;
  }
}

/** Send a folder of markdown files to `/import`, 100 at a time. Exit 1 when a file could not be read in. */
async function importDir(dir: string, collection: string | undefined, argv: string[], url: string, key: string, io: CliIo & { out: (l: string) => void; err: (l: string) => void }): Promise<number> {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const files = walk(dir)
    .map((p) => ({ path: relative(dir, p).split("\\").join("/"), full: p }))
    .filter((f) => /\.(md|markdown)$/i.test(f.path) && !f.path.startsWith("_"))
    .map((f) => ({ path: f.path, text: readFileSync(f.full, "utf8") }));
  return importFiles(files, dir, collection, argv, url, key, io);
}

/** Send files to `/import` in batches and print one line per file. `dir` is where `_assets/` may be. */
/** Every file under a folder, as zip-like entries (paths with "/"). */
function walkDir(root: string, prefix = ""): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkDir(root, rel));
    else if (e.isFile()) out.push({ name: rel, data: new Uint8Array(readFileSync(join(root, rel))) });
  }
  return out;
}

async function importFiles(files: { path: string; text: string }[], dir: string | null, collection: string | undefined, argv: string[], url: string, key: string, io: CliIo & { out: (l: string) => void; err: (l: string) => void }, extra: { id: string; name: string; data: Uint8Array }[] = []): Promise<number> {
  const rest = createRestClient({ url, fetch: io.fetch, headers: { authorization: `Bearer ${key}`, "x-agent-cms-client": "cli" } });
  const dryRun = argv.includes("--dry-run");
  const onConflict = flag(argv, "on-conflict") as "file-wins" | "db-wins" | "newest" | undefined;
  // Files exported with --with-files: upload the ones this CMS does not have and point the documents at the new ids.
  const assetMap: Record<string, string> = {};
  // Files that came with the source (a Notion export): uploaded once, matched by name and size on a second run.
  if (extra.length && !dryRun) {
    const tmp = mkdtempSync(join(tmpdir(), "agent-cms-import-"));
    const folder = flag(argv, "folder") ?? `imported/${collection ?? "files"}`;
    try {
      for (const a of extra) {
        const same = (await rest.assets({ folder, q: a.name, limit: 50 }).catch(() => ({ assets: [] as { id: string; name: string; size: number }[] }))).assets.find((x) => x.name === a.name && x.size === a.data.length);
        if (same) {
          assetMap[a.id] = same.id;
          continue;
        }
        // Its own folder, so the upload keeps the file's name.
        mkdirSync(join(tmp, a.id));
        const local = join(tmp, a.id, a.name.replace(/[\\/]/g, "_"));
        writeFileSync(local, a.data);
        const made = (await uploadFile(rest, local, { folder }, io)) as { id: string };
        assetMap[a.id] = made.id;
        io.out(`${a.name.padEnd(40)} uploaded as ${made.id}`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const manifestPath = dir ? join(dir, "_assets", "manifest.json") : null;
  if (manifestPath && existsSync(manifestPath) && !dryRun) {
    const { assets } = JSON.parse(readFileSync(manifestPath, "utf8")) as { assets: { id: string; name: string; key: string; store?: string; alt?: string; tags?: string[] }[] };
    const used = new Set(files.flatMap((f) => [...f.text.matchAll(/asset:([a-z0-9]{12})/g)].map((m) => m[1])));
    for (const a of assets) {
      const local = join(dir!, "_assets", a.id, a.name);
      if (!used.has(a.id) || !existsSync(local)) continue;
      const there = await rest.asset(a.id).then(() => true, () => false);
      if (there) continue;
      const folder = a.key.includes("/") ? a.key.slice(0, a.key.lastIndexOf("/")) : undefined;
      // Imported before (a second run, or a run that stopped half way): the same name and size in the same folder is that file.
      const size = statSync(local).size;
      const same = (await rest.assets({ folder, q: a.name, limit: 50 }).catch(() => ({ assets: [] as { id: string; name: string; size: number }[] }))).assets.find((x) => x.name === a.name && x.size === size);
      if (same) {
        assetMap[a.id] = same.id;
        continue;
      }
      const made = (await uploadFile(rest, local, { folder, alt: a.alt, tags: a.tags }, io)) as { id: string };
      assetMap[a.id] = made.id;
      io.out(`${`_assets/${a.id}/${a.name}`.padEnd(40)} uploaded as ${made.id}`);
    }
  }
  const items = [];
  for (let i = 0; i < files.length; i += 100) {
    const r = await rest.importDocs(files.slice(i, i + 100), { dryRun, diff: argv.includes("--diff"), publish: argv.includes("--publish"), onConflict, collection: collection ?? flag(argv, "collection"), ...(Object.keys(assetMap).length ? { assetMap } : {}) });
    items.push(...r.items);
  }
  for (const it of items) {
    const what = it.change === "new" ? "new" : it.change === "update" ? `v${it.fromVersion} -> v${it.toVersion}` : it.change === "same" ? "same" : it.change === "skip" ? `skip (${it.reason})` : `ERROR ${it.reason}`;
    const pub = it.published ? ", published" : it.publishError ? `, saved but NOT published: ${it.publishError}` : "";
    io.out(`${it.path.padEnd(40)} ${what}${pub}${it.diagnostics.filter((d) => d.severity === "warning").length ? `  (${it.diagnostics.filter((d) => d.severity === "warning").length} warning(s))` : ""}`);
    if (it.diff) io.out(it.diff);
  }
  const bad = items.filter((i) => i.change === "error").length;
  const unpublished = items.filter((i) => i.publishError).length;
  io.out(`[agent-cms] ${dryRun ? "would import" : "imported"} ${items.filter((i) => i.change === "new" || i.change === "update").length} of ${items.length} file(s)${bad ? `, ${bad} with errors` : ""}${unpublished ? `, ${unpublished} saved but not published (run the same import with --publish again to publish just those)` : ""}.`);
  return bad || unpublished ? 1 : 0;
}

// ── local ───────────────────────────────────────────────────────────────────

type LocalIo = CliIo & { cwd: string; out: (l: string) => void; err: (l: string) => void };

/** `registry build`: the screens of this installed version as a shadcn registry for your own site. */
function registryCmd(args: string[], argv: string[], io: LocalIo): number {
  if (args[0] !== "build") {
    io.err("[agent-cms] usage: npx @mainsoft/agent-cms registry build --base-url https://your.site/r [--out public/r]");
    return 1;
  }
  const baseUrl = flag(argv, "base-url");
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    io.err("[agent-cms] --base-url is needed: the address the JSON files will be served from, e.g. https://your.site/r");
    return 1;
  }
  const out = resolve(io.cwd, flag(argv, "out") ?? "public/r");
  const files = buildPublicRegistry(io.registryDir ?? findRegistryDir(), out, { baseUrl });
  io.out(`[agent-cms] registry: ${files.length} files in ${relative(io.cwd, out) || "."} for ${baseUrl}`);
  return 0;
}

async function runLocal(cmd: string, args: string[], argv: string[], io: LocalIo): Promise<number> {
  if (cmd === "init") return init(argv, io);
  if (cmd === "add") return add(args, argv, io);
  if (cmd === "registry") return registryCmd(args, argv, io);
  const loaded = await loadConfig(io.cwd);
  if (cmd === "serve" || cmd === "dev") return serveCmd(cmd, argv, loaded?.config ?? null, io);
  if (cmd === "user") return userCmd(args, argv, loaded?.config ?? null, io);
  const tables = cmsTables(loaded?.config.tables);
  const media = async () => io.media ?? (typeof loaded?.config.media === "function" ? await loaded.config.media() : loaded?.config.media);
  if (cmd === "storage" && (args[0] ?? "check") === "check") {
    const m = await media();
    if (!m) return noMedia(io);
    return storageCheck(m, flag(argv, "origin"), io);
  }
  const plugins = loaded?.config.plugins ?? [];
  if (cmd === "migrate" && args[0] === "print") {
    io.out(cmsDdl(tables));
    for (const p of plugins) if (p.sql?.length) io.out(`\n-- plugin ${p.name}\n${p.sql.join(";\n").replace(/;?\s*$/, ";")}`);
    return 0;
  }
  let db = io.db;
  if (!db && loaded?.config.db) {
    try {
      db = await loaded.config.db();
    } catch (e) {
      io.err(`[agent-cms] db() in ${loaded.path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (!db) {
    io.err("[agent-cms] no database: add `db: () => yourDrizzleDb` to agent-cms.config.ts (run `npx @mainsoft/agent-cms init` to create it).");
    return 1;
  }
  const repo = new DrizzleRepo(db, { tables });
  if (cmd === "storage") {
    if (args[0] !== "cleanup" && args[0] !== "sync") {
      io.err(`unknown: storage ${args[0]} (check | cleanup | sync)`);
      return 1;
    }
    const m = await media();
    if (!m) return noMedia(io);
    if (args[0] === "sync") {
      const r = await createCmsCore({ repo, collections: [], media: m }).assets.sync({ store: flag(argv, "store"), prefix: flag(argv, "folder") });
      io.out(`[agent-cms] ${r.registered} file(s) registered, ${r.known} already known.`);
      if (r.missing.length) io.out(`[agent-cms] ${r.missing.length} file(s) the CMS knows are gone from the bucket (nothing was deleted):`);
      for (const f of r.missing.slice(0, 200)) io.out(`  ${f.id}  ${f.key}`);
      return 0;
    }
    const { removed } = await createCmsCore({ repo, collections: [], media: m }).assets.cleanup();
    io.out(`[agent-cms] removed ${removed} unfinished upload(s).`);
    return 0;
  }
  if (cmd === "doctor") {
    const report = await repo.inspect();
    let stale = 0;
    if (!report.missingTables.length && !report.missingColumns.length) stale = (await repo.listAssets({ status: "pending", createdBefore: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), limit: 500 })).length;
    const failedJobs = report.missingTables.length ? 0 : (await repo.countJobs()).failed;
    if (argv.includes("--fix")) {
      if (report.missingTables.length || report.missingColumns.length) {
        io.err("[agent-cms] doctor --fix repairs data only. Bring the schema up first: npx @mainsoft/agent-cms migrate check");
        return 1;
      }
      const fixed = await repo.repair();
      io.out(`[agent-cms] removed ${fixed.orphanVersions} version row(s), ${fixed.orphanAssetRefs} file use(s) and ${fixed.orphanComments} comment(s) that pointed at nothing.`);
      return doctor(await repo.inspect(), tables.options, io, stale, failedJobs);
    }
    return doctor(report, tables.options, io, stale, failedJobs);
  }
  if (cmd === "migrate") {
    const sub = args[0] ?? "check";
    if (sub === "apply") {
      const { sql } = await import("drizzle-orm");
      for (const stmt of splitSql(cmsDdl(tables))) await db.execute(sql.raw(stmt));
      for (const p of plugins) for (const stmt of p.sql ?? []) await db.execute(sql.raw(stmt));
      const withPlugins = plugins.filter((p) => p.sql?.length).map((p) => p.name);
      // Remember which SQL each plugin had when it was applied, so `check` can tell when it changed.
      for (const p of plugins.filter((x) => x.sql?.length)) await rememberPluginSql(repo, p.name, p.sql!);
      io.out(`[agent-cms] schema is at v${SCHEMA_VERSION}.${withPlugins.length ? ` Plugin tables: ${withPlugins.join(", ")}.` : ""}`);
      return 0;
    }
    if (sub === "check") {
      const r = await repo.inspect();
      let pending = migrationSql(r, tables);
      let changed = false;
      // Plugin tables: a plugin whose `CREATE TABLE` names a table the database lacks needs its SQL.
      const { sql: q } = await import("drizzle-orm");
      for (const p of plugins) {
        const names = [...(p.sql ?? []).join("\n").matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/gi)].map((m) => m[1].replace(/"/g, ""));
        let missing = false;
        for (const n of names) {
          const [a, b] = n.includes(".") ? n.split(".") : [null, n];
          const res = (await db.execute(q`select 1 from information_schema.tables where table_name = ${b} and table_schema = coalesce(${a}, current_schema())`)) as unknown as { rows?: unknown[] } | unknown[];
          if (!(Array.isArray(res) ? res : (res.rows ?? [])).length) missing = true;
        }
        if (missing) pending = { sql: `${pending?.sql ?? ""}\n-- plugin ${p.name}\n${p.sql!.join(";\n").replace(/;?\s*$/, ";")}\n`, steps: [...(pending?.steps ?? []), `plugin ${p.name}: its tables`] };
        else if (p.sql?.length && !r.missingTables.length) {
          // Its tables exist: did its SQL change since it was applied? `CREATE TABLE IF NOT EXISTS`
          // would not add a new column, so that needs a migration of its own.
          const was = await appliedPluginSql(repo, p.name);
          if (was && was !== sqlChecksum(p.sql)) {
            io.err(`[agent-cms] plugin ${p.name}: its SQL changed since it was applied (${was.slice(0, 12)} -> ${sqlChecksum(p.sql).slice(0, 12)}). Its tables exist, so write a migration for the change (ALTER TABLE ...), then run \`npx @mainsoft/agent-cms migrate apply\` to record it.`);
            changed = true;
          }
        }
      }
      if (changed && !pending) return 1;
      if (!pending) {
        io.out(`[agent-cms] schema is up to date (v${SCHEMA_VERSION}).`);
        return 0;
      }
      if (flag(argv, "format") === "step") for (const s of pending.steps) io.out(`- ${s}`);
      else io.out(pending.sql);
      const what = (r.schemaVersion ?? 0) >= SCHEMA_VERSION && !r.missingTables.length && !r.missingColumns.length && !r.missingIndexes?.length ? "plugin tables are missing" : `the database needs a migration (v${r.schemaVersion ?? "none"} -> v${SCHEMA_VERSION})`;
      io.err(`[agent-cms] ${what}. Put the SQL above in a migration, or run \`npx @mainsoft/agent-cms migrate apply\`.`);
      return 1;
    }
    io.err(`unknown: migrate ${sub} (check | print | apply)`);
    return 1;
  }
  return 1;
}

/** SQL that brings this database to the current schema, or null when it is current. */
export function migrationSql(r: DoctorReport, tables: ReturnType<typeof cmsTables>): { sql: string; steps: string[] } | null {
  const current = r.schemaVersion ?? 0;
  if (!r.missingTables.length && !r.missingColumns.length && current >= SCHEMA_VERSION && !r.missingIndexes?.length) return null;
  // Missing tables: the whole idempotent DDL (creates only what is missing).
  if (r.missingTables.some((t) => !/(audit|meta|assets|asset_refs|comments|releases|saved_filters|presence|jobs|webhooks|webhook_deliveries|records|changes)$/.test(t))) return { sql: cmsDdl(tables), steps: ["create the agent-cms tables"] };
  // Steps are idempotent: re-run them all when columns are missing, else only the newer ones.
  // A missing change log (0.17.0) alone needs only its own step, like a missing index.
  const onlyLog = r.missingTables.length > 0 && r.missingTables.every((t) => t.endsWith("changes"));
  const steps = upgradeSteps(tables).filter((s) => s.version > current || r.missingColumns.length > 0 || (r.missingTables.length > 0 && !onlyLog) || ((onlyLog || !!r.missingIndexes?.length) && s.version === 9));
  const meta = r.missingTables.some((t) => t.endsWith("meta"))
    ? `CREATE TABLE IF NOT EXISTS ${tables.options.schema ? `"${tables.options.schema}".` : ""}"${tables.options.prefix}meta" ("key" text PRIMARY KEY, "value" jsonb, "updated_at" timestamptz NOT NULL DEFAULT now());\n`
    : "";
  return { sql: `${meta}${steps.map((s) => `-- ${s.name}\n${s.sql}`).join("\n\n")}\n${schemaVersionSql(tables)}`, steps: steps.map((s) => s.name) };
}

function doctor(r: DoctorReport, o: { prefix: string; schema: string | null }, io: LocalIo, staleUploads = 0, failedJobs = 0): number {
  const lines: string[] = [];
  let bad = false;
  const ok = (m: string) => lines.push(`ok    ${m}`);
  const warn = (m: string) => lines.push(`warn  ${m}`);
  const fail = (m: string) => {
    bad = true;
    lines.push(`FAIL  ${m}`);
  };
  if (r.missingTables.length) fail(`missing tables: ${r.missingTables.join(", ")} (npx @mainsoft/agent-cms migrate check)`);
  else ok("all tables exist");
  if (r.missingColumns.length) fail(`missing columns: ${r.missingColumns.join(", ")} (npx @mainsoft/agent-cms migrate check)`);
  else if (!r.missingTables.length) ok("all columns exist");
  if (r.schemaVersion === null || r.schemaVersion < r.expectedSchemaVersion) fail(`schema version ${r.schemaVersion ?? "unknown"}, this release needs ${r.expectedSchemaVersion} (npx @mainsoft/agent-cms migrate check)`);
  else ok(`schema version ${r.schemaVersion}`);
  if (r.badPublished) fail(`${r.badPublished} document(s) point at a published version that is missing`);
  if (r.publishedWithoutVersion) fail(`${r.publishedWithoutVersion} document(s) are published at a version with no row in ${o.prefix}versions (republish them, or see "Repairs" in the operations guide)`);
  if (r.orphanVersions) warn(`${r.orphanVersions} version row(s) without a document (npx @mainsoft/agent-cms doctor --fix)`);
  if (r.orphanAssetRefs) warn(`${r.orphanAssetRefs} file use(s) point at a document or file that is gone (npx @mainsoft/agent-cms doctor --fix)`);
  if (r.orphanComments) warn(`${r.orphanComments} comment(s) belong to a document that is gone (npx @mainsoft/agent-cms doctor --fix)`);
  if (r.missingIndexes?.length) warn(`missing indexes: ${r.missingIndexes.join(", ")}. Lists and pruning get slow on big tables (npx @mainsoft/agent-cms migrate check prints the SQL)`);
  else if (r.missingIndexes && !r.missingTables.length) ok("all indexes exist");
  if (r.changeRows != null && r.changeRows > 1_000_000) warn(`the change log has ${r.changeRows} rows: is the cron call running? It prunes rows older than changes.keepDays`);
  if (staleUploads) warn(`${staleUploads === 500 ? "500+" : staleUploads} upload(s) started more than a day ago and never finished (npx @mainsoft/agent-cms storage cleanup)`);
  if (failedJobs) warn(`${failedJobs} background job(s) failed for good (GET /api/cms/jobs?state=failed shows why; POST /api/cms/jobs/<id>/retry tries again)`);
  if (r.legacyColumns.length) {
    warn(`old columns nothing reads any more: ${r.legacyColumns.join(", ")}. To drop them:`);
    const t = (name: string) => (o.schema ? `"${o.schema}"."${name}"` : `"${name}"`);
    for (const c of r.legacyColumns) {
      const [table, column] = c.split(".");
      lines.push(`      ALTER TABLE ${t(table)} DROP COLUMN IF EXISTS "${column}";`);
    }
  }
  if (r.gapsTable) {
    // Never offer to drop it: the app may still need these rows.
    warn(`${o.prefix}gaps is still here (${r.gapsRows ?? "?"} rows). agent-cms 0.6 no longer uses it. Move it to your app (UPGRADE-0.6.md), then drop it yourself.`);
  }
  for (const l of lines) io.out(l);
  return bad ? 1 : 0;
}

// ── files ───────────────────────────────────────────────────────────────────

function noMedia(io: LocalIo): number {
  io.err("[agent-cms] no file stores: add `media` (the same object you pass to createCms) to agent-cms.config.ts.");
  return 1;
}

/** Upload one file the way a browser does: ask, send to the storage, confirm. */
async function uploadFile(rest: ReturnType<typeof createRestClient>, path: string, o: { store?: string; folder?: string; alt?: string; tags?: string[] }, io: CliIo) {
  const doFetch = io.fetch ?? fetch;
  const whole = io.readBytes?.(path);
  const size = whole ? whole.length : statSync(path).size;
  const fd = whole ? null : openSync(path, "r");
  const slice = (start: number, end: number): Uint8Array => {
    if (whole) return whole.subarray(start, end);
    const buf = new Uint8Array(end - start);
    readSync(fd!, buf, 0, buf.length, start);
    return buf;
  };
  const send = async (url: string, bytes: Uint8Array, headers: Record<string, string> = {}) => {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await doFetch(url, { method: "PUT", headers, body: bytes as BodyInit }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (res.ok) return;
      last = `${res.status} ${(await res.text()).slice(0, 200)}`;
    }
    throw new CmsRemoteError(`the storage refused the upload of ${path}: ${last}`, "upload_failed");
  };
  try {
    const { asset, upload } = await rest.requestUpload({ name: basename(path), size, store: o.store, folder: o.folder, alt: o.alt, tags: o.tags });
    try {
      if (upload.kind === "single") await send(upload.url, slice(0, size), upload.headers);
      else {
        for (let first = 1; first <= upload.partCount; first += 4) {
          const numbers = Array.from({ length: Math.min(4, upload.partCount - first + 1) }, (_, i) => first + i);
          const urls = await rest.uploadPartUrls(asset.id, numbers);
          await Promise.all(urls.map((u) => send(u.url, slice((u.partNumber - 1) * upload.partSize, Math.min(u.partNumber * upload.partSize, size)))));
        }
      }
      // Phone photos keep their size far into the file, so read more than the server does.
      const dims = asset.kind === "image" ? imageSize(slice(0, Math.min(size, 256 * 1024))) : null;
      const done = await rest.completeUpload(asset.id, dims ?? {});
      return { id: done.id, name: done.name, store: done.store, folder: done.folder, size: done.size, url: done.publicUrl ?? done.href, markdown: `${done.kind === "image" || done.kind === "video" || done.kind === "audio" ? "!" : ""}[${done.kind === "image" ? done.alt : done.name}](asset:${done.id}/${encodeURIComponent(done.name)})` };
    } catch (e) {
      await rest.abortUpload(asset.id).catch(() => {});
      throw e;
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Try each store for real and say what works. Exit 1 when something a store needs does not. */
async function storageCheck(media: MediaOptions, origin: string | undefined, io: LocalIo): Promise<number> {
  const doFetch = io.fetch ?? fetch;
  let bad = false;
  const run = `_cms/check-${Date.now().toString(36)}`;
  for (const [name, cfg] of Object.entries(media.stores)) {
    const a = cfg.adapter;
    io.out(`store "${name}" (${cfg.visibility})`);
    io.out(`      accepts: ${(cfg.accept ?? media.accept ?? DEFAULT_ACCEPT).join(", ")}`);
    io.out(`      largest file: ${humanSize(cfg.maxFileSize ?? media.maxFileSize ?? DEFAULT_MAX_FILE_SIZE)}`);
    const origins = cfg.browserOrigins ?? a.browserOrigins;
    if (origins) io.out(`      browser origins: ${origins.length ? origins.join(" ") : "(none)"}`);
    else io.out(`warn  browser origins unknown: the bundled admin's Content-Security-Policy will block uploads to this store. Set media.stores.${name}.browserOrigins (or the adapter's browserOrigins)`);
    const step = async (label: string, fn: () => Promise<string | void>, o: { warnOnly?: boolean } = {}) => {
      try {
        const note = await fn();
        io.out(`ok    ${label}${note ? ` (${note})` : ""}`);
      } catch (e) {
        if (!o.warnOnly) bad = true;
        io.out(`${o.warnOnly ? "warn " : "FAIL "} ${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const expect = (ok: unknown, message: string) => {
      if (!ok) throw new Error(message);
    };
    const text = new TextEncoder().encode("agent-cms storage check");
    await step("write, read and size from the server", async () => {
      await a.put(`${run}/a.txt`, text, { mime: "text/plain" });
      expect((await a.head(`${run}/a.txt`))?.size === text.length, "the stored size differs");
      expect((await a.readStart(`${run}/a.txt`, 5))?.length === 5, "could not read the first bytes");
    });
    let signedPut = "";
    await step("upload with a signed address, as browsers do", async () => {
      const signed = await a.presignPut(`${run}/b.txt`, { mime: "text/plain", expires: 300 });
      signedPut = signed.url;
      const res = await doFetch(signed.url, { method: "PUT", headers: signed.headers, body: text as BodyInit });
      expect(res.ok, `PUT answered ${res.status}`);
      expect((await a.head(`${run}/b.txt`))?.size === text.length, "the file did not arrive");
    });
    if (a.multipart === false) io.out("skip  large files in parts: not supported on this store (a file goes up in one request, and a failed upload starts again)");
    else await step("large files in parts", async () => {
      const id = await a.createMultipart(`${run}/c.bin`, { mime: "application/octet-stream" });
      const sizes = [5 * 1024 * 1024, 1024];
      for (const n of [1, 2]) {
        const res = await doFetch(await a.presignPart(`${run}/c.bin`, id, n, 300), { method: "PUT", body: new Uint8Array(sizes[n - 1]) as BodyInit });
        expect(res.ok, `part ${n} answered ${res.status}`);
      }
      const parts = await a.listParts(`${run}/c.bin`, id);
      expect(parts.length === 2, `the storage lists ${parts.length} of 2 parts`);
      await a.completeMultipart(`${run}/c.bin`, id, parts);
      expect((await a.head(`${run}/c.bin`))?.size === sizes[0] + sizes[1], "the joined file has the wrong size");
    });
    await step("short-lived link to read a file", async () => {
      const url = await a.presignGet(`${run}/a.txt`, { expires: 60 });
      const res = await doFetch(url);
      expect(res.ok, `GET answered ${res.status}`);
      await res.arrayBuffer();
    });
    if (cfg.visibility === "private") {
      await step("files cannot be read without a link", async () => {
        const res = await doFetch((await a.presignGet(`${run}/a.txt`, { expires: 60 })).split("?")[0]);
        await res.arrayBuffer().catch(() => {});
        expect(!res.ok, "the bucket answers anyone: a private store needs a bucket that is not public");
      });
    } else {
      await step("public address", async () => {
        const url = a.publicUrl(`${run}/a.txt`);
        expect(url, "no publicUrl: files open through a short-lived link instead (set publicUrl on the adapter for direct, cacheable addresses)");
        const res = await doFetch(url!);
        await res.arrayBuffer().catch(() => {});
        expect(res.ok, `${url} answered ${res.status}: the bucket (or its CDN) is not public`);
        return url!.split(run)[0];
      }, { warnOnly: true });
    }
    await step("move (copy and delete)", async () => {
      await a.copy(`${run}/a.txt`, `${run}/d.txt`);
      await a.delete(`${run}/a.txt`);
      expect(!(await a.head(`${run}/a.txt`)) && (await a.head(`${run}/d.txt`)), "copy or delete did not take effect");
    });
    if (origin && signedPut) {
      await step(`browsers on ${origin} may upload (CORS)`, async () => {
        const res = await doFetch(signedPut, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
        const allow = res.headers.get("access-control-allow-origin");
        await res.arrayBuffer().catch(() => {});
        expect(allow === "*" || allow === origin, `the bucket's CORS rule does not allow ${origin}`);
      });
    } else io.out("skip  CORS (pass --origin https://your-site to test it)");
    for (const k of ["a.txt", "b.txt", "c.bin", "d.txt"]) await a.delete(`${run}/${k}`).catch(() => {});
  }
  if (Object.values(media.stores).every((s) => s.adapter.multipart === false)) return bad ? 1 : 0;
  io.out("");
  io.out("CORS rule the bucket needs (replace the origin with your site):");
  io.out(JSON.stringify([{ AllowedOrigins: [origin ?? "https://your-site.example"], AllowedMethods: ["GET", "HEAD", "PUT"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600 }], null, 2));
  return bad ? 1 : 0;
}

// ── init ────────────────────────────────────────────────────────────────────

function init(argv: string[], io: LocalIo): number {
  const cwd = io.cwd;
  const appDir = existsSync(join(cwd, "src", "app")) ? "src/" : "";
  const files: [string, string][] = [
    [
      "agent-cms.config.ts",
      `import { defineConfig } from "@mainsoft/agent-cms/config";

export default defineConfig({
  // Your Drizzle database (used by \`agent-cms doctor\` and \`migrate\`).
  db: async () => (await import("./${appDir}lib/db")).db,
});
`,
    ],
    [
      `${appDir}lib/cms-schema.ts`,
      `// Re-export the agent-cms tables from your Drizzle schema so drizzle-kit sees them.
export { cmsApiKeys, cmsAssetRefs, cmsAssets, cmsAudit, cmsComments, cmsDocuments, cmsHits, cmsJobs, cmsMeta, cmsPresence, cmsRecords, cmsReleases, cmsSavedFilters, cmsVersions, cmsWebhookDeliveries, cmsWebhooks } from "@mainsoft/agent-cms/tables";
`,
    ],
    [
      `${appDir}lib/cms.ts`,
      `import { createCms, defineCollection, DrizzleRepo } from "@mainsoft/agent-cms";
import { db } from "./db";

export const posts = defineCollection({
  slug: "posts",
  label: "Posts",
  visibility: "public",
  url: (d) => \`/posts/\${d.slug}\`,
});

export const cms = createCms({
  repo: new DrizzleRepo(db),
  collections: [posts],
  previewSecret: process.env.CMS_PREVIEW_SECRET,
  // Searches that found nothing (when the caller asks): store them if you want.
  onSearchMiss: async (e) => {
    void e;
  },
});
`,
    ],
    [
      `${appDir}app/api/cms/[...path]/route.ts`,
      `import { createCmsHandler } from "@mainsoft/agent-cms/http";
import { cms } from "@/lib/cms";

const handler = createCmsHandler({
  cms,
  // Return the signed-in user, or null. Admins may do everything.
  resolveUser: async () => null,
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
`,
    ],
  ];
  const created: string[] = [];
  for (const [rel, content] of files) {
    const p = join(cwd, rel);
    if (existsSync(p)) {
      io.out(`skip  ${rel} (exists)`);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    created.push(rel);
    io.out(`write ${rel}`);
  }
  const envPath = join(cwd, ".env.example");
  const envLines = ["CMS_PREVIEW_SECRET=   # 32+ random characters, for draft preview links", "AGENT_CMS_URL=http://localhost:3000/api/cms", "AGENT_CMS_KEY=        # sgk_... from the API keys screen"];
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const missing = envLines.filter((l) => !env.includes(l.split("=")[0] + "="));
  if (missing.length) {
    writeFileSync(envPath, `${env}${env && !env.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    io.out(`write .env.example (${missing.length} line(s))`);
  }
  io.out(`
next:
  1. point ${appDir}lib/cms.ts and agent-cms.config.ts at your Drizzle db, and resolveUser at your session
  2. npx @mainsoft/agent-cms migrate check        (SQL for your migration, or: npx @mainsoft/agent-cms migrate apply)
  3. npx @mainsoft/agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command`);
  void argv;
  return 0;
}

// ── add ─────────────────────────────────────────────────────────────────────

function add(args: string[], argv: string[], io: LocalIo): number {
  const registry = io.registry ?? loadRegistry();
  if (argv.includes("--list")) {
    for (const it of registry.items) io.out(`${it.name.padEnd(16)} ${it.description ?? ""}`);
    return 0;
  }
  const mode = argv.includes("--diff") ? "diff" : argv.includes("--update") ? "update" : "add";
  const r = addItems({ cwd: io.cwd, items: args, mode, dir: flag(argv, "dir"), overwrite: argv.includes("--overwrite"), registry });
  if (mode === "diff") {
    io.out(r.diff || "[agent-cms] your copies match this version.");
    return 0;
  }
  for (const f of r.written) io.out(`write  ${f}`);
  for (const f of r.updated) io.out(`update ${f}`);
  for (const f of r.unchanged) io.out(`same   ${f}`);
  for (const s of r.skipped) io.out(`skip   ${s.file} (${s.reason})`);
  for (const f of r.conflicts) io.out(`keep   ${f} (you changed it; the new version is in ${f}.new)`);
  if (r.missingPackages.length) {
    const [bin, args] = installCommand(io.cwd, r.missingPackages);
    if (argv.includes("--yes")) {
      const code = (io.run ?? ((c, a, cwd) => spawnSync(c, a, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1))(bin, args, io.cwd);
      if (code !== 0) {
        io.err(`[agent-cms] \`${bin} ${args.join(" ")}\` failed`);
        return 1;
      }
    } else io.out(`\nthese screens import npm packages your app does not have yet:\n  ${bin} ${args.join(" ")}\n(or run add again with --yes)`);
  }
  if (r.missingParts.length) {
    const cmd = ["shadcn@latest", "add", ...r.missingParts];
    if (argv.includes("--yes")) {
      const code = (io.run ?? ((c, a, cwd) => spawnSync(c, a, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1))("npx", ["--yes", ...cmd], io.cwd);
      if (code !== 0) {
        io.err(`[agent-cms] \`npx ${cmd.join(" ")}\` failed`);
        return 1;
      }
    } else io.out(`\nthese screens use shadcn/ui parts you do not have yet:\n  npx ${cmd.join(" ")}\n(or run add again with --yes)`);
  }
  return 0;
}

// ── pull / push: documents as local files ─────────────────────────────────────

interface PullState {
  files: Record<string, { collection: string; slug: string; version: number; base: string }>;
}

type ToolApi = { call: (name: string, args?: Record<string, unknown>) => Promise<unknown> };

async function files(cmd: "pull" | "push" | "status", args: string[], argv: string[], api: ToolApi, io: CliIo, read: (p: string) => string): Promise<number> {
  const { hasConflictMarkers, mergeFiles } = await import("./doc-files");
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const root = flag(argv, "dir") ?? io.cwd ?? ".";
  const statePath = join(root, ".agent-cms", "state.json");
  const state: PullState = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as PullState) : { files: {} };
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  };
  const fetchFile = async (collection: string, slug: string) => {
    const r = (await api.call("read_document", { collection, slug, limit: 2000 })) as { content?: string; version: number; path: string; totalLines: number; error?: string; message?: string };
    if (r.error) throw new CmsRemoteError(r.message ?? r.error, r.error);
    let text = (r.content ?? "").split("\n").map((l) => l.replace(/^\s*\d+→/, "")).join("\n");
    // Long documents: read the rest in pages.
    for (let from = 2001; from <= r.totalLines; from += 2000) {
      const more = (await api.call("read_document", { collection, slug, offset: from, limit: 2000 })) as { content: string };
      text += "\n" + more.content.split("\n").map((l) => l.replace(/^\s*\d+→/, "")).join("\n");
    }
    return { text: text + "\n", version: r.version, path: r.path };
  };

  if (cmd === "pull") {
    if (args.length < 2) throw new CmsRemoteError("usage: pull <collection> <slug...> [--dir path]", "usage");
    const [collection, ...slugs] = args;
    for (const slug of slugs) {
      const f = await fetchFile(collection, slug);
      const p = join(root, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.text);
      state.files[f.path] = { collection, slug, version: f.version, base: f.text };
      out(`pulled ${f.path} (version ${f.version})`);
    }
    save();
    return 0;
  }

  const paths = (args.length ? args.map((a) => relative(root, a).split("\\").join("/")) : Object.keys(state.files)).filter((p) => state.files[p]);
  if (cmd === "status") {
    for (const p of paths) {
      const s = state.files[p];
      const local = existsSync(join(root, p)) ? read(join(root, p)) : null;
      const remote = (await api.call("read_document", { collection: s.collection, slug: s.slug, limit: 1 })) as { version: number };
      const marks = [local === null ? "deleted here" : local !== s.base ? "changed here" : "", remote.version !== s.version ? `changed in the CMS (v${s.version} → v${remote.version})` : ""].filter(Boolean);
      out(`${p}: ${marks.join(", ") || "up to date"}`);
    }
    return 0;
  }

  let failed = 0;
  for (const p of paths) {
    const s = state.files[p];
    const local = read(join(root, p));
    if (hasConflictMarkers(local)) {
      err(`${p}: still has conflict markers (<<<<<<< / >>>>>>>); fix them first`);
      failed++;
      continue;
    }
    if (local === s.base) continue;
    const remote = await fetchFile(s.collection, s.slug);
    let text = local;
    if (remote.version !== s.version && remote.text !== s.base) {
      const m = mergeFiles(s.base, local, remote.text);
      if (m.conflicts) {
        writeFileSync(join(root, p), m.text);
        state.files[p] = { ...s, version: remote.version, base: remote.text };
        err(`${p}: ${m.conflicts} conflict(s) with an edit made in the CMS (v${s.version} → v${remote.version}). Fix the marked parts, then push again.`);
        failed++;
        continue;
      }
      text = m.text;
      out(`${p}: merged with the CMS's v${remote.version}`);
    }
    const r = (await api.call("write_document", { collection: s.collection, slug: s.slug, content: text, expectedVersion: remote.version, note: flag(argv, "note") })) as { version?: number; saved?: boolean; suggestion?: { id: string }; error?: string; message?: string };
    if (r.error) {
      err(`${p}: ${r.message ?? r.error}`);
      failed++;
      continue;
    }
    if (r.suggestion) out(`${p}: kept as a suggestion (${r.suggestion.id}) for a person to apply`);
    else out(`${p}: saved as version ${r.version}`);
    writeFileSync(join(root, p), text);
    state.files[p] = { ...s, version: r.version ?? remote.version, base: r.suggestion ? remote.text : text };
  }
  save();
  return failed ? 1 : 0;
}

/** `serve` and `dev`: the CMS with its admin and sign-in on one port. Runs until stopped. */
async function serveCmd(cmd: "serve" | "dev", argv: string[], config: AgentCmsConfig | null, io: LocalIo): Promise<number> {
  const { startServer, stopOnSignals } = await import("./serve");
  const port = Number(flag(argv, "port")) || Number(process.env.PORT) || 3000;
  const server = config?.server;
  let cms;
  if (server) cms = await server.cms();
  else if (cmd === "serve") {
    io.err("[agent-cms] serve needs `server: { cms }` in agent-cms.config.ts (your createCms). To try the CMS without one: npx @mainsoft/agent-cms dev");
    return 1;
  } else {
    const { devCms } = await import("./dev");
    const d = await devCms(io.cwd, io.out, { memory: argv.includes("--memory") });
    cms = d.cms;
    io.out(`[agent-cms] dev: a "Posts" collection, ${d.store === "pglite" ? `kept in ${d.dir}` : "in memory"}. Add \`server: { cms }\` to agent-cms.config.ts to use your own collections.`);
  }
  const { cms: _drop, ...rest } = server ?? ({} as NonNullable<typeof server>);
  void _drop;
  const running = await startServer({ ...rest, metricsToken: rest.metricsToken ?? (process.env.CMS_METRICS_TOKEN || undefined), cms, port, host: flag(argv, "host") ?? rest.host ?? (cmd === "dev" ? "127.0.0.1" : "0.0.0.0"), log: io.out });
  stopOnSignals(running, io.out);
  await new Promise<void>((resolve) => running.server.once("close", () => resolve()));
  return 0;
}

/**
 * People of the CMS's own sign-in, from the command line (0.17.0): for the first admin on a server
 * without a terminal log, or a locked-out admin.
 *   agent-cms user create <email> [--name "Kim"] [--admin]   prints a link to set the password
 *   agent-cms user reset-link <email>                       prints a password reset link (1 hour)
 */
async function userCmd(args: string[], argv: string[], config: AgentCmsConfig | null, io: LocalIo): Promise<number> {
  const [sub, email] = args;
  if (!sub || !["create", "reset-link"].includes(sub) || !email) {
    io.err('usage: npx @mainsoft/agent-cms user create <email> [--name "Name"] [--admin] | user reset-link <email>');
    return 1;
  }
  const server = config?.server;
  if (!server) {
    io.err("[agent-cms] user needs `server: { cms }` in agent-cms.config.ts (the same CMS `serve` runs).");
    return 1;
  }
  if (server.auth === false) {
    io.err("[agent-cms] this CMS uses its app's sign-in (server.auth is false): add people there.");
    return 1;
  }
  const { createAuth } = await import("./auth/index");
  const cms = await server.cms();
  const origin = flag(argv, "origin") ?? server.auth?.origin ?? process.env.CMS_ORIGIN ?? `http://localhost:${server.port ?? 3000}`;
  const auth = createAuth({ ...(server.auth || {}), cms, origin, log: () => {} });
  try {
    if (sub === "create") {
      const user = await auth.createUser({ email, name: flag(argv, "name") ?? null, isAdmin: argv.includes("--admin") });
      io.out(`[agent-cms] made ${user.email}${argv.includes("--admin") ? " (admin)" : ""}. Send them this link to set a password (1 hour):`);
    }
    io.out(await auth.resetLink(email, origin));
    return 0;
  } catch (e) {
    io.err(`[agent-cms] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await cms.settle?.().catch(() => undefined);
  }
}

// ── plugin SQL records ──────────────────────────────────────────────────────

/** A stable fingerprint of a plugin's SQL (spacing and case of keywords do not matter). */
export function sqlChecksum(stmts: readonly string[]): string {
  const text = stmts.map((x) => x.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "")).filter(Boolean).join(";\n");
  return [...sha256(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PLUGIN_SQL = "plugin_sql";
async function appliedPluginSql(repo: DrizzleRepo, name: string): Promise<string | null> {
  try {
    const [row] = await repo.listRecords({ kind: PLUGIN_SQL, scope: name, limit: 1, order: "desc" });
    return (row?.data as { checksum?: string } | undefined)?.checksum ?? null;
  } catch {
    return null;
  }
}
async function rememberPluginSql(repo: DrizzleRepo, name: string, stmts: readonly string[]) {
  const checksum = sqlChecksum(stmts);
  if ((await appliedPluginSql(repo, name)) === checksum) return;
  await repo.insertRecord({ kind: PLUGIN_SQL, scope: name, key: checksum.slice(0, 16), data: { checksum, statements: stmts.length }, at: new Date().toISOString() });
}
