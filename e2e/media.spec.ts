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
  await expect(page.getByRole("status").filter({ hasText: /Published v/ }).first()).toBeVisible();

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
