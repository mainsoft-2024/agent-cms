/**
 * `agent-cms` CLI.
 *
 * In the app (local, no key needed):
 *   agent-cms init [--yes]                 config, API route, schema re-export, .env lines
 *   agent-cms doctor                       database check (tables, columns, schema version, data)
 *   agent-cms migrate check | print | apply
 *       check: what is missing and the SQL to add it (exit 1 when behind)
 *       print: the full idempotent DDL; apply: run it
 *   agent-cms add <item...> [--diff | --update] [--yes] [--overwrite] [--dir path]
 *       copy admin screens into the app (see `agent-cms add --list`)
 *   agent-cms storage check [--origin https://your-site]
 *       try every file store for real (upload, signed addresses, large-file parts, CORS)
 *       and print what each store accepts. Needs `media` in agent-cms.config.ts.
 *   agent-cms storage cleanup              remove uploads that were started and never finished
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
 *   agent-cms upload <files...> [--store name] [--folder path] [--alt "text"] [--tag a,b]
 *       put files into the media library (large files go up in parts)
 *   agent-cms call <tool> '<json args>'
 *
 * Env: AGENT_CMS_URL (https://app/api/cms) and AGENT_CMS_KEY (sgk_…), or
 * `--env <file>` with those two lines. Output is JSON.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { humanSize, type MediaOptions } from "./assets";
import { createCmsClient, createRestClient, CmsRemoteError, isCmsRemoteError } from "./client";
import { createCmsCore } from "./cms";
import { loadConfig } from "./config";
import { DrizzleRepo, type DoctorReport } from "./drizzle-repo";
import { docFromMarkdown } from "./frontmatter";
import { imageSize } from "./net-guard";
import { DEFAULT_ACCEPT, DEFAULT_MAX_FILE_SIZE } from "./storage";
import { addItems, loadRegistry, type Registry } from "./registry";
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

const WITH_VALUE = new Set(["--env", "--note", "--collections", "--expected-version", "--dir", "--format", "--store", "--folder", "--alt", "--tag", "--origin"]);

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
in your app:   init | doctor | migrate <check|print|apply> | add <item...> [--diff|--update] | storage <check|cleanup|sync>
with a key:    tools | collections | list | get | search | put | patch | publish | upload | call
see https://github.com/mainsoft-2024/agent-cms#cli`;

const LOCAL = new Set(["init", "doctor", "migrate", "add", "storage"]);

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
  try {
    if (LOCAL.has(cmd)) return await runLocal(cmd, args, argv, { ...io, cwd, out, err });
    return await runRemote(cmd, args, argv, { ...io, out, err, read });
  } catch (e) {
    err(`[agent-cms] ${isCmsRemoteError(e) ? `${e.code}: ` : ""}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ── remote ──────────────────────────────────────────────────────────────────

async function runRemote(cmd: string, args: string[], argv: string[], io: CliIo & { out: (l: string) => void; err: (l: string) => void; read: (p: string) => string }): Promise<number> {
  const { out, err, read } = io;
  const envFile = flag(argv, "env");
  const env = { ...(io.env ?? process.env), ...(envFile ? parseEnvFile(read(envFile)) : {}) };
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
    case "put": {
      need(2);
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
      const parsed = args[1] ? JSON.parse(args[1]) : {};
      print(await api.call(args[0], parsed));
      return 0;
    }
    default:
      err(`unknown command: ${cmd}\n${USAGE}`);
      return 1;
  }
}

// ── local ───────────────────────────────────────────────────────────────────

type LocalIo = CliIo & { cwd: string; out: (l: string) => void; err: (l: string) => void };

async function runLocal(cmd: string, args: string[], argv: string[], io: LocalIo): Promise<number> {
  if (cmd === "init") return init(argv, io);
  if (cmd === "add") return add(args, argv, io);
  const loaded = await loadConfig(io.cwd);
  const tables = cmsTables(loaded?.config.tables);
  const media = async () => io.media ?? (typeof loaded?.config.media === "function" ? await loaded.config.media() : loaded?.config.media);
  if (cmd === "storage" && (args[0] ?? "check") === "check") {
    const m = await media();
    if (!m) return noMedia(io);
    return storageCheck(m, flag(argv, "origin"), io);
  }
  if (cmd === "migrate" && args[0] === "print") {
    io.out(cmsDdl(tables));
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
    io.err("[agent-cms] no database: add `db: () => yourDrizzleDb` to agent-cms.config.ts (run `npx agent-cms init` to create it).");
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
    return doctor(report, tables.options, io, stale);
  }
  if (cmd === "migrate") {
    const sub = args[0] ?? "check";
    if (sub === "apply") {
      const { sql } = await import("drizzle-orm");
      for (const stmt of splitSql(cmsDdl(tables))) await db.execute(sql.raw(stmt));
      io.out(`[agent-cms] schema is at v${SCHEMA_VERSION}.`);
      return 0;
    }
    if (sub === "check") {
      const r = await repo.inspect();
      const pending = migrationSql(r, tables);
      if (!pending) {
        io.out(`[agent-cms] schema is up to date (v${SCHEMA_VERSION}).`);
        return 0;
      }
      if (flag(argv, "format") === "step") for (const s of pending.steps) io.out(`- ${s}`);
      else io.out(pending.sql);
      io.err(`[agent-cms] the database needs a migration (v${r.schemaVersion ?? "none"} -> v${SCHEMA_VERSION}). Put the SQL above in a migration, or run \`npx agent-cms migrate apply\`.`);
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
  if (!r.missingTables.length && !r.missingColumns.length && current >= SCHEMA_VERSION) return null;
  // Missing tables: the whole idempotent DDL (creates only what is missing).
  if (r.missingTables.some((t) => !/(audit|meta|assets|asset_refs|comments|releases|saved_filters|presence)$/.test(t))) return { sql: cmsDdl(tables), steps: ["create the agent-cms tables"] };
  // Steps are idempotent: re-run them all when columns are missing, else only the newer ones.
  const steps = upgradeSteps(tables).filter((s) => s.version > current || r.missingColumns.length > 0 || r.missingTables.length > 0);
  const meta = r.missingTables.some((t) => t.endsWith("meta"))
    ? `CREATE TABLE IF NOT EXISTS ${tables.options.schema ? `"${tables.options.schema}".` : ""}"${tables.options.prefix}meta" ("key" text PRIMARY KEY, "value" jsonb, "updated_at" timestamptz NOT NULL DEFAULT now());\n`
    : "";
  return { sql: `${meta}${steps.map((s) => `-- ${s.name}\n${s.sql}`).join("\n\n")}\n${schemaVersionSql(tables)}`, steps: steps.map((s) => s.name) };
}

function doctor(r: DoctorReport, o: { prefix: string; schema: string | null }, io: LocalIo, staleUploads = 0): number {
  const lines: string[] = [];
  let bad = false;
  const ok = (m: string) => lines.push(`ok    ${m}`);
  const warn = (m: string) => lines.push(`warn  ${m}`);
  const fail = (m: string) => {
    bad = true;
    lines.push(`FAIL  ${m}`);
  };
  if (r.missingTables.length) fail(`missing tables: ${r.missingTables.join(", ")} (npx agent-cms migrate check)`);
  else ok("all tables exist");
  if (r.missingColumns.length) fail(`missing columns: ${r.missingColumns.join(", ")} (npx agent-cms migrate check)`);
  else if (!r.missingTables.length) ok("all columns exist");
  if (r.schemaVersion === null || r.schemaVersion < r.expectedSchemaVersion) fail(`schema version ${r.schemaVersion ?? "unknown"}, this release needs ${r.expectedSchemaVersion} (npx agent-cms migrate check)`);
  else ok(`schema version ${r.schemaVersion}`);
  if (r.badPublished) fail(`${r.badPublished} document(s) point at a published version that is missing`);
  if (r.orphanVersions) warn(`${r.orphanVersions} version row(s) without a document`);
  if (staleUploads) warn(`${staleUploads === 500 ? "500+" : staleUploads} upload(s) started more than a day ago and never finished (npx agent-cms storage cleanup)`);
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
export { cmsApiKeys, cmsAssetRefs, cmsAssets, cmsAudit, cmsComments, cmsDocuments, cmsHits, cmsMeta, cmsPresence, cmsReleases, cmsSavedFilters, cmsVersions } from "@mainsoft/agent-cms/tables";
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
  2. npx agent-cms migrate check        (SQL for your migration, or: npx agent-cms migrate apply)
  3. npx agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command`);
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
