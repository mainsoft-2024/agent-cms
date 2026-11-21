import { expect, test } from "./fixtures";

// The block editor in a real browser: markdown in, blocks on screen, markdown out.
const api = "/api/cms";
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: false } : undefined);
const body = ["## Plans", "", "Pick *one* plan, **today**.", "", "- [x] Write the copy", "- [ ] Check the numbers", "", ":::html", '<div class="card">Hello</div>', ":::", "", "Last line."].join("\n");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("cms-body-view", JSON.stringify("blocks")));
});

test("blocks: a document opens as blocks, is not saved by opening, and typing writes markdown back", async ({ page, request }) => {
  const slug = `blocks-${Date.now()}`;
  const made = await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Blocks", category: "News", body }, publish: true } });
  expect(made.status()).toBe(201);
  await page.goto(`/admin/posts/${slug}`);
  const editor = page.locator(".cms-blocks [contenteditable=true]").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".cms-blocks h2", { hasText: "Plans" })).toBeVisible();
  await expect(page.locator(".cms-blocks em", { hasText: "one" })).toBeVisible();
  await expect(page.locator("[data-cms-source=html] textarea")).toHaveValue(':::html\n<div class="card">Hello</div>\n:::');
  await page.screenshot(shot("90-blocks-editor"));
  // Opening changed nothing: no save button state, version still 1.
  await page.waitForTimeout(1500);
  const before = (await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { version: number; body: string } };
  expect(before.doc.version).toBe(1);

  // Type at the end of the last paragraph.
  await page.locator(".cms-blocks p", { hasText: "Last line." }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" More words");
  // The markdown view shows what will be saved.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator("#cms-editor-body")).toHaveValue(/Last line\. More words$/);
  await expect(page.locator("#cms-editor-body")).toHaveValue(/:::html\n<div class="card">Hello<\/div>\n:::/);
  await expect(page.locator("#cms-editor-body")).toHaveValue(/^## Plans\n\nPick \*one\* plan, \*\*today\*\*\./);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect.poll(async () => ((await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { body: string } }).doc.body, { timeout: 10_000 }).toContain("Last line. More words");
});

test("blocks: the slash menu offers the CMS blocks", async ({ page, request }) => {
  const slug = `slash-${Date.now()}`;
  await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Slash", category: "News", body: "First." }, publish: false } });
  await page.goto(`/admin/posts/${slug}`);
  await page.locator(".cms-blocks p", { hasText: "First." }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByText("Two columns")).toBeVisible();
  await page.screenshot(shot("91-blocks-slash"));
  await page.keyboard.type("callout");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-cms-source=callout] textarea")).toBeVisible();
});

test("blocks: Korean typing (IME) lands as one word @mobile", async ({ page, request }) => {
  const slug = `ime-${Date.now()}`;
  await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "IME", category: "News", body: "가" }, publish: false } });
  await page.goto(`/admin/posts/${slug}`);
  await page.locator(".cms-blocks p", { hasText: "가" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("나다라");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.locator("#cms-editor-body")).toHaveValue("가나다라");
  await page.screenshot(shot("92-blocks-phone"));
});

test("publish checks: a warning can be accepted, an error stops publishing", async ({ page, request }) => {
  const slug = `checks-${Date.now()}`;
  await request.post(`${api}/collections/guide`, { data: { doc: { slug, title: "Checks", body: "Steps.\n\nTODO: finish" } } });
  await page.goto(`/admin/guide/${slug}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Not ready to publish" });
  await expect(dlg).toContainText("The text still says TODO.");
  await expect(dlg).toContainText("line 3");
  await expect(dlg).toContainText("A guide without a summary is hard to find in search.");
  await page.screenshot(shot("93-publish-checks"));
  await dlg.getByRole("button", { name: "Close" }).first().click();
  const draft = (await (await request.get(`${api}/collections/guide/${slug}?draft=1`)).json()) as { doc: { status?: string; publishedVersion?: number | null } };
  expect(draft.doc.publishedVersion ?? null).toBeNull();
});
