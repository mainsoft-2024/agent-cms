import { expect, test } from "./fixtures";

// 0.15.0 in a real browser: the new markdown blocks and HTML kept as written.
const api = "/api/cms";
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true } : undefined);

const body = [
  "## Plans",
  "",
  "Pick *one* plan. ~~Old prices~~ are gone.",
  "",
  "| Plan | Price |",
  "| :--- | ---: |",
  "| Free | $0 |",
  "| Team | $12 |",
  "",
  "- [x] Write the copy",
  "- [ ] Check the numbers",
  "",
  ":::toggle What about refunds?",
  "Within 30 days, always.",
  ":::",
  "",
  ":::html",
  '<div class="card"><b>Hello</b> from HTML <button onclick="steal()">Go</button></div>',
  "<script>document.title = 'owned'</script>",
  ":::",
].join("\n");

test("public page and admin preview draw tables, task lists, toggles; HTML scripts never run", async ({ page, request }) => {
  const slug = `polish-${Date.now()}`;
  const made = await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Pricing", category: "News", body }, publish: true } });
  expect(made.status()).toBe(201);
  // Stored exactly as written.
  const doc = (await made.json()) as { doc: { body: string } };
  expect(doc.doc.body).toContain("<script>document.title = 'owned'</script>");

  await page.goto(`/posts/${slug}`);
  await expect(page.getByRole("cell", { name: "$12" })).toBeVisible();
  await expect(page.locator("em", { hasText: "one" })).toBeVisible();
  await expect(page.locator("del", { hasText: "Old prices" })).toBeVisible();
  await expect(page.getByText("What about refunds?")).toBeVisible();
  await expect(page.getByText("Within 30 days, always.")).toBeHidden();
  await page.getByText("What about refunds?").click();
  await expect(page.getByText("Within 30 days, always.")).toBeVisible();
  await expect(page.getByText("from HTML")).toBeVisible();
  // Sanitized on the public page: no script, no handler.
  expect(await page.locator("script:text('owned')").count()).toBe(0);
  expect(await page.locator("[onclick]").count()).toBe(0);
  expect(await page.title()).not.toBe("owned");
  if (shot("80-public-blocks")) await page.screenshot(shot("80-public-blocks"));

  // The admin preview: the HTML block sits in a sandboxed frame with what will not work under it.
  await page.goto(`/admin/posts/${slug}`);
  const preview = page.getByRole("button", { name: "Preview" }).first();
  if (await preview.isVisible().catch(() => false)) await preview.click();
  const frame = page.locator("iframe[title='HTML']").first();
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
  await expect(page.frameLocator("iframe[title='HTML']").first().getByText("from HTML")).toBeVisible();
  await expect(page.getByText("<script> · scripts do not run")).toBeVisible();
  await expect(page.getByText("onclick · event handlers do not run")).toBeVisible();
  expect(await page.title()).not.toBe("owned");
  if (shot("81-admin-html-block")) await page.screenshot(shot("81-admin-html-block"));
});
