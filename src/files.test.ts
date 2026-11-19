/** 0.9.0: the file manager. The bucket as it is, also files the CMS did not upload. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "./cli";
import { createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import { MemoryStorage } from "./storage";
import { callTool, toolsFor } from "./tools";
import { isCmsError, type Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const member: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const text = (s: string) => new TextEncoder().encode(s);

function png(w = 640, h = 480): Uint8Array {
  const b = new Uint8Array(200);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

async function setup(o: { browse?: (a: { actor: Actor }) => boolean } = {}) {
  const priv = new MemoryStorage({ name: "private" });
  const pub = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  let now = Date.parse("2026-11-20T00:00:00Z");
  const repo = new MemoryRepo();
  const cms = createCms({
    repo,
    now: () => new Date(now),
    collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public" })],
    media: { stores: { private: { visibility: "private", adapter: priv, access: o.browse ? { browse: o.browse } : undefined }, public: { visibility: "public", adapter: pub } } },
  });
  // Files some other program put into the bucket.
  await priv.put("contracts/2026/msa-acme.pdf", text("%PDF-1.7\n"), { mime: "application/pdf" });
  await priv.put("contracts/2026/scan.png", png(1000, 700), { mime: "image/png" });
  await priv.put("contracts/2026/signed/final.pdf", text("%PDF-1.7\n"), { mime: "application/pdf" });
  await priv.put("contracts/readme.txt", text("hi"), { mime: "text/plain" });
  await priv.put("_cms/thumbs/x.webp", text("x"), { mime: "image/webp" });
  // And one that came through the CMS.
  const own = await cms.assets.put(admin, { name: "nda.pdf", bytes: text("%PDF-1.7\n"), folder: "contracts/2026", store: "private", alt: "NDA" });
  return { cms, repo, priv, pub, own, tick: (ms: number) => (now += ms) };
}

test("files: a bucket is browsed folder by folder, with what the CMS knows about each file", async () => {
  const { cms, own } = await setup();
  const top = await cms.assets.browse(admin, { store: "private" });
  assert.deepEqual([top.folders, top.files], [[{ path: "contracts", name: "contracts" }], []], "the CMS's own folder is hidden");
  const dir = await cms.assets.browse(admin, { store: "private", prefix: "contracts/2026" });
  assert.deepEqual(dir.folders, [{ path: "contracts/2026/signed", name: "signed" }]);
  assert.deepEqual(dir.files.map((f) => [f.name, f.kind, f.size, f.asset?.id ?? null]), [["msa-acme.pdf", "document", 9, null], ["nda.pdf", "document", 9, own.id], ["scan.png", "image", 200, null]]);
  assert.ok(dir.files[0].updatedAt);
  assert.deepEqual((await cms.assets.browse(admin, { store: "private", prefix: "contracts/2026", q: "ms" })).files.map((f) => f.name), ["msa-acme.pdf"]);
  // An empty folder made in the media library shows up; its marker does not.
  await cms.assets.createFolder(admin, { store: "private", path: "contracts/2026/drafts" });
  const again = await cms.assets.browse(admin, { store: "private", prefix: "contracts/2026" });
  assert.deepEqual([again.folders.map((f) => f.name), again.files.length], [["drafts", "signed"], 3]);
  for (const bad of ["../x", "_cms", "_cms/thumbs"]) await assert.rejects(cms.assets.browse(admin, { store: "private", prefix: bad }), (e) => isCmsError(e) && e.code === "invalid_folder");
  await assert.rejects(cms.assets.browse({ kind: "anonymous" }, { store: "private" }), (e) => isCmsError(e) && e.code === "unauthorized");
  assert.equal((await cms.assets.browse(member, { store: "private" })).folders.length, 1, "whoever may read a store may look around it");
  // `access.browse` closes the bucket view without closing the library.
  const closed = await setup({ browse: ({ actor }) => actor.kind === "user" && actor.isAdmin });
  await assert.rejects(closed.cms.assets.browse(member, { store: "private" }), (e) => isCmsError(e) && e.code === "forbidden_media");
  assert.deepEqual(closed.cms.assets.describe(member)?.stores.map((s) => s.can.browse), [false, true]);
  assert.equal((await closed.cms.assets.list(member, { store: "private" })).assets.length, 1);
});

test("files: an unknown file gets a row when it is used, and then works in documents", async () => {
  const { cms, repo } = await setup();
  const a = await cms.assets.register(admin, { store: "private", key: "contracts/2026/scan.png", alt: "Signed page" });
  assert.deepEqual([a.name, a.folder, a.kind, a.mime, a.size, a.width, a.height, a.alt, a.createdBy], ["scan.png", "contracts/2026", "image", "image/png", 200, 1000, 700, "Signed page", "Kim"]);
  assert.equal((await cms.assets.register(admin, { store: "private", key: "contracts/2026/scan.png" })).id, a.id, "registering twice gives the same row");
  assert.equal(repo.audit.filter((x) => x.action === "asset.register").length, 1);
  await cms.create(admin, "guide", { slug: "deal", title: "Deal", body: `![](asset:${a.id}/scan.png)` });
  assert.deepEqual((await cms.assets.get(admin, a.id)).usage.map((u) => u.slug), ["deal"]);
  await assert.rejects(cms.assets.register(admin, { store: "private", key: "contracts/nope.pdf" }), (e) => isCmsError(e) && e.code === "asset_not_found");
  await assert.rejects(cms.assets.register(admin, { store: "private", key: "_cms/thumbs/x.webp" }), (e) => isCmsError(e) && e.code === "invalid_folder");
  await assert.rejects(cms.assets.register(member, { store: "private", key: "contracts/readme.txt" }), (e) => isCmsError(e) && e.code === "forbidden_media");
});

test("files: files and whole folders move; rows follow, documents keep working, nothing is overwritten", async () => {
  const { cms, priv, own } = await setup();
  const scan = await cms.assets.register(admin, { store: "private", key: "contracts/2026/scan.png" });
  await cms.create(admin, "guide", { slug: "deal", title: "Deal", body: `[NDA](asset:${own.id}/nda.pdf)` });
  await cms.assets.createFolder(admin, { store: "private", path: "contracts/2026/drafts" });
  await priv.put("archive/2026/scan.png", png(), { mime: "image/png" });
  const r = await cms.assets.moveMany(admin, { store: "private", folders: ["contracts/2026"], keys: ["contracts/readme.txt"], to: "archive" });
  assert.deepEqual(r, { moved: 5, failed: [] });
  assert.deepEqual([...priv.objects.keys()].filter((k) => !k.startsWith("_cms/")).sort(), ["archive/2026/drafts/", "archive/2026/msa-acme.pdf", "archive/2026/nda.pdf", "archive/2026/scan-2.png", "archive/2026/scan.png", "archive/2026/signed/final.pdf", "archive/readme.txt"]);
  const moved = await cms.assets.get(admin, scan.id);
  assert.deepEqual([moved.key, moved.folder, moved.name], ["archive/2026/scan-2.png", "archive/2026", "scan-2.png"], "a taken name gets a number");
  assert.equal((await cms.assets.get(admin, own.id)).key, "archive/2026/nda.pdf");
  assert.equal((await cms.assets.open(admin, own.id)).url, "memory://private/archive/2026/nda.pdf?expires=300", "the document's link still opens the file");
  assert.deepEqual((await cms.assets.folders(admin))[0].folders.map((f) => f.path), ["archive", "archive/2026", "archive/2026/drafts"]);
  // A folder cannot go into itself, and a failure does not stop the rest.
  await assert.rejects(cms.assets.moveMany(admin, { store: "private", folders: ["archive"], to: "archive/2026" }), (e) => isCmsError(e) && e.code === "invalid_folder");
  const copy = priv.copy.bind(priv);
  priv.copy = async (from, to) => {
    if (from.endsWith("msa-acme.pdf")) throw new Error("storage said no");
    return copy(from, to);
  };
  const partial = await cms.assets.moveMany(admin, { store: "private", keys: ["archive/2026/msa-acme.pdf", "archive/readme.txt"], to: "" });
  assert.deepEqual(partial, { moved: 1, failed: [{ key: "archive/2026/msa-acme.pdf", message: "storage said no" }] });
  assert.ok(priv.objects.has("readme.txt") && priv.objects.has("archive/2026/msa-acme.pdf"));
  await assert.rejects(cms.assets.moveMany(member, { store: "private", keys: ["readme.txt"], to: "x" }), (e) => isCmsError(e) && e.code === "forbidden_media");
});

test("files: deleting many asks first when documents use any of them", async () => {
  const { cms, priv, own } = await setup();
  await cms.create(admin, "guide", { slug: "deal", title: "Deal", body: `[NDA](asset:${own.id}/nda.pdf)` });
  await assert.rejects(
    cms.assets.removeMany(admin, { store: "private", folders: ["contracts/2026"] }),
    (e) => isCmsError(e) && e.code === "asset_in_use" && JSON.stringify(e.current) === JSON.stringify({ documents: [{ collection: "guide", slug: "deal", title: "Deal", status: "draft", inDraft: true, inPublished: false }], hidden: 0, files: 4, used: 1 })
  );
  assert.equal(priv.objects.size, 6, "nothing was deleted");
  const check = await cms.assets.removeMany(admin, { store: "private", folders: ["contracts"], check: true });
  assert.deepEqual([check.deleted, check.files, check.used, check.documents.map((d) => d.slug)], [0, 5, 1, ["deal"]]);
  assert.equal((await cms.assets.removeMany(admin, { store: "private", keys: ["contracts/readme.txt"] })).deleted, 1);
  assert.equal((await cms.assets.removeMany(admin, { store: "private", folders: ["contracts/2026"], confirm: true })).deleted, 4);
  assert.deepEqual([...priv.objects.keys()], ["_cms/thumbs/x.webp"]);
  await assert.rejects(cms.assets.get(admin, own.id), (e) => isCmsError(e) && e.code === "asset_not_found");
  await assert.rejects(cms.assets.removeMany(admin, { store: "private", keys: ["_cms/thumbs/x.webp"] }), (e) => isCmsError(e) && e.code === "invalid_folder");
});

test("files: a share link works for the chosen time; public files give their public address", async () => {
  const { cms, repo, own, pub } = await setup();
  const link = await cms.assets.share(admin, own.id, { ttl: "7d" });
  assert.deepEqual(link, { url: "memory://private/contracts/2026/nda.pdf?expires=604800", expiresAt: "2026-11-27T00:00:00.000Z" });
  assert.equal((await cms.assets.share(admin, own.id)).expiresAt, "2026-11-21T00:00:00.000Z", "24 hours unless said otherwise");
  assert.deepEqual(repo.audit.filter((a) => a.action === "asset.share").map((a) => a.detail), [{ id: own.id, store: "private", key: own.key, ttl: "7d" }, { id: own.id, store: "private", key: own.key, ttl: "24h" }]);
  await pub.put("logo.png", png(), { mime: "image/png" });
  const logo = await cms.assets.register(admin, { store: "public", key: "logo.png" });
  assert.deepEqual(await cms.assets.share(admin, logo.id, { ttl: "1h" }), { url: "https://cdn.example.com/logo.png", expiresAt: null });
  await assert.rejects(cms.assets.share(member, own.id), (e) => isCmsError(e) && e.code === "forbidden_media");
  await assert.rejects(cms.assets.share(admin, own.id, { ttl: "30d" as "7d" }), (e) => isCmsError(e) && e.code === "invalid");
});

test("files: REST, the three agent tools and `storage sync`", async () => {
  const { cms, priv, own } = await setup();
  let user: typeof admin | null = admin;
  const handler = createCmsHandler({ cms, resolveUser: async () => user });
  const rest = createRestClient({ url: "http://x/api/cms", fetch: (async (i: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(i), init))) as typeof fetch });
  assert.deepEqual((await rest.me()).media?.stores.map((s) => s.can.browse), [true, true]);
  const dir = await rest.storeFiles("private", { prefix: "contracts/2026" });
  assert.deepEqual([dir.folders.map((f) => f.name), dir.files.map((f) => f.name)], [["signed"], ["msa-acme.pdf", "nda.pdf", "scan.png"]]);
  const reg = await rest.registerFile("private", "contracts/2026/msa-acme.pdf", { tags: ["acme"] });
  assert.deepEqual([reg.name, reg.tags], ["msa-acme.pdf", ["acme"]]);
  assert.match((await rest.shareAsset(reg.id, "1h")).url, /expires=3600$/);
  assert.equal(rest.storeFileUrl("private", "contracts/readme.txt", { download: true }), "http://x/api/cms/stores/private/files/_open?key=contracts%2Freadme.txt&download=1");
  const open = await handler(new Request(rest.storeFileUrl("private", "contracts/readme.txt", { download: true })));
  assert.deepEqual([open.status, open.headers.get("location")], [302, "memory://private/contracts/readme.txt?expires=300&download=readme.txt"]);
  assert.deepEqual(await rest.moveFiles("private", { keys: ["contracts/readme.txt"], to: "notes" }), { moved: 1, failed: [] });
  await cms.create(admin, "guide", { slug: "deal", title: "Deal", body: `[NDA](asset:${own.id}/nda.pdf)` });
  await assert.rejects(rest.removeFiles("private", { keys: [own.key, "notes/readme.txt"] }), (e) => isCmsRemoteError(e) && e.status === 409 && (e.current as { files: number; used: number }).files === 2 && (e.current as { used: number }).used === 1);
  assert.equal((await rest.removeFiles("private", { keys: ["notes/readme.txt"] })).deleted, 1);
  user = null;
  assert.equal((await handler(new Request("http://x/api/cms/stores/private/files"))).status, 401);
  assert.equal((await handler(new Request("http://x/api/cms/stores/private/files/_open?key=contracts/2026/scan.png"))).status, 401);

  // Tools: looking is for read keys, registering for write keys, a share link needs publish.
  const key = async (scopes: ("read" | "write" | "publish")[]) => (await cms.authenticateKey((await cms.createKey(admin, { name: scopes.join("+"), scopes })).secret))!;
  const writer = await key(["read", "write"]);
  const names = (a: Actor) => toolsFor(cms, a).map((t) => t.name).filter((n) => ["list_store_files", "register_asset", "create_share_link"].includes(n));
  assert.deepEqual([names(await key(["read"])), names(writer), names(await key(["read", "write", "publish"]))], [["list_store_files"], ["list_store_files", "register_asset"], ["list_store_files", "register_asset", "create_share_link"]]);
  const seen = (await callTool(cms, writer, "list_store_files", { store: "private", prefix: "contracts/2026" })) as { folders: string[]; files: { key: string; id: string | null }[] };
  assert.deepEqual([seen.folders, seen.files.map((f) => [f.key, !!f.id])], [["contracts/2026/signed"], [["contracts/2026/msa-acme.pdf", true], ["contracts/2026/nda.pdf", true], ["contracts/2026/scan.png", false]]]);
  const got = (await callTool(cms, writer, "register_asset", { store: "private", key: "contracts/2026/scan.png", alt: "Scan" })) as { id: string; markdown: string };
  assert.equal(got.markdown, `![Scan](asset:${got.id}/scan.png)`);
  assert.equal(((await callTool(cms, writer, "create_share_link", { id: got.id })) as { error: string }).error, "unknown_tool", "a write key cannot hand files out");
  assert.match(((await callTool(cms, await key(["read", "write", "publish"]), "create_share_link", { id: got.id, ttl: "1h" })) as { url: string }).url, /scan\.png\?expires=3600$/);

  // CLI: register what is left, report rows whose file is gone.
  priv.objects.delete(own.key);
  const lines: string[] = [];
  const r = await cms.assets.sync({ store: "private" });
  assert.deepEqual([r.registered, r.known, r.missing], [1, 2, [{ id: own.id, key: own.key }]]);
  assert.equal(await runCli(["storage", "sync"], { cwd: "/nowhere", out: (l) => lines.push(l), err: (l) => lines.push(l) }), 1, "needs a database");
});
