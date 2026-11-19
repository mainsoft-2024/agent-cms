/** 0.8.0: the media library (storage rules, uploads, permissions, files in documents). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { parseMarkdown, parseInline, plainText, assetUses } from "./markdown";
import { imageSize, isPublicAddress } from "./net-guard";
import { MemoryRepo } from "./repo";
import { acceptsFile, cleanFolder, cleanName, contentMatches, DEFAULT_ACCEPT, declaredMatches, MemoryStorage, mimeOf, numberedName, PART_SIZE, sniff } from "./storage";
import { isCmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const member: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };

/** A PNG header that says `w`×`h`, padded to `size` bytes. */
function png(w = 640, h = 480, size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
const pdf = (size = 100) => {
  const b = new Uint8Array(size).fill(32);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  return b;
};
const code = (c: string) => (e: unknown) => isCmsError(e) && e.code === c;

function setup(extra: { accept?: string[]; maxFileSize?: number; requireAlt?: boolean } = {}) {
  const repo = new MemoryRepo();
  const pub = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  const priv = new MemoryStorage({ name: "private" });
  const blog = defineCollection({
    slug: "blog",
    label: "Blog",
    visibility: "public",
    fields: z.object({ cover: z.string().optional(), attachment: z.string().optional() }),
    admin: { fields: { cover: { widget: "image" }, attachment: { widget: "file", accept: [".pdf"], maxFileSize: 1000 } } },
    media: { requireAlt: extra.requireAlt },
  });
  const notes = defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin } });
  const fetched: string[] = [];
  const cms = createCms({
    repo,
    collections: [blog, notes],
    media: {
      stores: { public: { visibility: "public", adapter: pub, label: "Public" }, private: { visibility: "private", adapter: priv } },
      accept: extra.accept,
      maxFileSize: extra.maxFileSize,
      imageUrl: ({ url, width }) => `${url}?w=${width}`,
      resolveHost: async (host) => (host === "inside.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input);
        fetched.push(u);
        if (u.includes("/redirect-in")) return new Response(null, { status: 302, headers: { location: "https://inside.example.com/secret.png" } });
        if (u.includes("/big")) return new Response(new Uint8Array(60 * 1024 * 1024) as BodyInit, { headers: { "content-type": "image/png" } });
        if (u.includes("/page")) return new Response("<html><body>hi</body></html>", { headers: { "content-type": "image/png" } });
        return new Response(png(800, 600, 500) as BodyInit, { headers: { "content-type": "image/png" } });
      }) as typeof fetch,
    },
  });
  /** Upload through the same steps a browser takes. */
  const upload = async (actor: Actor, name: string, bytes: Uint8Array, o: { store?: string; folder?: string; mime?: string; alt?: string; tags?: string[] } = {}) => {
    const { asset, upload } = await cms.assets.requestUpload(actor, { name, size: bytes.length, mime: o.mime, ...o });
    assert.equal(upload.kind, "single");
    if (upload.kind === "single") assert.equal(await (o.store === "private" ? priv : pub).send(upload.url, bytes), 200);
    return cms.assets.completeUpload(actor, asset.id);
  };
  return { repo, cms, pub, priv, upload, fetched };
}

test("media: off without `media`; documents still work", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "g", label: "G", visibility: "public" })] });
  assert.equal(cms.assets.enabled, false);
  assert.equal(cms.assets.describe(admin), null);
  await assert.rejects(cms.assets.list(admin), code("media_disabled"));
  await assert.rejects(cms.assets.requestUpload(admin, { name: "a.png", size: 10 }), code("media_disabled"));
  await cms.create(admin, "g", { slug: "a", title: "A", body: "text" });
  // A body that names a file cannot be saved when there is no media library.
  await assert.rejects(cms.create(admin, "g", { slug: "b", title: "B", body: "![x](asset:aaaaaaaaaaaa/a.png)" }), code("asset_missing"));
});

test("media: an upload goes request → storage → complete, and only then is usable", async () => {
  const { cms, repo, pub, upload } = setup();
  const { asset, upload: how } = await cms.assets.requestUpload(admin, { name: "출시 화면.png", size: 200, mime: "image/png", folder: "blog/2026", tags: ["launch", "launch", " "] });
  assert.match(asset.id, /^[a-z0-9]{12}$/);
  assert.deepEqual([asset.status, asset.key, asset.folder, asset.kind, asset.tags], ["pending", "blog/2026/출시 화면.png", "blog/2026", "image", ["launch"]]);
  assert.equal((await cms.assets.list(admin)).assets.length, 0, "pending files are not listed");
  await assert.rejects(cms.assets.get(admin, asset.id), code("asset_not_found"));
  await assert.rejects(cms.assets.completeUpload(admin, asset.id), code("upload_incomplete"));
  assert.equal(how.kind, "single");
  if (how.kind === "single") await pub.send(how.url, png(640, 480, 200));
  const done = await cms.assets.completeUpload(admin, asset.id);
  assert.deepEqual([done.status, done.width, done.height, done.size], ["ready", 640, 480, 200], "the server reads the image size itself");
  assert.equal(done.publicUrl, "https://cdn.example.com/blog/2026/%EC%B6%9C%EC%8B%9C%20%ED%99%94%EB%A9%B4.png");
  assert.equal(done.href, `/api/cms/files/${asset.id}/${encodeURIComponent("출시 화면.png")}`);
  assert.equal((await cms.assets.completeUpload(admin, asset.id)).status, "ready", "completing twice is fine");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(repo.audit.filter((e) => e.action === "asset.upload").length, 1);

  // The same name again gets a number; nothing is overwritten.
  const second = await upload(admin, "출시 화면.png", png(), { folder: "blog/2026" });
  assert.equal(second.name, "출시 화면-2.png");
  await upload(admin, "guide.pdf", pdf(), { folder: "blog" });
  const all = await cms.assets.list(admin, { folder: "blog" });
  assert.deepEqual(all.assets.map((a) => a.name).sort(), ["guide.pdf", "출시 화면-2.png", "출시 화면.png"]);
  assert.deepEqual(all.counts, { all: 3, image: 2, video: 0, audio: 0, document: 1, other: 0 });
  assert.equal((await cms.assets.list(admin, { folder: "blog/2026" })).assets.length, 2);
  assert.equal((await cms.assets.list(admin, { kinds: ["document"] })).assets[0].name, "guide.pdf");
  assert.equal((await cms.assets.list(admin, { q: "GUIDE" })).assets.length, 1);
  assert.equal((await cms.assets.list(admin, { tag: "launch" })).assets.length, 1);
  const page1 = await cms.assets.list(admin, { limit: 2 });
  assert.equal(page1.assets.length, 2);
  assert.equal((await cms.assets.list(admin, { limit: 2, cursor: page1.cursor })).assets.length, 1);
  const tree = await cms.assets.folders(admin);
  assert.deepEqual(tree[0], { store: "public", label: "Public", visibility: "public", total: 3, folders: [{ path: "blog", count: 3 }, { path: "blog/2026", count: 2 }] });
});

test("media: what may be uploaded is the developer's choice at three levels, and the content is checked", async () => {
  const { cms, pub, upload } = setup();
  const req = (name: string, o: { mime?: string; size?: number; field?: { collection: string; path: string }; folder?: string } = {}) => cms.assets.requestUpload(admin, { name, size: o.size ?? 100, ...o });
  // The default list: no web pages, no programs.
  await assert.rejects(req("page.html"), code("asset_type_not_allowed"));
  await assert.rejects(req("setup.exe"), code("asset_type_not_allowed"));
  await assert.rejects(req("noext"), code("asset_type_not_allowed"));
  await assert.rejects(req("photo.png", { mime: "application/pdf" }), code("asset_type_mismatch"));
  await req("song.m4a", { mime: "audio/x-m4a" });
  await req("notes.md", { mime: "" });
  await assert.rejects(req("a.png", { folder: "_cms/thumbs" }), code("invalid_folder"));
  await assert.rejects(req("a.png", { size: 0 }), code("invalid"));
  // A field narrows its store's rule.
  await assert.rejects(req("a.pdf", { field: { collection: "blog", path: "cover" } }), code("asset_type_not_allowed"));
  await req("a.png", { field: { collection: "blog", path: "cover" } });
  await assert.rejects(req("a.png", { field: { collection: "blog", path: "attachment" } }), code("asset_type_not_allowed"));
  await assert.rejects(req("a.pdf", { size: 1001, field: { collection: "blog", path: "attachment" } }), (e) => isCmsError(e) && e.code === "asset_too_large" && e.status === 413 && e.params.max === "1000B");
  // What arrives is checked: a web page named .png is deleted again.
  const page = new TextEncoder().encode("<html><script>alert(1)</script>");
  const fake = await req("fake.png", { size: page.length });
  if (fake.upload.kind === "single") await pub.send(fake.upload.url, page);
  await assert.rejects(cms.assets.completeUpload(admin, fake.asset.id), code("asset_type_mismatch"));
  assert.equal(await pub.head("fake.png"), null);
  await assert.rejects(cms.assets.get(admin, fake.asset.id), code("asset_not_found"));
  // So is a different size than announced.
  const short = await req("short.png", { size: 500 });
  if (short.upload.kind === "single") await pub.send(short.upload.url, png(1, 1, 200));
  await assert.rejects(cms.assets.completeUpload(admin, short.asset.id), code("upload_incomplete"));
  assert.equal(await pub.head("short.png"), null);
  // Files that are not shown in the page are stored as downloads.
  await upload(admin, "data.zip", new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]));
  assert.match(pub.objects.get("data.zip")!.disposition ?? "", /^attachment/);
  assert.equal(pub.objects.get("short.png"), undefined);

  // App-wide and store-level settings.
  const open = setup({ accept: ["*/*"], maxFileSize: 50 });
  await open.cms.assets.requestUpload(admin, { name: "page.html", size: 10 });
  await assert.rejects(open.cms.assets.requestUpload(admin, { name: "a.png", size: 51 }), code("asset_too_large"));
  const narrow = setup({ accept: ["image/*", ".pdf"] });
  await narrow.cms.assets.requestUpload(admin, { name: "a.pdf", size: 10 });
  await assert.rejects(narrow.cms.assets.requestUpload(admin, { name: "a.zip", size: 10 }), code("asset_type_not_allowed"));
  assert.deepEqual(narrow.cms.assets.describe(admin)?.stores[0].accept, ["image/*", ".pdf"]);
});

test("media: a large file goes up in parts; a missing part is named, then the upload completes", async () => {
  const { cms, pub } = setup();
  const size = PART_SIZE + 1000;
  const { asset, upload } = await cms.assets.requestUpload(admin, { name: "talk.mp4", size });
  assert.deepEqual(upload, { kind: "multipart", partSize: PART_SIZE, partCount: 2 });
  const urls = await cms.assets.partUrls(admin, asset.id, [1, 2, 3, 2]);
  assert.deepEqual(urls.map((u) => u.partNumber), [1, 2], "only parts the file has");
  const first = new Uint8Array(PART_SIZE);
  first.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]); // ....ftyp
  await pub.send(urls[0].url, first);
  await assert.rejects(cms.assets.completeUpload(admin, asset.id), (e) => isCmsError(e) && e.code === "upload_incomplete" && e.params.missing === "2");
  assert.deepEqual((await cms.assets.uploadStatus(admin, asset.id)).done, [1], "what to send after a broken connection");
  await pub.send(urls[1].url, new Uint8Array(1000));
  const done = await cms.assets.completeUpload(admin, asset.id, { width: 1920, height: 1080, duration: 12.5 });
  assert.deepEqual([done.status, done.kind, done.size, done.width, done.duration], ["ready", "video", size, 1920, 12.5]);
  // An abandoned upload is cleaned up after a day.
  const stale = await cms.assets.requestUpload(admin, { name: "left.mp4", size });
  assert.equal((await cms.assets.cleanup()).removed, 0);
  assert.equal((await cms.assets.cleanup({ olderThanMs: -1000 })).removed, 1);
  assert.equal(pub.uploads.size, 0);
  await assert.rejects(cms.assets.uploadStatus(admin, stale.asset.id), code("asset_not_found"));
});

test("media: who may do what, by default and with a store's own rule", async () => {
  const { cms, upload } = setup();
  const a = await upload(admin, "a.png", png());
  const secret = await upload(admin, "contract.pdf", pdf(), { store: "private" });
  const key = async (scopes: ("read" | "write" | "publish")[]) => (await cms.authenticateKey((await cms.createKey(admin, { name: scopes.join("+"), scopes })).secret))!;
  const reader = await key(["read"]);
  const writer = await key(["read", "write"]);
  const publisher = await key(["read", "write", "publish"]);

  await assert.rejects(cms.assets.list(anon), code("unauthorized"));
  for (const who of [member, reader, writer]) assert.equal((await cms.assets.list(who)).assets.length, 1);
  for (const who of [member, reader]) {
    await assert.rejects(cms.assets.requestUpload(who, { name: "b.png", size: 10 }), code("forbidden_media"));
    await assert.rejects(cms.assets.update(who, a.id, { alt: "x" }), code("forbidden_media"));
  }
  assert.equal((await cms.assets.update(writer, a.id, { alt: "A chart", tags: ["q3"] })).alt, "A chart");
  await assert.rejects(cms.assets.move(writer, a.id, { folder: "x" }), code("forbidden_media"));
  await assert.rejects(cms.assets.remove(writer, a.id), code("forbidden_media"));
  assert.equal((await cms.assets.move(publisher, a.id, { folder: "brand" })).key, "brand/a.png");
  assert.deepEqual(cms.assets.describe(writer)?.stores.map((s) => [s.name, s.can.write, s.can.delete]), [["public", true, false], ["private", true, false]]);
  assert.equal(cms.assets.describe(anon), null);

  // Public files open for anyone; private ones only for signed-in people and keys, with a short-lived link.
  assert.equal((await cms.assets.open(anon, a.id)).url, "https://cdn.example.com/brand/a.png");
  await assert.rejects(cms.assets.open(anon, secret.id), code("unauthorized"));
  const link = await cms.assets.open(member, secret.id);
  assert.match(link.url, /^memory:\/\/private\/contract\.pdf\?expires=300$/);
  assert.match((await cms.assets.open(reader, secret.id, { download: true })).url, /download=contract\.pdf/);

  // A store's own rule replaces the default.
  const repo = new MemoryRepo();
  const own = createCms({ repo, collections: [], media: { linkTtlSeconds: 60, stores: { team: { visibility: "private", adapter: new MemoryStorage(), access: { read: ({ actor }) => actor.kind === "user" && actor.isAdmin, write: ({ actor }) => actor.kind === "user" } } } } });
  const up = await own.assets.requestUpload(member, { name: "a.png", size: 10 });
  assert.equal(up.asset.status, "pending");
  await assert.rejects(own.assets.list(member), code("forbidden_media"));
  assert.equal((await own.assets.list(admin)).assets.length, 0);
});

test("media: edit, move, rename and delete; a file in use says where before it goes", async () => {
  const { cms, repo, pub, upload } = setup();
  const hero = await upload(admin, "hero.png", png(), { folder: "blog", alt: "Launch screen" });
  await cms.create(admin, "blog", { slug: "launch", title: "Launch", body: `Intro\n\n![](asset:${hero.id}/hero.png "The new screen")\n`, fields: { cover: hero.id } }, { publish: true });
  await cms.create(admin, "notes", { slug: "secret", title: "Secret", body: `[file](asset:${hero.id}/hero.png)` });
  assert.deepEqual(repo.assetRefs.map((r) => [r.inDraft, r.inPublished]), [[true, true], [true, false]]);

  // Moving and renaming never breaks a document: it points at the id.
  const moved = await cms.assets.move(admin, hero.id, { folder: "brand/2026", name: "launch-hero" });
  assert.deepEqual([moved.key, moved.name], ["brand/2026/launch-hero.png", "launch-hero.png"], "a rename keeps the extension");
  assert.equal(await pub.head("blog/hero.png"), null);
  assert.ok(await pub.head("brand/2026/launch-hero.png"));
  const files = await cms.assetsFor(await cms.get(anon, "blog", "launch"));
  assert.deepEqual(files[hero.id], { id: hero.id, name: "launch-hero.png", kind: "image", mime: "image/png", size: 200, width: 640, height: 480, duration: null, alt: "Launch screen", url: "https://cdn.example.com/brand/2026/launch-hero.png", visibility: "public" });
  assert.equal(cms.imageUrl(files[hero.id], { width: 800 }), "https://cdn.example.com/brand/2026/launch-hero.png?w=800");

  // The member cannot read `notes`, so that use is counted but not named.
  const seen = await cms.assets.get(member, hero.id);
  assert.deepEqual([seen.usage.map((u) => u.slug), seen.usageHidden], [["launch"], 1]);
  const full = await cms.assets.get(admin, hero.id);
  assert.deepEqual(full.usage.map((u) => [u.collection, u.slug, u.status, u.inPublished]).sort(), [["blog", "launch", "published", true], ["notes", "secret", "draft", false]]);
  await assert.rejects(cms.assets.remove(admin, hero.id), (e) => isCmsError(e) && e.code === "asset_in_use" && e.status === 409 && e.params.count === 2 && (e.current as { documents: unknown[] }).documents.length === 2);
  assert.ok(await cms.assets.get(admin, hero.id), "still there");

  // Unpublishing and editing update where it is used.
  await cms.unpublish(admin, "blog", "launch");
  assert.equal((await cms.assets.get(admin, hero.id)).usage.find((u) => u.slug === "launch")?.inPublished, false);
  await cms.update(admin, "blog", "launch", { body: "No picture", fields: { cover: null } });
  assert.deepEqual((await cms.assets.get(admin, hero.id)).usage.map((u) => u.slug), ["secret"]);

  await cms.assets.remove(admin, hero.id, { confirm: true });
  assert.equal(await pub.head("brand/2026/launch-hero.png"), null);
  await assert.rejects(cms.assets.get(admin, hero.id), code("asset_not_found"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(repo.audit.filter((e) => e.action.startsWith("asset.")).map((e) => e.action), ["asset.upload", "asset.move", "asset.delete"]);
  // The document that still names it can be edited; the problem shows as a warning.
  await cms.update(admin, "notes", "secret", { title: "Still editable" });
  const diags = await cms.diagnose(admin, "notes", {}, { slug: "secret" });
  assert.deepEqual(diags.map((d) => [d.code, d.severity]), [["asset_missing", "warning"]]);
});

test("media: files in documents are checked (missing, wrong kind, alt text, private in public)", async () => {
  const { cms, upload } = setup();
  const img = await upload(admin, "chart.png", png());
  const doc = await upload(admin, "terms.pdf", pdf(500));
  const big = await upload(admin, "big.pdf", pdf(2000));
  const hidden = await upload(admin, "internal.png", png(), { store: "private", alt: "Internal" });
  const diag = async (input: Parameters<typeof cms.diagnose>[2]) => (await cms.diagnose(admin, "blog", { slug: "d", title: "D", ...input })).map((d) => `${d.path} ${d.code} ${d.severity}`);

  assert.deepEqual(await diag({ body: `text\n\n![](asset:${img.id}/chart.png)\n\n![A chart](asset:${img.id}/chart.png)` }), ["body asset_alt_missing warning"]);
  assert.deepEqual((await cms.diagnose(admin, "blog", { slug: "d", title: "D", body: `a\nb\n![](asset:${img.id}/x.png)` }))[0].params, { line: 3, id: img.id });
  assert.deepEqual(await diag({ body: "![](https://example.com/a.png)" }), ["body asset_alt_missing warning"]);
  assert.deepEqual(await diag({ body: "![x](asset:zzzzzzzzzzzz/a.png)" }), ["body asset_missing error"]);
  assert.deepEqual(await diag({ body: `[Terms](asset:${doc.id}/terms.pdf)` }), []);
  assert.deepEqual(await diag({ body: `![Internal](asset:${hidden.id}/internal.png)` }), ["body asset_private_in_public warning"]);
  assert.deepEqual(await diag({ fields: { cover: doc.id } }), ["fields.cover asset_wrong_kind error"]);
  assert.deepEqual(await diag({ fields: { cover: img.id } }), ["fields.cover asset_alt_empty warning"]);
  assert.deepEqual(await diag({ fields: { attachment: img.id } }), ["fields.attachment asset_wrong_kind error"]);
  assert.deepEqual(await diag({ fields: { attachment: big.id } }), ["fields.attachment asset_too_large error"]);
  assert.deepEqual(await diag({ fields: { attachment: doc.id } }), []);
  // Errors stop a save; warnings do not.
  await assert.rejects(cms.create(admin, "blog", { slug: "x", title: "X", fields: { cover: doc.id } }), code("asset_wrong_kind"));
  await cms.create(admin, "blog", { slug: "x", title: "X", body: `![](asset:${img.id}/chart.png)` });
  await assert.rejects(cms.update(admin, "blog", "x", { body: "![a](asset:zzzzzzzzzzzz/a.png)" }), code("asset_missing"));
  const dry = await cms.patch(admin, "blog", "x", [{ op: "append", markdown: "![](asset:yyyyyyyyyyyy/a.png)" }], { dryRun: true });
  assert.ok(dry.diagnostics.some((d) => d.code === "asset_missing" && d.severity === "error"));
  // A collection can make alt text required.
  const strict = setup({ requireAlt: true });
  const pic = await strict.upload(admin, "p.png", png());
  await assert.rejects(strict.cms.create(admin, "blog", { slug: "x", title: "X", body: `![](asset:${pic.id}/p.png)` }), code("asset_alt_missing"));
  await strict.cms.assets.update(admin, pic.id, { alt: "A picture" });
  await strict.cms.create(admin, "blog", { slug: "x", title: "X", body: `![](asset:${pic.id}/p.png)` });
});

test("media: folders, thumbnails, server-side put", async () => {
  const { cms, pub } = setup();
  assert.deepEqual(await cms.assets.createFolder(admin, { path: "/guide//2026/" }), { store: "public", path: "guide/2026" });
  await cms.assets.createFolder(admin, { path: "guide/2026" });
  assert.ok(await pub.head("guide/2026/"), "an empty folder is a marker object");
  const a = await cms.assets.put(admin, { name: "a.png", bytes: png(30, 40), folder: "guide/2026" });
  assert.deepEqual([a.width, a.height, a.status], [30, 40, "ready"]);
  assert.deepEqual((await cms.assets.folders(admin))[0].folders, [{ path: "guide", count: 1 }, { path: "guide/2026", count: 1 }]);
  assert.equal((await cms.assets.list(admin)).assets.length, 1, "folders are not files");
  await assert.rejects(cms.assets.deleteFolder(admin, { path: "guide/2026" }), code("folder_not_empty"));
  await assert.rejects(cms.assets.createFolder(admin, { path: "_cms/x" }), code("invalid_folder"));
  await assert.rejects(cms.assets.put(admin, { name: "a.png", bytes: pdf() }), code("asset_type_mismatch"));

  const thumbed = await cms.assets.setThumb(admin, a.id, png(48, 48, 300));
  assert.equal(thumbed.thumbHref, `${a.href}?thumb=1`);
  assert.ok(await pub.head(`_cms/thumbs/${a.id}.png`));
  assert.equal((await cms.assets.open(anon, a.id, { thumb: true })).url, `https://cdn.example.com/_cms/thumbs/${a.id}.png`);
  await assert.rejects(cms.assets.setThumb(admin, a.id, pdf()), code("asset_type_not_allowed"));
  await cms.assets.remove(admin, a.id);
  assert.equal(await pub.head(`_cms/thumbs/${a.id}.png`), null, "the thumbnail goes with the file");
  await cms.assets.deleteFolder(admin, { path: "guide/2026" });
  assert.equal(await pub.head("guide/2026/"), null);
});

test("media: importing by URL never reaches inside the network", async () => {
  const { cms, fetched } = setup();
  const got = await cms.assets.import(admin, { url: "https://example.com/pics/Team%20photo.png?x=1", folder: "blog", alt: "The team" });
  assert.deepEqual([got.name, got.folder, got.width, got.alt], ["Team photo.png", "blog", 800, "The team"]);
  for (const url of ["http://example.com/a.png", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://169.254.169.254/latest/meta-data", "https://inside.example.com/a.png", "https://user:pw@example.com/a.png", "file:///etc/passwd", "nope"]) {
    await assert.rejects(cms.assets.import(admin, { url }), code("import_blocked"), url);
  }
  assert.equal(fetched.length, 1, "blocked addresses are never requested");
  await assert.rejects(cms.assets.import(admin, { url: "https://example.com/redirect-in" }), code("import_blocked"));
  assert.ok(!fetched.some((u) => u.includes("inside.example.com")));
  await assert.rejects(cms.assets.import(admin, { url: "https://example.com/big.png" }), code("asset_too_large"));
  await assert.rejects(cms.assets.import(admin, { url: "https://example.com/page.png" }), code("asset_type_mismatch"));
  await assert.rejects(cms.assets.import(member, { url: "https://example.com/a.png" }), code("forbidden_media"));
  for (const [ip, ok] of [["8.8.8.8", true], ["10.1.2.3", false], ["172.16.0.1", false], ["172.32.0.1", true], ["192.168.1.1", false], ["100.64.0.1", false], ["0.0.0.0", false], ["::ffff:10.0.0.1", false], ["fd00::1", false], ["fe80::1", false], ["2606:4700::1111", true]] as const) {
    assert.equal(isPublicAddress(ip), ok, ip);
  }
});

test("markdown: files from the media library, by id", () => {
  const blocks = parseMarkdown('Intro ![icon](asset:aaaaaaaaaaaa/i.png) and [the PDF](asset:bbbbbbbbbbbb/guide%20v2.pdf).\n\n![Launch](asset:cccccccccccc/launch-hero.jpg "The new screen")\n\n![Elsewhere](https://example.com/a.png)\n\n![no](http://example.com/a.png)\n\n![bad](javascript:alert(1))');
  assert.deepEqual(blocks[0], { t: "p", inline: [{ t: "text", v: "Intro " }, { t: "image", asset: "aaaaaaaaaaaa", name: "i.png", src: null, alt: "icon", v: "icon" }, { t: "text", v: " and " }, { t: "file", asset: "bbbbbbbbbbbb", name: "guide v2.pdf", v: "the PDF" }, { t: "text", v: "." }] });
  assert.deepEqual(blocks[1], { t: "media", asset: "cccccccccccc", name: "launch-hero.jpg", src: null, alt: "Launch", caption: "The new screen" });
  assert.deepEqual(blocks[2], { t: "media", asset: null, name: "", src: "https://example.com/a.png", alt: "Elsewhere", caption: "" });
  // Only https for outside images; anything else is plain text.
  assert.deepEqual(blocks[3], { t: "p", inline: [{ t: "text", v: "no" }] });
  assert.deepEqual(blocks[4], { t: "p", inline: [{ t: "text", v: "bad" }] });
  assert.deepEqual(parseInline("[a](/x) **b** `c` [[link:k|L]]").map((i) => i.t), ["link", "text", "strong", "text", "code", "text", "applink"], "the old syntax is unchanged");
  assert.equal(plainText('Before\n\n![Launch screen](asset:cccccccccccc/a.jpg "A caption")\n\nAfter [doc](asset:bbbbbbbbbbbb/a.pdf)'), "Before\n\n Launch screen A caption \n\nAfter doc");
  assert.deepEqual(assetUses("![a](asset:aaaaaaaaaaaa/a.png)\n```\n![x](asset:xxxxxxxxxxxx/a.png)\n```\ntext ![](asset:bbbbbbbbbbbb) [f](asset:cccccccccccc/f.pdf)"), [
    { id: "aaaaaaaaaaaa", as: "media", alt: "a", line: 1 },
    { id: "bbbbbbbbbbbb", as: "image", alt: "", line: 5 },
    { id: "cccccccccccc", as: "file", alt: "", line: 5 },
  ]);
});

test("storage: names, types and what the bytes say", () => {
  assert.equal(cleanName("../../etc/passwd"), "etcpasswd");
  assert.equal(cleanName("  .hidden\u0000 파일.PNG "), "hidden 파일.PNG");
  assert.equal(cleanName(""), "file");
  assert.equal(cleanName(`${"가".repeat(300)}.png`).length, 200);
  assert.ok(cleanName(`${"가".repeat(300)}.png`).endsWith(".png"));
  assert.equal(cleanFolder("/a//b/../c/"), "a/b/c");
  assert.equal(cleanFolder(""), "");
  assert.equal(cleanFolder("_cms/thumbs"), null);
  assert.equal(numberedName("a.tar.gz", 3), "a.tar-3.gz");
  assert.equal(numberedName("noext", 2), "noext-2");
  assert.equal(mimeOf("a.PNG", "text/html"), "image/png", "a known extension decides");
  assert.equal(mimeOf("a.xyz", "Application/X-Thing; charset=x"), "application/x-thing");
  assert.equal(mimeOf("a.xyz", "not a type"), "application/octet-stream");
  assert.ok(declaredMatches("a.docx", "application/msword") && declaredMatches("a.zip", "application/x-zip-compressed") && declaredMatches("a.csv", "application/vnd.ms-excel"));
  assert.ok(!declaredMatches("a.png", "text/html") && !declaredMatches("a.pdf", "application/zip"));
  assert.ok(acceptsFile(["image/*"], { name: "a.png", mime: "image/png" }) && acceptsFile([".PDF"], { name: "a.pdf", mime: "application/pdf" }) && acceptsFile(["*/*"], { name: "a.exe", mime: "x/y" }));
  assert.ok(!acceptsFile(["image/*"], { name: "a.pdf", mime: "application/pdf" }) && !acceptsFile([], { name: "a.png", mime: "image/png" }));
  assert.ok(!DEFAULT_ACCEPT.includes("text/html"));
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(sniff(bytes("MZ\u0090")), "program");
  assert.equal(sniff(bytes("#!/bin/sh\nrm -rf /")), "program");
  assert.equal(sniff(bytes("\uFEFF  <!DOCTYPE html><html>")), "html");
  assert.equal(sniff(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">')), "svg");
  assert.equal(sniff(bytes("name,price\na,1")), "text");
  assert.equal(sniff(new Uint8Array([1, 0, 2, 0])), null);
  assert.ok(contentMatches("image/svg+xml", bytes("<svg viewBox='0 0 1 1'></svg>")) && !contentMatches("image/svg+xml", bytes("<html>")));
  assert.ok(contentMatches("text/csv", bytes("a,b")) && !contentMatches("text/plain", bytes("<script>alert(1)</script>")));
  assert.ok(!contentMatches("application/x-unknown", bytes("MZ")) && contentMatches("application/x-unknown", new Uint8Array([1, 0, 2])));
  assert.ok(contentMatches("application/zip", new Uint8Array([0x50, 0x4b, 3, 4])) && !contentMatches("image/png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])));
  assert.deepEqual(imageSize(png(1200, 630)), { width: 1200, height: 630 });
  assert.deepEqual(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02])), { width: 800, height: 600 });
  assert.deepEqual(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0])), { width: 640, height: 480 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});
