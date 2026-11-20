/** 0.11.0: image sizes (`./image-sharp`), focal point, replacing a file at the same address, camera data. */

import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { z } from "zod";
import type { ImageTransforms } from "./assets";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { sharpTransforms } from "./image-sharp";
import { MemoryRepo } from "./repo";
import { DERIVED_PREFIX, MemoryStorage, stripJpegMetadata } from "./storage";
import { isCmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const anon: Actor = { kind: "anonymous" };
const writer: Actor = { kind: "key", id: "k1", label: "bot", scopes: ["write"], collections: null };
const code = (c: string) => (e: unknown) => isCmsError(e) && e.code === c;

/** A picture whose left half is red and right half blue: a crop tells which side it kept. */
async function halves(w: number, h: number, format: "png" | "jpeg" = "png"): Promise<Uint8Array> {
  const half = { create: { width: w / 2, height: h, channels: 3 as const, background: "#ff0000" } };
  const left = await sharp(half).png().toBuffer();
  const img = sharp({ create: { width: w, height: h, channels: 3, background: "#0000ff" } }).composite([{ input: left, left: 0, top: 0 }]);
  return new Uint8Array(await (format === "png" ? img.png() : img.jpeg()).toBuffer());
}
const redAt = async (bytes: Uint8Array, x: number, y: number) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return data[i] > 200 && data[i + 2] < 60;
};

function setup(o: { transforms?: ImageTransforms; stripMetadata?: boolean; trashDays?: number } = {}) {
  const pub = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  const priv = new MemoryStorage({ name: "private" });
  const calls: string[] = [];
  const real = o.transforms ?? sharpTransforms({ presets: { thumb: { width: 480 }, card: { width: 800, height: 450, fit: "cover" }, full: { width: 1600 }, tall: { width: 200, height: 400, fit: "cover", format: "jpeg", quality: 70 } } });
  // The same object, so a test can change its settings later.
  const make = real.make.bind(real);
  const transforms: ImageTransforms = Object.assign(real, { make: (b: Uint8Array, job: Parameters<ImageTransforms["make"]>[1]) => (calls.push(`${job.width}x${job.height}:${job.fit}:${job.format}`), make(b, job)) });
  const warnings: string[] = [];
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [defineCollection({ slug: "blog", label: "Blog", visibility: "public", fields: z.object({ cover: z.string().optional() }), admin: { fields: { cover: { widget: "image" } } } })],
    trash: { days: o.trashDays ?? 0 },
    warn: (m) => warnings.push(m),
    media: { stores: { public: { visibility: "public", adapter: pub }, private: { visibility: "private", adapter: priv } }, transforms, stripMetadata: o.stripMetadata, imageUrl: ({ url, width }) => `${url}?w=${width}` },
  });
  return { cms, pub, priv, calls, warnings };
}
const derived = (s: MemoryStorage) => [...s.objects.keys()].filter((k) => k.startsWith(DERIVED_PREFIX));

test("sizes: made on first request, kept in the store, only the named ones", async () => {
  const { cms, pub, calls } = setup();
  const a = await cms.assets.put(admin, { name: "hero.png", bytes: await halves(1600, 1200), folder: "blog" });
  // A server-made list picture: nobody's browser saw this file.
  assert.equal(a.thumbKey, `_cms/thumbs/${a.id}.webp`);
  assert.deepEqual(calls, ["480x480:inside:webp"]);
  const thumb = await sharp(pub.objects.get(a.thumbKey!)!.body).metadata();
  assert.deepEqual([thumb.format, thumb.width, thumb.height], ["webp", 480, 360]);

  const card = await cms.assets.open(anon, a.id, { size: "card" });
  assert.match(card.url, new RegExp(`^https://cdn\\.example\\.com/_cms/derived/${a.id}/card-[a-z0-9]+\\.webp$`));
  const key = card.url.replace("https://cdn.example.com/", "");
  const made = await sharp(pub.objects.get(key)!.body).metadata();
  assert.deepEqual([made.format, made.width, made.height], ["webp", 800, 450]);
  assert.equal(pub.objects.get(key)!.cacheControl, "public, max-age=31536000, immutable");
  // Again: the same address, and nothing is made twice (also when two ask at once).
  const [again, twice] = await Promise.all([cms.assets.open(anon, a.id, { size: "card" }), cms.assets.open(anon, a.id, { size: "card" })]);
  assert.deepEqual([again.url, twice.url], [card.url, card.url]);
  assert.equal(calls.length, 2);

  // Never enlarged; a size's own format and quality.
  const full = await cms.assets.open(anon, a.id, { size: "full" });
  const fullMeta = await sharp(pub.objects.get(full.url.replace("https://cdn.example.com/", ""))!.body).metadata();
  assert.deepEqual([fullMeta.width, fullMeta.height], [1600, 1200]);
  const tall = await cms.assets.open(anon, a.id, { size: "tall" });
  assert.match(tall.url, /tall-[a-z0-9]+\.jpg$/);

  // A name that is not a size is not found; without the module no name is.
  await assert.rejects(cms.assets.open(anon, a.id, { size: "huge" }), code("unknown_image_size"));
  await assert.rejects(cms.assets.open(anon, a.id, { size: "1600" }), code("unknown_image_size"));

  // Pages: an address per size, the width hook as before, plain addresses for what cannot be resized.
  const info = (await cms.assetsFor({ collection: "blog", body: `![x](asset:${a.id}/hero.png)`, fields: {} }))[a.id];
  assert.equal(cms.imageUrl(info, { size: "card" }), `/api/cms/files/${a.id}/hero.png?size=card`);
  assert.equal(cms.imageUrl(info, { size: "nope" }), info.url);
  assert.equal(cms.imageUrl(info, { width: 640 }), `${info.url}?w=640`);
  const svg = await cms.assets.put(admin, { name: "logo.svg", bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') });
  assert.equal(svg.thumbKey, null);
  assert.equal((await cms.assets.open(anon, svg.id, { size: "card" })).url, "https://cdn.example.com/logo.svg");
  assert.equal(cms.assets.describe(admin)!.sizes.join(), "thumb,card,full,tall");

  // Deleting the file takes its sizes along.
  assert.equal(derived(pub).length, 3);
  await cms.assets.remove(admin, a.id);
  assert.deepEqual(derived(pub), []);
});

test("focal point: cover sizes are cut around it, and a new point makes new copies", async () => {
  const { cms, pub } = setup();
  const a = await cms.assets.put(admin, { name: "wide.png", bytes: await halves(1600, 400) });
  const cut = async () => pub.objects.get((await cms.assets.open(anon, a.id, { size: "tall" })).url.replace("https://cdn.example.com/", ""))!.body;
  // No point: the middle. The copy is 200×400 out of a 1600×400 picture, so it straddles the border.
  const middle = await cut();
  assert.deepEqual([await redAt(middle, 10, 200), await redAt(middle, 190, 200)], [true, false]);

  const left = await cms.assets.update(admin, a.id, { focal: { x: 0.1, y: 0.5 } });
  assert.deepEqual([left.focalX, left.focalY], [0.1, 0.5]);
  assert.deepEqual(derived(pub), [], "copies cut around the old point are gone");
  const l = await cut();
  assert.deepEqual([await redAt(l, 10, 200), await redAt(l, 190, 200)], [true, true]);
  await cms.assets.update(admin, a.id, { focal: { x: 2, y: -1 } });
  const r = await cut();
  assert.deepEqual([await redAt(r, 10, 200), await redAt(r, 190, 200)], [false, false], "a point outside is pulled to the edge");
  assert.deepEqual((await cms.assets.get(admin, a.id)).focalX, 1);

  // Pages get the point; clearing it works; alt edits leave it alone.
  const info = async () => (await cms.assetsFor({ collection: "blog", body: "", fields: { cover: a.id } }))[a.id];
  assert.deepEqual((await info()).focal, { x: 1, y: 0 });
  await cms.assets.update(admin, a.id, { alt: "A wide picture" });
  assert.deepEqual((await info()).focal, { x: 1, y: 0 });
  await cms.assets.update(admin, a.id, { focal: null });
  assert.equal((await info()).focal, null);
  // Only people who may edit the file.
  await assert.rejects(cms.assets.update({ kind: "user", id: "u2", label: "Lee", isAdmin: false }, a.id, { focal: { x: 0, y: 0 } }), code("forbidden_media"));
});

test("sizes: slow or failing work falls back to the original; no more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  let fail = false;
  const slow: ImageTransforms = {
    presets: { a: { width: 10 }, b: { width: 20 }, c: { width: 30 } },
    format: "webp",
    concurrency: 2,
    timeoutMs: 60,
    async make(bytes) {
      if (fail) throw new Error("boom");
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 25));
      running--;
      return { bytes: bytes.subarray(0, 8), width: 1, height: 1 };
    },
  };
  const { cms, pub, warnings } = setup({ transforms: slow });
  const a = await cms.assets.put(admin, { name: "a.png", bytes: await halves(64, 64) });
  peak = 0;
  const urls = await Promise.all(["a", "b", "c"].map((size) => cms.assets.open(anon, a.id, { size }).then((r) => r.url)));
  assert.equal(peak, 2);
  assert.ok(urls.every((u) => u.includes("/_cms/derived/")));

  // Too slow: the caller gets the original now; the copy is there for the next one.
  slow.timeoutMs = 5;
  const b = await cms.assets.put(admin, { name: "b.png", bytes: await halves(64, 64) });
  assert.equal((await cms.assets.open(anon, b.id, { size: "a" })).url, "https://cdn.example.com/b.png");
  await new Promise((r) => setTimeout(r, 60));
  assert.match((await cms.assets.open(anon, b.id, { size: "a" })).url, /_cms\/derived/);

  // Failing: the original, and the app hears about it once.
  fail = true;
  assert.equal((await cms.assets.open(anon, b.id, { size: "b" })).url, "https://cdn.example.com/b.png");
  assert.ok(warnings.some((w) => w.includes('could not make size "b"') && w.includes("boom")));
  assert.equal(derived(pub).filter((k) => k.includes(`/${b.id}/b-`)).length, 0);
});

test("sharpTransforms: says what is wrong with a setting", () => {
  assert.throws(() => sharpTransforms({ presets: { big: { width: 5000 } } }), /from 1 to 4096/);
  assert.throws(() => sharpTransforms({ presets: { "Bad Name": { width: 10 } } }), /not a size name/);
  assert.throws(() => sharpTransforms({ presets: { x: {} } }), /needs a width or a height/);
  assert.throws(() => sharpTransforms({ presets: { x: { width: 10, fit: "cover" } } }), /needs both/);
  assert.throws(() => sharpTransforms({ presets: { x: { width: 10 } }, formats: ["bmp" as never] }), /unknown format/);
  const edge = globalThis as { EdgeRuntime?: string };
  edge.EdgeRuntime = "edge-runtime";
  try {
    assert.throws(() => sharpTransforms({ presets: { x: { width: 10 } } }), /needs the Node\.js runtime/);
  } finally {
    delete edge.EdgeRuntime;
  }
});

test("replace: same id and address, new content; what was made from the old content goes", async () => {
  const { cms, pub } = setup();
  const first = await halves(1600, 1200);
  const a = await cms.assets.put(admin, { name: "hero.png", bytes: first, folder: "blog", alt: "Hero" });
  await cms.create(admin, "blog", { slug: "post", title: "Post", body: `![Hero](asset:${a.id}/hero.png)` });
  const before = (await cms.assets.open(anon, a.id, { size: "card" })).url;
  assert.equal((await cms.assets.open(anon, a.id)).url, "https://cdn.example.com/blog/hero.png");

  // The browser's way: ask, send to the signed address, complete.
  const next = await halves(800, 800);
  const r = await cms.assets.requestUpload(admin, { name: "new-hero.PNG", mime: "image/png", size: next.length, replace: a.id });
  assert.equal(r.upload.kind, "single");
  assert.notEqual(r.asset.id, a.id);
  assert.match(r.asset.key, new RegExp(`^_cms/replace/${a.id}/[a-z0-9]+\\.png$`));
  assert.equal((await cms.assets.list(admin, {})).assets.length, 1, "the waiting content is not a file of the library");
  if (r.upload.kind === "single") await pub.send(r.upload.url, next);
  const done = await cms.assets.completeUpload(admin, r.asset.id, { width: 800, height: 800 });
  assert.deepEqual([done.id, done.key, done.name, done.alt, done.size, done.width, done.height, done.rev, done.thumbKey], [a.id, "blog/hero.png", "hero.png", "Hero", next.length, 800, 800, 1, null]);
  assert.deepEqual(pub.objects.get("blog/hero.png")!.body, next);
  assert.deepEqual([...pub.objects.keys()].filter((k) => k.startsWith("_cms/")), [], "the waiting copy, the old list picture and the old sizes are gone");
  await assert.rejects(cms.assets.uploadStatus(admin, r.asset.id), code("asset_not_found"));
  // Addresses tell caches the content changed; documents did not.
  assert.equal(done.publicUrl, "https://cdn.example.com/blog/hero.png?v=1");
  assert.equal((await cms.assets.open(anon, a.id)).url, "https://cdn.example.com/blog/hero.png?v=1");
  const after = (await cms.assets.open(anon, a.id, { size: "card" })).url;
  assert.notEqual(after, before);
  assert.equal((await cms.assetsFor((await cms.get(admin, "blog", "post", { draft: true }))!))[a.id].url, "https://cdn.example.com/blog/hero.png?v=1");
  assert.equal((await cms.get(admin, "blog", "post", { draft: true }))!.version, 1);
  const log = (await cms.audit(admin, { action: "asset.replace" })).entries;
  assert.deepEqual([log.length, log[0].detail?.id, log[0].detail?.was], [1, a.id, first.length]);

  // The server's way (scripts): bytes in hand. The list picture is made again.
  const third = await halves(400, 400);
  const again = await cms.assets.replace(admin, a.id, { bytes: third });
  assert.deepEqual([again.id, again.rev, again.width, again.thumbKey], [a.id, 2, 400, `_cms/thumbs/${a.id}.webp`]);

  // Another kind of file cannot take an address that ends in .png.
  await assert.rejects(cms.assets.requestUpload(admin, { name: "photo.jpg", mime: "image/jpeg", size: 100, replace: a.id }), code("asset_replace_type"));
  await assert.rejects(cms.assets.replace(admin, a.id, { bytes: new TextEncoder().encode("%PDF-1.7 not a picture") }), code("asset_type_mismatch"));
  // Replacing changes what published pages show: the permission of moving and deleting.
  await assert.rejects(cms.assets.requestUpload(writer, { name: "x.png", mime: "image/png", size: 100, replace: a.id }), code("forbidden_media"));
  await assert.rejects(cms.assets.requestUpload(admin, { name: "x.png", mime: "image/png", size: 100, replace: "nosuchfile000" }), code("asset_not_found"));
  // Content that is not what it says: the file stays as it was.
  const bad = await cms.assets.requestUpload(admin, { name: "x.png", mime: "image/png", size: 30, replace: a.id });
  if (bad.upload.kind === "single") await pub.send(bad.upload.url, new TextEncoder().encode("<html>not a picture at all!</html>").subarray(0, 30));
  await assert.rejects(cms.assets.completeUpload(admin, bad.asset.id), code("asset_type_mismatch"));
  assert.deepEqual(pub.objects.get("blog/hero.png")!.body, third);
  assert.equal((await cms.assets.get(admin, a.id)).rev, 2);
});

test("camera data: location and device leave a JPEG, the picture and its orientation stay", async () => {
  const photo = new Uint8Array(
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "#336699" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 59/1", GPSLongitudeRef: "E", GPSLongitude: "126/1 58/1 40/1" } })
      .toBuffer()
  );
  const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
  assert.ok(text(photo).includes("SecretCam") && (await sharp(photo).metadata()).orientation === 6);
  const clean = stripJpegMetadata(photo);
  assert.ok(clean.length < photo.length);
  assert.equal(text(clean).includes("SecretCam"), false);
  const meta = await sharp(clean).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.orientation], ["jpeg", 64, 32, 6]);
  // XMP, IPTC and comments go too; nothing to remove: the very same array.
  const withMore = new Uint8Array(await sharp(photo).jpeg().withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Secret Person"/></rdf:RDF></x:xmpmeta>').toBuffer());
  assert.ok(text(withMore).includes("Secret Person"));
  assert.equal(text(stripJpegMetadata(withMore)).includes("Secret Person"), false);
  assert.equal(stripJpegMetadata(clean).length, clean.length);
  const plain = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer());
  assert.equal(stripJpegMetadata(plain), plain);
  const png = await halves(8, 8);
  assert.equal(stripJpegMetadata(png), png);
  const cut = photo.subarray(0, 40);
  assert.equal(stripJpegMetadata(cut), cut, "a cut-off file is left alone");

  // With `media.stripMetadata` the server cleans what it stores itself (imports, scripts).
  const on = setup({ stripMetadata: true });
  const stored = await on.cms.assets.put(admin, { name: "trip.jpg", bytes: photo });
  assert.equal(text(on.pub.objects.get("trip.jpg")!.body).includes("SecretCam"), false);
  assert.equal(stored.size, clean.length);
  assert.equal(on.cms.assets.describe(admin)!.stripMetadata, true);
  const off = setup();
  await off.cms.assets.put(admin, { name: "trip.jpg", bytes: photo });
  assert.ok(text(off.pub.objects.get("trip.jpg")!.body).includes("SecretCam"));
  assert.equal(off.cms.assets.describe(admin)!.stripMetadata, false);
});

test("rest: ?size= on the file route, focal point and replace through the API", async () => {
  const { cms, pub } = setup();
  const handler = createCmsHandler({ cms, resolveUser: async () => admin as Extract<Actor, { kind: "user" }> });
  const call = (method: string, path: string, body?: unknown) => handler(new Request(`http://localhost/api/cms${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }));
  const a = await cms.assets.put(admin, { name: "hero.png", bytes: await halves(1600, 1200) });

  const sized = await call("GET", `/files/${a.id}/hero.png?size=card`);
  assert.equal(sized.status, 302);
  assert.match(sized.headers.get("location")!, /_cms\/derived\/.+\/card-[a-z0-9]+\.webp$/);
  const none = await call("GET", `/files/${a.id}/hero.png?size=poster`);
  assert.deepEqual([none.status, ((await none.json()) as { error: string }).error], [404, "unknown_image_size"]);

  const patched = (await (await call("PATCH", `/assets/${a.id}`, { focal: { x: 0.25, y: 0.75 } })).json()) as { asset: { focalX: number; focalY: number } };
  assert.deepEqual([patched.asset.focalX, patched.asset.focalY], [0.25, 0.75]);
  assert.equal((await call("PATCH", `/assets/${a.id}`, { focal: { x: 4, y: 0 } })).status, 422);
  const me = (await (await call("GET", "/_me")).json()) as { media: { sizes: string[]; stripMetadata: boolean } };
  assert.deepEqual([me.media.sizes.length, me.media.stripMetadata], [4, false]);

  const next = await halves(400, 300);
  const asked = (await (await call("POST", "/assets/uploads", { name: "other.png", mime: "image/png", size: next.length, replace: a.id })).json()) as { asset: { id: string }; upload: { kind: string; url: string } };
  await pub.send(asked.upload.url, next);
  const done = (await (await call("POST", `/assets/uploads/${asked.asset.id}/complete`, { width: 400, height: 300 })).json()) as { asset: { id: string; rev: number; width: number } };
  assert.deepEqual([done.asset.id, done.asset.rev, done.asset.width], [a.id, 1, 400]);
  assert.equal((await call("GET", `/files/${a.id}/hero.png`)).headers.get("location"), "https://cdn.example.com/hero.png?v=1");
});
