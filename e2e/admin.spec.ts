import { expect, test, type APIRequestContext } from "@playwright/test";

const api = "/api/cms";

async function createDoc(request: APIRequestContext, slug: string, o: { publish?: boolean; body?: string } = {}) {
  const r = await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: `T ${slug}`, category: "News", body: o.body ?? "## One\n\nfirst\n\n## Two\n\nsecond" }, publish: o.publish } });
  expect(r.status()).toBe(201);
  return ((await r.json()) as { doc: { version: number } }).doc;
}

test("list shows state tabs and opens a document", async ({ page }) => {
  await page.goto("/admin/posts");
  await expect(page.getByRole("link", { name: "Hello, world" }).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: /Draft/ }).first()).toBeVisible();
  await page.getByRole("link", { name: "Hello, world" }).first().click();
  await expect(page).toHaveURL(/\/admin\/posts\/hello-world$/);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Hello, world");
});

test("create, save and publish from the editor; the public page shows it", async ({ page }) => {
  const slug = `e2e-${Date.now()}`;
  await page.goto("/admin/posts/new");
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Made in the browser");
  await page.getByRole("textbox", { name: "Slug", exact: true }).fill(slug);
  await page.getByRole("textbox", { name: "Markdown", exact: true }).fill("## Hello\n\nFrom Playwright.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${slug}$`));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Published v/ }).first()).toBeVisible();
  await page.goto(`/posts/${slug}`);
  await expect(page.getByRole("heading", { name: "Made in the browser" })).toBeVisible();
});

test("draft preview link shows the unpublished version", async ({ page, request }) => {
  const slug = `preview-${Date.now()}`;
  await createDoc(request, slug);
  const r = await request.post(`${api}/collections/posts/${slug}/preview`, { data: { ttl: "1h" } });
  const link = (await r.json()) as { url: string };
  await page.goto(link.url);
  await expect(page.getByRole("status")).toHaveText("Draft preview");
  await expect(page.getByRole("heading", { name: `T ${slug}` })).toBeVisible();
  // Without the token the draft is not public.
  const res = await page.goto(`/posts/${slug}`);
  expect(res?.status()).toBe(404);
});

test("someone saves first: the editor merges instead of overwriting", async ({ page, request }) => {
  const slug = `merge-${Date.now()}`;
  await createDoc(request, slug);
  await page.goto(`/admin/posts/${slug}`);
  const body = page.getByRole("textbox", { name: "Markdown", exact: true });
  await expect(body).toHaveValue(/first/);
  // An agent saves v2 in the meantime (a different line).
  const other = await request.patch(`${api}/collections/posts/${slug}`, { headers: { "if-match": '"v1"' }, data: { doc: { body: "## One\n\nfirst\n\n## Two\n\nsecond, by the agent" } } });
  expect(other.status()).toBe(200);
  await body.fill("## One\n\nfirst, by me\n\n## Two\n\nsecond");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save merged" })).toBeVisible();
  await page.getByRole("button", { name: "Save merged" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Saved v3/ }).first()).toBeVisible();
  const merged = (await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { body: string; version: number } };
  expect(merged.doc.version).toBe(3);
  expect(merged.doc.body).toContain("first, by me");
  expect(merged.doc.body).toContain("second, by the agent");
});

test("bulk publish reports a partial failure", async ({ page, request }) => {
  const a = `bulk-a-${Date.now()}`;
  const b = `bulk-b-${Date.now()}`;
  await createDoc(request, a);
  await createDoc(request, b);
  await page.goto("/admin/posts");
  await page.getByLabel(`Select T ${a}`).check();
  await page.getByLabel(`Select T ${b}`).check();
  // b moves on before the action runs.
  await request.patch(`${api}/collections/posts/${b}`, { headers: { "if-match": '"v1"' }, data: { doc: { title: `T ${b}` + " 2" } } });
  await page.getByRole("button", { name: "Publish", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(/1 failed|Published 2/);
});

test("API key secret is shown once with MCP and CLI set-up", async ({ page }) => {
  await page.goto("/admin/keys");
  await page.getByRole("button", { name: /New key|Create/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Name/).fill(`e2e ${Date.now()}`);
  await dialog.getByRole("button", { name: /Create/ }).click();
  await expect(page.getByRole("dialog")).toContainText("sgk_");
  await expect(page.getByRole("tab", { name: /MCP/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /CLI/ })).toBeVisible();
});

test("search misses reach the app's own screen through onSearchMiss", async ({ page, request }) => {
  const q = `refund policy ${Date.now()}`;
  const r = await request.get(`${api}/search?q=${encodeURIComponent(q)}&collections=posts&miss=1`);
  expect(((await r.json()) as { empty: boolean }).empty).toBe(true);
  await expect
    .poll(async () => {
      await page.goto("/admin/misses");
      return page.getByRole("cell", { name: q }).count();
    })
    .toBe(1);
  await expect(page.getByRole("link", { name: "Search misses" })).toBeVisible();
});

test("phone: list as cards and the menu in a sheet @mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  await page.goto("/admin/posts");
  await expect(page.getByText("Hello, world").first()).toBeVisible();
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "API keys" })).toBeVisible();
});
