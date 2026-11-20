/**
 * The Vercel Blob adapter.
 *
 * The first tests use a stand-in for `@vercel/blob` and always run. The rest
 * run against real Blob stores, only when their tokens are given:
 *
 *   BLOB_TEST_PRIVATE_TOKEN=vercel_blob_rw_… BLOB_TEST_PUBLIC_TOKEN=vercel_blob_rw_… npm run test:blob
 *
 * (a private and a public store made for testing; every key goes under a
 * folder of its own and is deleted at the end).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli";
import { createCms } from "./cms";
import { MemoryRepo } from "./repo";
import { PART_SIZE } from "./storage";
import { vercelBlobStorage, VercelBlobError, type VercelBlobApi } from "./storage-vercel-blob";
import type { Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
function png(size = 3000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 640);
  new DataView(b.buffer).setUint32(20, 480);
  return b;
}

// ── a stand-in that behaves the way the real stores were measured to ────────

/** Named as a bundler would leave it: the adapter has to know it by the package's export. */
class Es extends Error {}
const NotFound = Es;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", pdf: "application/pdf", zip: "application/zip", txt: "text/plain", mp4: "video/mp4" };
const INLINE = new Set(["image/png", "image/jpeg", "application/pdf", "video/mp4"]);

function fakeBlob() {
  const objects = new Map<string, { body: Uint8Array; contentType: string; disposition: "inline" | "attachment"; at: Date }>();
  const calls: string[] = [];
  let issued = 0;
  const typeOf = (pathname: string, given?: unknown) => TYPES[pathname.split(".").pop() ?? ""] ?? (typeof given === "string" ? given : "application/octet-stream");
  const api: VercelBlobApi = {
    BlobNotFoundError: NotFound,
    async put(pathname, body, o) {
      calls.push(`put ${pathname}`);
      const b = new Uint8Array(await (body as Blob).arrayBuffer());
      if (!b.length) throw new Error("body is required");
      const contentType = typeOf(pathname, o.contentType);
      objects.set(pathname, { body: b, contentType, disposition: INLINE.has(contentType) ? "inline" : "attachment", at: new Date() });
      return { pathname };
    },
    async head(pathname) {
      const x = objects.get(pathname);
      if (!x) throw new NotFound("not found");
      return { size: x.body.length, uploadedAt: x.at, pathname, contentType: x.contentType, etag: `"${x.body.length}"`, contentDisposition: x.disposition } as never;
    },
    async get(pathname, o) {
      const x = objects.get(pathname);
      if (!x) return null;
      const m = /bytes=0-(\d+)/.exec((o.headers as { range?: string } | undefined)?.range ?? "");
      if (m && !x.body.length) throw new Error("416");
      return { statusCode: 200, stream: new Response((m ? x.body.slice(0, Number(m[1]) + 1) : x.body) as BodyInit).body };
    },
    async copy(from, to, o) {
      calls.push(`copy ${from} -> ${to}`);
      const x = objects.get(from);
      if (!x) throw new NotFound("not found");
      const contentType = typeOf(to, o.contentType ?? x.contentType);
      objects.set(to, { ...x, contentType, disposition: INLINE.has(contentType) ? "inline" : "attachment" });
      return {};
    },
    async del(pathname) {
      for (const p of [pathname].flat()) objects.delete(p);
    },
    async list(o) {
      const prefix = String(o.prefix ?? "");
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const folders = new Set<string>();
      const flat = all.filter((k) => {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf("/");
        if (o.mode !== "folded" || i < 0) return true;
        folders.add(prefix + rest.slice(0, i + 1));
        return false;
      });
      const start = o.cursor ? Number(o.cursor) : 0;
      const page = flat.slice(start, start + Number(o.limit ?? 1000));
      const more = start + page.length < flat.length;
      return { blobs: page.map((pathname) => ({ pathname, size: objects.get(pathname)!.body.length, uploadedAt: objects.get(pathname)!.at })), folders: [...folders], hasMore: more, cursor: more ? String(start + page.length) : undefined };
    },
    async createFolder(pathname) {
      objects.set(`${pathname}/`, { body: new Uint8Array(), contentType: "application/x-directory", disposition: "attachment", at: new Date() });
      return {};
    },
    async issueSignedToken(o) {
      issued++;
      return { validUntil: Number(o.validUntil), operations: o.operations };
    },
    async presignUrl(t, o) {
      const q = new URLSearchParams({ pathname: String(o.pathname), op: String(o.operation), until: String(o.validUntil) });
      if (o.maximumSizeInBytes) q.set("max", String(o.maximumSizeInBytes));
      assert.ok((t as { operations: string[] }).operations.includes(String(o.operation)), "signed with a token for this kind of work");
      assert.ok(Number(o.validUntil) <= (t as { validUntil: number }).validUntil, "a link never outlives its token");
      return { presignedUrl: `https://blob.test/?${q}` };
    },
  };
  /** What a browser (or anyone holding a signed address) can do. */
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const pathname = u.searchParams.get("pathname")!;
    if (u.searchParams.get("op") === "put" && init?.method === "PUT") {
      const b = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      const max = Number(u.searchParams.get("max") ?? Infinity);
      if (b.length > max) return new Response("too large", { status: 403 });
      // Whatever a browser sends is stored as a download.
      objects.set(pathname, { body: b, contentType: typeOf(pathname, new Headers(init.headers).get("content-type")), disposition: "attachment", at: new Date() });
      return new Response("{}");
    }
    const x = objects.get(pathname);
    return x ? new Response(x.body as BodyInit) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { api, objects, calls, fetcher, issued: () => issued };
}
const TOKEN = "vercel_blob_rw_AbC123xyz_secretsecret";

test("blob: settings are checked when the app starts", () => {
  assert.throws(() => vercelBlobStorage({ token: "", access: "public" }), /read-write token/);
  assert.throws(() => vercelBlobStorage({ token: "sk_live_something", access: "public" }), /vercel_blob_rw_/);
  assert.throws(() => vercelBlobStorage({ token: TOKEN, access: "open" as never }), /"public" or "private"/);
  const pub = vercelBlobStorage({ token: TOKEN, access: "public", prefix: "/site/" });
  assert.equal(pub.multipart, false);
  assert.equal(pub.publicUrl("blog/새 글.png"), "https://abc123xyz.public.blob.vercel-storage.com/site/blog/%EC%83%88%20%EA%B8%80.png");
  assert.equal(vercelBlobStorage({ token: TOKEN, access: "private" }).publicUrl("a.png"), null);
});

test("blob: files, folders, lists, links and what is not there", async () => {
  const f = fakeBlob();
  const s = vercelBlobStorage({ token: TOKEN, access: "private", prefix: "site", blob: f.api, fetch: f.fetcher });
  await s.put("blog/hero.png", png(), { mime: "image/png", cacheControl: "public, max-age=600" });
  assert.ok(f.objects.has("site/blog/hero.png"), "the prefix is real in the store");
  assert.deepEqual([(await s.head("blog/hero.png"))?.size, (await s.head("blog/hero.png"))?.mime, (await s.head("blog/hero.png"))?.key], [3000, "image/png", "blog/hero.png"]);
  assert.equal(await s.head("nope.png"), null);
  assert.equal((await s.readStart("blog/hero.png", 16))?.length, 16);
  assert.equal(await s.readStart("nope.png", 16), null);
  await s.put("blog/empty.txt", new Uint8Array(), { mime: "text/plain" });
  assert.equal((await s.head("blog/empty.txt"))?.size, 0, "an empty file goes through a signed request");
  assert.equal((await s.readStart("blog/empty.txt", 16))?.length, 0);
  await s.put("blog/drafts/", new Uint8Array(), { mime: "application/x-directory" });
  await s.put("blog/drafts/", new Uint8Array(), { mime: "application/x-directory" });
  assert.equal((await s.head("blog/drafts/"))?.size, 0);
  await s.put("blog/2026/a.pdf", bytes(10), { mime: "application/pdf" });

  const top = await s.list({ prefix: "blog/", delimiter: "/" });
  assert.deepEqual(top.objects.map((o) => o.key), ["blog/empty.txt", "blog/hero.png"]);
  assert.deepEqual(top.prefixes, ["blog/2026/", "blog/drafts/"]);
  const page = await s.list({ prefix: "blog/", limit: 2 });
  assert.equal(page.objects.length, 2);
  assert.equal((await s.list({ prefix: "blog/", limit: 10, cursor: page.cursor })).objects.length, 2);
  assert.equal((await s.list({ prefix: "blog/", limit: 10 })).cursor, null);

  await s.copy("blog/hero.png", "moved/hero.png");
  await s.delete("blog/hero.png");
  await s.delete("blog/never.png");
  assert.deepEqual([await s.head("blog/hero.png"), (await s.head("moved/hero.png"))?.size], [null, 3000]);
  // A name without an extension keeps its type across a copy.
  f.objects.set("site/raw", { body: bytes(5), contentType: "image/png", disposition: "attachment", at: new Date() });
  await s.copy("raw", "raw-2");
  assert.equal((await s.head("raw-2"))?.mime, "image/png");

  // Links: one signing token serves many; a long share link gets its own; never past seven days.
  const before = f.issued();
  const a = new URL(await s.presignGet("moved/hero.png", { expires: 300 }));
  const b = new URL(await s.presignGet("moved/hero.png", { expires: 300, download: "표지.png" }));
  assert.equal(f.issued() - before, 1);
  assert.equal(a.searchParams.get("pathname"), "site/moved/hero.png");
  assert.equal(b.searchParams.get("download"), "1");
  const week = new URL(await s.presignGet("moved/hero.png", { expires: 30 * 24 * 3600 }));
  const days = (Number(week.searchParams.get("until")) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7, `a month-long link is cut to ${days.toFixed(2)} days`);
  assert.equal((await f.fetcher(a.toString())).status, 200);

  // Parts do not exist here.
  await assert.rejects(s.createMultipart("big.mp4", { mime: "video/mp4" }), (e) => e instanceof VercelBlobError && /not supported on this store/.test(e.message));
  assert.deepEqual(await s.listParts("big.mp4", "x"), []);
  await s.abortMultipart("big.mp4", "x");
  // A failure says which call failed.
  f.api.copy = async () => {
    throw new Error("store is suspended");
  };
  await assert.rejects(s.copy("moved/hero.png", "x.png"), /Vercel Blob copy failed: store is suspended/);
});

test("blob: the CMS sends a large file in one request and finishes it from the server", async () => {
  const f = fakeBlob();
  const lines: string[] = [];
  const media = { stores: { files: { visibility: "private" as const, adapter: vercelBlobStorage({ token: TOKEN, access: "private", blob: f.api, fetch: f.fetcher }) } } };
  const cms = createCms({ repo: new MemoryRepo(), collections: [], media });
  assert.equal(cms.assets.describe(admin)?.stores[0].parts, false);

  const size = PART_SIZE + 1024;
  const r = await cms.assets.requestUpload(admin, { name: "launch.png", mime: "image/png", size, folder: "blog" });
  assert.equal(r.upload.kind, "single", "no parts on this store, whatever the size");
  assert.ok(r.upload.kind === "single" && new URL(r.upload.url).searchParams.get("max") === String(size), "the address holds the upload to the declared size");
  assert.deepEqual((await cms.assets.uploadStatus(admin, r.asset.id)).done, []);
  // More than was declared is refused by the store itself.
  assert.equal((await f.fetcher((r.upload as { url: string }).url, { method: "PUT", body: png(size + 1) as BodyInit })).status, 403);
  assert.equal((await f.fetcher((r.upload as { url: string }).url, { method: "PUT", headers: (r.upload as { headers: Record<string, string> }).headers, body: png(size) as BodyInit })).status, 200);
  assert.equal(f.objects.get("blog/launch.png")?.disposition, "attachment", "as the browser left it");
  const done = await cms.assets.completeUpload(admin, r.asset.id);
  assert.deepEqual([done.status, done.width, done.height], ["ready", 640, 480]);
  assert.equal(f.objects.get("blog/launch.png")?.disposition, "inline", "opens in the browser after the server finished it");
  assert.ok(f.calls.includes("copy blog/launch.png -> blog/launch.png"));

  // A file that is meant to download is left alone.
  f.calls.length = 0;
  const z = await cms.assets.requestUpload(admin, { name: "kit.zip", mime: "application/zip", size: 30 });
  const zip = bytes(30, 0);
  zip.set([0x50, 0x4b, 0x03, 0x04]);
  await f.fetcher((z.upload as { url: string }).url, { method: "PUT", body: zip as BodyInit });
  await cms.assets.completeUpload(admin, z.asset.id);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("copy")), []);

  // Replacing keeps the address and opens in the browser too.
  const rep = await cms.assets.requestUpload(admin, { name: "new.png", mime: "image/png", size: 500, replace: r.asset.id });
  await f.fetcher((rep.upload as { url: string }).url, { method: "PUT", body: png(500) as BodyInit });
  const after = await cms.assets.completeUpload(admin, rep.asset.id);
  assert.deepEqual([after.id, after.size, after.rev, f.objects.get("blog/launch.png")?.disposition], [r.asset.id, 500, 1, "inline"]);

  // An empty folder and the server's own uploads work the same as elsewhere.
  await cms.assets.createFolder(admin, { path: "press" });
  assert.ok(f.objects.has("press/"));
  const put = await cms.assets.put(admin, { name: "note.txt", mime: "text/plain", bytes: new TextEncoder().encode("hello"), folder: "press" });
  assert.equal(put.size, 5);

  // `storage check` says what this store does not do, and prints no CORS rule.
  const code = await runCli(["storage", "check", "--origin", "https://app.example.com"], { cwd: "/nowhere", out: (l) => lines.push(l), err: (l) => lines.push(l), media, fetch: f.fetcher });
  const out = lines.join("\n");
  assert.match(out, /skip {2}large files in parts: not supported on this store/);
  assert.match(out, /ok {4}upload with a signed address/);
  assert.doesNotMatch(out, /CORS rule the bucket needs/);
  assert.match(out, /files cannot be read without a link|FAIL/);
  assert.ok(code === 0 || code === 1);
});

// ── the real stores ─────────────────────────────────────────────────────────

const run = `t${Date.now().toString(36)}`;
for (const access of ["private", "public"] as const) {
  const token = process.env[`BLOB_TEST_${access.toUpperCase()}_TOKEN`];
  const opts = { skip: token ? false : `BLOB_TEST_${access.toUpperCase()}_TOKEN is not set` };
  const make = (prefix?: string) => vercelBlobStorage({ token: token!, access, prefix });

  test(`blob (real, ${access}): put, head, read the start, signed GET, copy, delete, list, folders`, opts, async () => {
    const s = make();
    try {
      const key = `${run}/블로그 글/hero image.png`;
      await s.put(key, png(), { mime: "image/png" });
      const head = await s.head(key);
      assert.deepEqual([head?.size, head?.mime], [3000, "image/png"]);
      assert.equal(await s.head(`${run}/nope.png`), null);
      assert.deepEqual([...((await s.readStart(key, 16)) ?? [])].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
      assert.equal((await s.readStart(key, 16))?.length, 16);
      assert.equal(await s.readStart(`${run}/nope.png`, 16), null);
      await s.put(`${run}/empty.txt`, new Uint8Array(), { mime: "text/plain" });
      assert.equal((await s.head(`${run}/empty.txt`))?.size, 0);
      assert.equal((await s.readStart(`${run}/empty.txt`, 16))?.length, 0);

      const got = await fetch(await s.presignGet(key, { expires: 60 }));
      assert.equal(got.status, 200);
      assert.equal((await got.arrayBuffer()).byteLength, 3000);
      const dl = await fetch(await s.presignGet(key, { expires: 60, download: "표지.png" }));
      assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
      await dl.arrayBuffer();
      const bare = await fetch((await s.presignGet(key, { expires: 60 })).split("?")[0]);
      await bare.arrayBuffer();
      if (access === "private") {
        assert.ok(bare.status === 403 || bare.status === 401, `unsigned read of a private store: ${bare.status}`);
        assert.equal(s.publicUrl(key), null);
      } else {
        const open = await fetch(s.publicUrl(key)!);
        assert.equal(open.status, 200, `the public address ${s.publicUrl(key)}`);
        assert.equal((await open.arrayBuffer()).byteLength, 3000);
      }

      await s.copy(key, `${run}/moved/hero.png`);
      await s.delete(key);
      assert.equal(await s.head(key), null);
      assert.equal((await s.head(`${run}/moved/hero.png`))?.size, 3000);
      await s.delete(`${run}/never-there.png`);

      await s.put(`${run}/a.txt`, bytes(1), { mime: "text/plain" });
      await s.put(`${run}/drafts/`, new Uint8Array(), { mime: "application/x-directory" });
      await s.put(`${run}/drafts/`, new Uint8Array(), { mime: "application/x-directory" }); // twice is fine
      assert.equal((await s.head(`${run}/drafts/`))?.size, 0);
      const top = await s.list({ prefix: `${run}/`, delimiter: "/" });
      assert.deepEqual(top.objects.map((o) => o.key).sort(), [`${run}/a.txt`, `${run}/empty.txt`]);
      assert.deepEqual([...top.prefixes].sort(), [`${run}/drafts/`, `${run}/moved/`]);
      const inside = await s.list({ prefix: `${run}/drafts/`, delimiter: "/" });
      assert.deepEqual(inside.objects.map((o) => [o.key, o.size]), [[`${run}/drafts/`, 0]]);
      const page = await s.list({ prefix: `${run}/`, limit: 1 });
      assert.equal(page.objects.length, 1);
      assert.ok(page.cursor, "more pages");
      assert.equal((await s.list({ prefix: `${run}/`, limit: 10, cursor: page.cursor })).objects.length, 3);
      await s.delete(`${run}/drafts/`);
      assert.equal(await s.head(`${run}/drafts/`), null);
    } finally {
      for (const o of (await s.list({ prefix: `${run}/` })).objects) await s.delete(o.key).catch(() => {});
    }
  });

  test(`blob (real, ${access}): a browser PUTs with the signed address; the server finishes it; a prefix is invisible`, opts, async () => {
    const s = make(`${run}-under`);
    try {
      const key = "up/사진 1.jpg";
      const signed = await s.presignPut(key, { mime: "image/jpeg", expires: 300, size: 2048 });
      const pre = await fetch(signed.url, { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
      await pre.arrayBuffer();
      assert.ok(["*", "https://app.example.com"].includes(pre.headers.get("access-control-allow-origin") ?? ""), "browsers on any origin may upload");
      const big = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes(4096) });
      assert.equal(big.status, 403, "more than the declared size is refused");
      await big.text();
      const ok = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes(2048) });
      assert.equal(ok.status, 200, await ok.clone().text());
      await ok.text();
      const head = await s.head(key);
      assert.deepEqual([head?.size, head?.mime], [2048, "image/jpeg"]);
      const link = () => s.presignGet(key, { expires: 60 }).then((u) => fetch(u));
      const before = await link();
      await before.arrayBuffer();
      assert.match(before.headers.get("content-disposition") ?? "", /^attachment/, "what a browser sent is stored as a download");
      await s.settle!(key, { mime: "image/jpeg", disposition: null });
      const after = await link();
      await after.arrayBuffer();
      assert.match(after.headers.get("content-disposition") ?? "", /^inline/, "after the server finished it, it opens in the browser");
      assert.equal((await s.head(key))?.size, 2048);
      // The prefix is invisible to callers and real in the store.
      assert.deepEqual((await s.list({ prefix: "up/" })).objects.map((o) => o.key), [key]);
      assert.equal((await make().head(`${run}-under/${key}`))?.size, 2048);
    } finally {
      for (const o of (await s.list({})).objects) await s.delete(o.key).catch(() => {});
    }
  });
}
