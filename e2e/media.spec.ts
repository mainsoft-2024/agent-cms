import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

// The media library against a real S3-compatible server (`npm run s3:dev`).
// Skipped when the example app runs without a storage.
const on = !!process.env.S3_ENDPOINT;

/** A real PNG the browser can decode, so the thumbnail and size come from the browser. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => (b.reduce((c, x) => crcTable[(c ^ x) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + w * 3, 0x66);
  row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

test("media: upload from the browser, describe the file, use it in a post, see it on the public page", async ({ page }) => {
  test.skip(!on, "needs S3_ENDPOINT");
  const name = `e2e-${Date.now()}.png`;
  await page.goto("/admin/media");
  await page.getByLabel("Upload", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: png(640, 360) });
  await expect(page.getByText("Uploaded 1 files")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("complementary", { name });
  await expect(panel.getByText("PNG Image")).toBeVisible();
  await expect(panel.getByText(/640×360/)).toBeVisible();
  // The browser made the small picture and the server stored it.
  await expect(page.getByRole("button", { name, exact: true }).locator("img")).toHaveAttribute("src", /thumb=1/);
  await panel.getByLabel("Alt text").fill("A grey test picture");
  await panel.getByLabel("Add a tag").click();
  await expect.poll(async () => (await (await page.request.get(`/api/cms/assets?q=${name}`)).json()).assets[0]?.alt).toBe("A grey test picture");

  const slug = `media-${Date.now()}`;
  await page.goto("/admin/posts/new");
  await page.getByLabel("Title").fill("Media post");
  await page.getByLabel("Slug").fill(slug);
  await page.getByRole("button", { name: "Choose media" }).click();
  let dialog = page.getByRole("dialog", { name: "Choose media" });
  await dialog.getByRole("button", { name, exact: true }).click();
  await dialog.getByRole("button", { name: "Insert" }).click();
  await page.getByRole("button", { name: "Insert media" }).click();
  dialog = page.getByRole("dialog", { name: "Choose media" });
  await dialog.getByRole("button", { name, exact: true }).click();
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(page.getByLabel("Markdown")).toHaveValue(new RegExp(`!\\[A grey test picture\\]\\(asset:[a-z0-9]{12}/${name}\\)`));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  // A new document moves to its own address, which mounts a new editor: the line has to be there too.
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}$`));
  await expect(page.getByRole("status").filter({ hasText: /Published v1/ }).first()).toBeVisible();

  await page.goto(`/posts/${slug}`);
  const pictures = page.getByRole("img", { name: "A grey test picture" });
  await expect(pictures).toHaveCount(2);
  // The picture really loads from the storage (through the file route's redirect).
  await expect.poll(() => pictures.first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);

  // A file in use: the delete dialog lists the post.
  await page.goto("/admin/media");
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("complementary", { name }).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete 1 files?" });
  await expect(confirm.getByText("1 documents use this file")).toBeVisible();
  await expect(confirm.getByRole("link", { name: "Media post" })).toBeVisible();
});

test("media: a refused file says why @mobile", async ({ page, isMobile }) => {
  test.skip(!on, "needs S3_ENDPOINT");
  await page.goto("/admin/media");
  await page.getByLabel("Upload", { exact: true }).setInputFiles({ name: "page.png", mimeType: "image/png", buffer: Buffer.from("<html><script>1</script></html>") });
  await expect(page.getByText("The file content does not match its extension")).toBeVisible({ timeout: 20_000 });
  if (isMobile) await expect(page.getByLabel("Folder", { exact: true })).toBeVisible();
});

test("files: upload into the bucket view, select the file and make a link", async ({ page, isMobile }) => {
  test.skip(!on || isMobile, "needs S3_ENDPOINT; desktop only");
  const name = `files-${Date.now()}.png`;
  await page.goto("/admin/files");
  await page.getByLabel("Upload", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: png(320, 200) });
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("checkbox", { name: new RegExp(name.replace(".", "\\.")) }).click();
  const bar = page.getByRole("toolbar");
  await expect(bar.getByRole("status")).toHaveText("1 selected");
  await bar.getByRole("button", { name: "Make a link" }).click();
  const dialog = page.getByRole("dialog", { name: "Make a link" });
  const link = dialog.locator("code").first();
  await expect(link).toContainText(name);
  // The address really serves the file.
  const res = await page.request.get((await link.textContent()) ?? "");
  expect(res.status()).toBe(200);
  expect((await res.body()).length).toBeGreaterThan(50);
});

test("media: a photo loses its camera data, the focal point crops the cover, and a file is replaced at its address", async ({ page, request, isMobile }) => {
  test.skip(!on || isMobile, "needs S3_ENDPOINT; desktop only");
  const sharp = (await import("sharp")).default;
  /** Left half red, right half blue: a crop shows which side it kept. */
  const halves = async (w: number, h: number) => {
    const left = await sharp({ create: { width: w / 2, height: h, channels: 3, background: "#ff0000" } }).png().toBuffer();
    return sharp({ create: { width: w, height: h, channels: 3, background: "#0000ff" } }).composite([{ input: left, left: 0, top: 0 }]);
  };
  const photo = await (await halves(1600, 400)).jpeg().withExifMerge({ IFD0: { Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 59/1" } }).toBuffer();
  expect(photo.toString("latin1")).toContain("SecretCam");
  const name = `trip-${Date.now()}.jpg`;
  await page.goto("/admin/media");
  await page.getByLabel("Upload", { exact: true }).setInputFiles({ name, mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByText("Uploaded 1 files")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("complementary", { name });
  await expect(panel.getByText(/1600×400/)).toBeVisible();
  const id = /\/files\/([a-z0-9]{12})\//.exec((await panel.locator("img").getAttribute("src")) ?? "")![1];
  const fileUrl = `/api/cms/files/${id}/${name}`;

  // What is in the storage has no camera data, and is smaller than what was picked.
  const stored = await (await request.get(fileUrl)).body();
  expect(stored.toString("latin1")).not.toContain("SecretCam");
  expect(stored.length).toBeLessThan(photo.length);
  expect((await sharp(stored).metadata()).width).toBe(1600);

  // A named size: made on first request, 800×450 cut around the middle (red on the left, blue on the right).
  const colour = async (bytes: Buffer, x: number) => {
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const i = (Math.floor(info.height / 2) * info.width + x) * info.channels;
    return data[i] > 180 ? "red" : data[i + 2] > 180 ? "blue" : "other";
  };
  const card = async () => (await request.get(`${fileUrl}?size=card`)).body();
  const middle = await card();
  expect([(await sharp(middle).metadata()).format, (await sharp(middle).metadata()).width, (await sharp(middle).metadata()).height]).toEqual(["webp", 711, 400]);
  expect([await colour(middle, 20), await colour(middle, 690)]).toEqual(["red", "blue"]);
  expect((await request.get(`${fileUrl}?size=poster`)).status()).toBe(404);

  // Focal point: click near the right edge of the picture; the card is now cut from the blue side.
  await panel.getByRole("button", { name: "Focal point", exact: true }).click();
  const box = (await panel.locator("img").boundingBox())!;
  await panel.locator("img").click({ position: { x: box.width * 0.9, y: box.height * 0.5 } });
  await expect(panel.getByRole("button", { name: /^Focal point: 9\d% from the left, 5\d% from the top$/ })).toBeVisible();
  const right = await card();
  expect([await colour(right, 20), await colour(right, 690)]).toEqual(["blue", "blue"]);
  // The dot sits where the click was.
  const dot = (await panel.getByRole("button", { name: /^Focal point:/ }).boundingBox())!;
  expect(Math.abs(dot.x + dot.width / 2 - (box.x + box.width * 0.9))).toBeLessThan(3);

  // Used as a post's cover: the public page shows the card, and the browser gets a 16:9 picture.
  const slug = `cover-${Date.now()}`;
  expect((await request.post("/api/cms/collections/posts", { data: { doc: { slug, title: "Cover", body: "text", fields: { cover: id } }, publish: true } })).status()).toBe(201);
  await page.goto(`/posts/${slug}`);
  const cover = page.locator("img[data-cover]");
  await expect(cover).toHaveAttribute("src", new RegExp(`/api/cms/files/${id}/.+\\?size=card$`));
  await expect.poll(() => cover.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([711, 400]);
  // The same point the click set (a click lands on a whole pixel, so within a percent).
  const [px, py] = (await cover.evaluate((el) => getComputedStyle(el).objectPosition)).split(" ").map(parseFloat);
  expect([Math.abs(px - 90) < 1.5, Math.abs(py - 50) < 1.5]).toEqual([true, true]);

  // Replace: same address, new content (all blue, smaller). The panel shows the new size; old sizes are gone.
  await page.goto("/admin/media");
  await page.getByRole("button", { name, exact: true }).click();
  const next = await sharp({ create: { width: 800, height: 200, channels: 3, background: "#0000ff" } }).jpeg().toBuffer();
  await panel.locator('input[type="file"]').setInputFiles({ name: "other-name.jpg", mimeType: "image/jpeg", buffer: next });
  const ask = page.getByRole("dialog", { name: `Replace the content of “${name}”?` });
  await expect(ask.getByText("1 documents use this file and will show the new content.")).toBeVisible();
  await ask.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(panel.getByText(/800×200/)).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("img")).toHaveAttribute("src", /\?v=1$/);
  await expect.poll(() => panel.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(800);
  const now = await (await request.get(fileUrl)).body();
  expect([(await sharp(now).metadata()).width, await colour(now, 20)]).toEqual([800, "blue"]);
  const cardNow = await card();
  expect([(await sharp(cardNow).metadata()).width, (await sharp(cardNow).metadata()).height, await colour(cardNow, 20)]).toEqual([356, 200, "blue"]);
  // The focal point belongs to the file, not to its content: it is still there.
  await expect(panel.getByRole("button", { name: /^Focal point: 9\d%/ })).toBeDisabled();
});
