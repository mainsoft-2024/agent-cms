/** 0.8.0: the media library over REST, the agent tools and the CLI. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { runCli } from "./cli";
import { createCmsClient, createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import { MemoryStorage, PART_SIZE } from "./storage";
import { callTool, toolsFor } from "./tools";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const member: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Lee", isAdmin: false };

function png(w = 640, h = 480, size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

function setup() {
  const pub = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  const priv = new MemoryStorage({ name: "private" });
  const media = {
    stores: { public: { visibility: "public" as const, adapter: pub, label: "Public" }, private: { visibility: "private" as const, adapter: priv, label: "Private" } },
    resolveHost: async () => ["93.184.216.34"],
    fetch: (async () => new Response(png(800, 600, 400) as BodyInit, { headers: { "content-type": "image/png" } })) as typeof fetch,
  };
  const blog = defineCollection({ slug: "blog", label: "Blog", visibility: "public", fields: z.object({ cover: z.string().optional() }), admin: { fields: { cover: { widget: "image", maxFileSize: 5000 } } }, media: { requireAlt: true } });
  const cms = createCms({ repo: new MemoryRepo(), collections: [blog], media, trash: { days: 0 } });
  let user: Extract<Actor, { kind: "user" }> | null = admin;
  const handler = createCmsHandler({ cms, resolveUser: async () => user });
  /** `fetch` for the CMS route and for the in-memory storage's signed addresses. */
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("memory://")) {
      const store = url.startsWith("memory://private/") ? priv : pub;
      const status = await store.send(url, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return new Response(null, { status });
    }
    return handler(new Request(url, init));
  }) as typeof fetch;
  const rest = createRestClient({ url: "http://x/api/cms", fetch: doFetch });
  return { cms, pub, priv, media, handler, doFetch, rest, as: (u: typeof user) => (user = u) };
}

test("rest: the admin learns about the library from /_me and the field rules from /_schema", async () => {
  const { rest, as } = setup();
  const me = await rest.me();
  assert.deepEqual(me.media?.stores.map((s) => [s.name, s.label, s.visibility, s.can.write, s.can.delete, s.maxFileSize]), [["public", "Public", "public", true, true, 5 * 1024 ** 3], ["private", "Private", "private", true, true, 5 * 1024 ** 3]]);
  assert.ok(me.media?.stores[0].accept.includes("image/png"));
  assert.equal(me.media?.partSize, PART_SIZE);
  const schema = await rest.schema("blog");
  assert.deepEqual([schema.admin.cover, schema.requireAlt], [{ widget: "image", maxFileSize: 5000 }, true]);
  as(member);
  assert.deepEqual((await rest.me()).media?.stores.map((s) => s.can), [{ write: false, delete: false, browse: true }, { write: false, delete: false, browse: true }]);
  as(null);
  assert.equal((await rest.me()).media, null);
});

test("rest: upload, list, edit, move, open and delete a file", async () => {
  const { rest, doFetch, handler, pub, as } = setup();
  const bytes = png(1200, 630, 300);
  const { asset, upload } = await rest.requestUpload({ name: "hero.png", mime: "image/png", size: bytes.length, folder: "blog", field: { collection: "blog", path: "cover" } });
  assert.equal(upload.kind, "single");
  if (upload.kind === "single") assert.equal((await doFetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes as BodyInit })).status, 200);
  const done = await rest.completeUpload(asset.id);
  assert.deepEqual([done.status, done.width, done.height], ["ready", 1200, 630]);
  const thumbed = await rest.setAssetThumb(asset.id, png(48, 48, 120));
  assert.equal(thumbed.thumbHref, `/api/cms/files/${asset.id}/hero.png?thumb=1`);
  assert.equal(rest.fileUrl(done, { thumb: true }), `http://x/api/cms/files/${asset.id}/hero.png?thumb=1`);

  await rest.createAssetFolder("guide/2026");
  const listed = await rest.assets({ folder: "blog", kind: "image,video" });
  assert.deepEqual([listed.assets.map((a) => a.name), listed.counts.image], [["hero.png"], 1]);
  assert.deepEqual((await rest.assetFolders())[0].folders, [{ path: "blog", count: 1 }, { path: "guide", count: 0 }, { path: "guide/2026", count: 0 }]);
  assert.equal((await rest.updateAsset(asset.id, { alt: "Launch", tags: ["q4"] })).alt, "Launch");
  assert.equal((await rest.moveAsset(asset.id, { folder: "brand" })).key, "brand/hero.png");
  await rest.deleteAssetFolder("guide/2026");

  // The file route redirects: to the public address, or to a signed one.
  const open = await handler(new Request(`http://x/api/cms/files/${asset.id}/hero.png`));
  assert.deepEqual([open.status, open.headers.get("location"), open.headers.get("cache-control")], [302, "https://cdn.example.com/brand/hero.png", "public, max-age=300"]);
  const thumb = await handler(new Request(`http://x/api/cms/files/${asset.id}/x?thumb=1`));
  assert.equal(thumb.headers.get("location"), `https://cdn.example.com/_cms/thumbs/${asset.id}.png`);
  const dl = await handler(new Request(`http://x/api/cms/files/${asset.id}/hero.png?download=1`));
  assert.match(dl.headers.get("location") ?? "", /^memory:\/\/public\/brand\/hero\.png\?expires=300&download=hero\.png$/);
  assert.equal(dl.headers.get("cache-control"), "private, no-store");

  // A file in use: 409 with the documents, then ?confirm=1.
  await rest.create("blog", { slug: "launch", title: "Launch", fields: { cover: asset.id } });
  const detail = await rest.asset(asset.id);
  assert.deepEqual(detail.usage.map((u) => [u.collection, u.slug, u.inDraft, u.inPublished]), [["blog", "launch", true, false]]);
  await assert.rejects(rest.removeAsset(asset.id), (e) => isCmsRemoteError(e) && e.code === "asset_in_use" && e.status === 409 && (e.current as { documents: { slug: string }[] }).documents[0].slug === "launch");
  await rest.removeAsset(asset.id, { confirm: true });
  assert.equal(pub.objects.size, 0, "the file, its thumbnail and the folder markers are gone");
  assert.equal((await handler(new Request(`http://x/api/cms/files/${asset.id}/hero.png`))).status, 404);

  // People who may not write get a clear answer; strangers are asked to sign in.
  as(member);
  await assert.rejects(rest.requestUpload({ name: "a.png", size: 10 }), (e) => isCmsRemoteError(e) && e.code === "forbidden_media" && e.status === 403);
  as(null);
  await assert.rejects(rest.assets(), (e) => isCmsRemoteError(e) && e.status === 401);
});

test("rest: the rules reach the browser as errors it can show", async () => {
  const { rest, doFetch, handler } = setup();
  await assert.rejects(rest.requestUpload({ name: "page.html", size: 10 }), (e) => isCmsRemoteError(e) && e.code === "asset_type_not_allowed" && e.status === 422 && e.message === "This file type is not allowed");
  await assert.rejects(rest.requestUpload({ name: "big.png", size: 5001, field: { collection: "blog", path: "cover" } }), (e) => isCmsRemoteError(e) && e.code === "asset_too_large" && e.status === 413 && e.message === "The file is too large. The limit is 4.9KB");
  const { asset, upload } = await rest.requestUpload({ name: "fake.png", size: 13 });
  if (upload.kind === "single") await doFetch(upload.url, { method: "PUT", body: "<html></html>" });
  await assert.rejects(rest.completeUpload(asset.id), (e) => isCmsRemoteError(e) && e.code === "asset_type_mismatch" && e.message === "The file content does not match its extension");
  // An image without alt text stops a save here (`requireAlt`), with the line.
  const pic = await rest.importAsset({ url: "https://example.com/a.png" });
  await assert.rejects(rest.create("blog", { slug: "a", title: "A", body: `Intro\n\n![](asset:${pic.id}/a.png)` }), (e) => isCmsRemoteError(e) && e.code === "asset_alt_missing" && e.diagnostics?.[0].path === "body" && e.params?.line === 3);
  assert.deepEqual((await rest.diagnose("blog", { slug: "a", title: "A", fields: { cover: pic.id } })).map((d) => [d.path, d.code, d.severity]), [["fields.cover", "asset_alt_empty", "error"]]);
  // Private files: a signed link for people who are signed in, 401 for everyone else.
  const { asset: secret, upload: how } = await rest.requestUpload({ name: "contract.pdf", size: 9, store: "private" });
  if (how.kind === "single") await doFetch(how.url, { method: "PUT", body: "%PDF-1.7\n" });
  await rest.completeUpload(secret.id);
  const open = await handler(new Request(`http://x/api/cms/files/${secret.id}/contract.pdf`));
  assert.deepEqual([open.status, open.headers.get("location"), open.headers.get("cache-control")], [302, "memory://private/contract.pdf?expires=300", "private, no-store"]);
  const anonHandler = createCmsHandler({ cms: setup().cms, resolveUser: async () => null });
  assert.equal((await anonHandler(new Request(`http://x/api/cms/assets`))).status, 401);
  // A cross-site page cannot make a signed-in browser upload.
  const cross = await handler(new Request("http://x/api/cms/assets/uploads", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "a.png", size: 10 }) }));
  assert.equal(cross.status, 403);
});

test("tools: six file tools, offered by what the key may do", async () => {
  const { cms } = setup();
  const key = async (scopes: ("read" | "write" | "publish")[]) => (await cms.authenticateKey((await cms.createKey(admin, { name: scopes.join("+"), scopes })).secret))!;
  const names = (a: Actor) => toolsFor(cms, a).map((t) => t.name).filter((n) => ["list_assets", "get_asset", "import_asset", "update_asset", "move_asset", "delete_asset"].includes(n));
  assert.deepEqual(names({ kind: "anonymous" }), []);
  assert.deepEqual(names(await key(["read"])), ["list_assets", "get_asset"]);
  assert.deepEqual(names(await key(["read", "write"])), ["list_assets", "get_asset", "import_asset", "update_asset"]);
  const publisher = await key(["read", "write", "publish"]);
  assert.deepEqual(names(publisher), ["list_assets", "get_asset", "import_asset", "update_asset", "move_asset", "delete_asset"]);
  assert.equal(toolsFor(cms, publisher).length, 51, "42 document tools (5 file-style since 0.15.0, 6 content model tools since 0.21.0), 6 for the library, 3 for the bucket");
  const plain = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "g", label: "G", visibility: "public" })] });
  assert.equal(toolsFor(plain, { kind: "system", label: "s" }).length, 42, "no media tools without a media library");

  const writer = await key(["read", "write"]);
  const got = (await callTool(cms, writer, "import_asset", { url: "https://example.com/pics/team.png", folder: "blog", alt: "The team" })) as { id: string; markdown: string; width: number; url: string };
  assert.deepEqual([got.markdown, got.width, got.url], [`![The team](asset:${got.id}/team.png)`, 800, "https://cdn.example.com/blog/team.png"]);
  // The markdown the tool returned works as a document body.
  await callTool(cms, writer, "create_document", { collection: "blog", doc: { slug: "team", title: "Team", body: `Meet us.\n\n${got.markdown}` } });
  const listed = (await callTool(cms, writer, "list_assets", { q: "team" })) as { assets: { id: string }[]; stores: { store: string; folders: string[] }[] };
  assert.deepEqual([listed.assets.map((a) => a.id), listed.stores[0]], [[got.id], { store: "public", visibility: "public", files: 1, folders: ["blog"] }]);
  assert.deepEqual(((await callTool(cms, writer, "get_asset", { id: got.id })) as { usedBy: { slug: string }[] }).usedBy.map((u) => u.slug), ["team"]);
  assert.equal(((await callTool(cms, writer, "update_asset", { id: got.id, alt: "Our team" })) as { alt: string }).alt, "Our team");
  // Moving and deleting need a key that may publish, as deleting a document does.
  assert.deepEqual(((await callTool(cms, writer, "move_asset", { id: got.id, folder: "x" })) as { error: string }).error, "unknown_tool");
  assert.equal(((await callTool(cms, publisher, "move_asset", { id: got.id, folder: "brand", name: "team-2026" })) as { name: string }).name, "team-2026.png");
  const refused = (await callTool(cms, publisher, "delete_asset", { id: got.id })) as { error: string; params: { count: number; documents: string[] } };
  assert.deepEqual([refused.error, refused.params.count, refused.params.documents], ["asset_in_use", 1, ["blog/team"]]);
  assert.deepEqual(await callTool(cms, publisher, "delete_asset", { id: got.id, confirm: true }), { deleted: true });
  assert.equal(((await callTool(cms, writer, "import_asset", { url: "https://10.0.0.1/a.png" })) as { error: string }).error, "import_blocked");
});

test("mcp: the file tools arrive over MCP with the key's permissions", async () => {
  const { cms, doFetch } = setup();
  const { secret } = await cms.createKey(admin, { name: "agent", scopes: ["read", "write"] });
  const api = createCmsClient({ url: "http://x/api/cms", key: secret, fetch: doFetch });
  const tools = (await api.listTools()).map((t) => t.name);
  assert.ok(tools.includes("import_asset") && tools.includes("list_assets") && !tools.includes("delete_asset"));
  const got = (await api.call("import_asset", { url: "https://example.com/a.png" })) as { id: string };
  assert.match(got.id, /^[a-z0-9]{12}$/);
});

test("cli: upload sends files the way a browser does, in parts when large", async () => {
  const { cms, doFetch, pub } = setup();
  const { secret } = await cms.createKey(admin, { name: "cli", scopes: ["read", "write"] });
  const big = new Uint8Array(PART_SIZE * 2 + 500);
  big.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const files: Record<string, Uint8Array> = { "/tmp/shots/hero.png": png(1920, 1080, 900), "/tmp/talk.mp4": big };
  const lines: string[] = [];
  const io = { env: { AGENT_CMS_URL: "http://x/api/cms", AGENT_CMS_KEY: secret }, fetch: doFetch, readBytes: (p: string) => files[p], out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  assert.equal(await runCli(["upload", "/tmp/shots/hero.png", "/tmp/talk.mp4", "--folder", "launch", "--alt", "The launch screen", "--tag", "launch, 2026"], io), 0, lines.join("\n"));
  const out = JSON.parse(lines.join("\n")) as { id: string; name: string; size: number; markdown: string; url: string }[];
  assert.deepEqual(out.map((o) => [o.name, o.size]), [["hero.png", 900], ["talk.mp4", big.length]]);
  assert.equal(out[0].markdown, `![The launch screen](asset:${out[0].id}/hero.png)`);
  assert.equal(pub.objects.get("launch/talk.mp4")?.body.length, big.length);
  const hero = await cms.assets.get(admin, out[0].id);
  assert.deepEqual([hero.width, hero.height, hero.tags, hero.createdByKind], [1920, 1080, ["launch", "2026"], "key"]);
  // A refused file exits 1 and leaves nothing behind.
  lines.length = 0;
  files["/tmp/page.html"] = new TextEncoder().encode("<html>");
  assert.equal(await runCli(["upload", "/tmp/page.html"], io), 1);
  assert.match(lines.join("\n"), /asset_type_not_allowed/);
  const reader = await cms.createKey(admin, { name: "r", scopes: ["read"] });
  assert.equal(await runCli(["upload", "/tmp/shots/hero.png"], { ...io, env: { ...io.env, AGENT_CMS_KEY: reader.secret } }), 1);
});

test("cli: storage check tries every store and says what fails", async () => {
  const { media, doFetch } = setup();
  const lines: string[] = [];
  // Signed GET addresses of the in-memory storage: found = 200.
  const fetchAll = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const store = url.startsWith("memory://private/") ? media.stores.private.adapter : media.stores.public.adapter;
    const m = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("memory://") && m === "GET") {
      const key = decodeURIComponent(new URL(url).pathname.slice(1));
      return new Response(null, { status: !url.includes("?") ? 403 : (await store.head(key)) ? 200 : 404 });
    }
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: url.startsWith("memory://public/") ? { "access-control-allow-origin": "https://app.example.com" } : {} });
    if (url.startsWith("https://cdn.example.com/")) return new Response(null, { status: 200 });
    return doFetch(input, init);
  }) as typeof fetch;
  const io = { cwd: "/nowhere", media, fetch: fetchAll, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  assert.equal(await runCli(["storage", "check", "--origin", "https://app.example.com"], io), 1, "the private store's CORS rule is missing");
  const text = lines.join("\n");
  assert.match(text, /store "public" \(public\)\n\s+accepts: image\/jpeg, .*\n\s+largest file: 5GB/);
  assert.equal(text.match(/^ok {4}large files in parts/gm)?.length, 2);
  assert.match(text, /ok {4}public address \(https:\/\/cdn\.example\.com\/\)/);
  assert.match(text, /ok {4}files cannot be read without a link/);
  assert.match(text, /ok {4}browsers on https:\/\/app\.example\.com may upload \(CORS\)/);
  assert.match(text, /FAIL {2}browsers on https:\/\/app\.example\.com may upload \(CORS\): the bucket's CORS rule does not allow/);
  assert.match(text, /"AllowedMethods": \[\s+"GET",\s+"HEAD",\s+"PUT"/);
  assert.equal(media.stores.public.adapter.objects.size + media.stores.private.adapter.objects.size, 0, "the test files are removed");
  lines.length = 0;
  assert.equal(await runCli(["storage", "check"], { ...io, media: undefined }), 1);
  assert.match(lines.join("\n"), /no file stores/);
});
