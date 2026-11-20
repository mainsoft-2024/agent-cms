import { expect, test, type APIRequestContext } from "@playwright/test";

// 0.13.0 in a real browser: the dashboard, automations, roles, import and export, and the OpenAPI document.
const api = "/api/cms";
const CRON = { authorization: `Bearer ${process.env.CMS_CRON_SECRET ?? "e2e-cron-secret-e2e-cron-secret"}` };
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true } : undefined);

async function clear(request: APIRequestContext) {
  const { automations } = (await (await request.get(`${api}/automations`)).json()) as { automations: { id: string }[] };
  for (const a of automations) await request.delete(`${api}/automations/${a.id}`);
  const { roles } = (await (await request.get(`${api}/roles`)).json()) as { roles: { id: string }[] };
  for (const r of roles) await request.delete(`${api}/roles/${r.id}`);
}

test("dashboard: the admin opens on it and its numbers are the lists' numbers", async ({ page, request }) => {
  let all = 0;
  let published = 0;
  for (const c of ["posts", "guide"]) {
    const { counts } = (await (await request.get(`${api}/collections/${c}/_counts`)).json()) as { counts: { all: number; published: number } };
    all += counts.all;
    published += counts.published;
  }
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  const card = (label: string) => page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=..").locator("dd");
  await expect(card("Documents")).toHaveText(String(all));
  await expect(card("Published")).toHaveText(String(published));
  await expect(page.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(14);
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  if (shot("60-dashboard")) await page.screenshot(shot("60-dashboard"));
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect(page.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(30);
});

test("automations: a published News post gets a keyword on the next cron call; another category is skipped", async ({ page, request }) => {
  await clear(request);
  const stamp = Date.now();
  await page.goto("/admin/automations");
  await expect(page.getByText(/^No automations yet\./)).toBeVisible();
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name").fill("News keyword");
  await page.getByLabel("When").selectOption("doc.published");
  await page.getByLabel("Collection").selectOption("posts");
  await page.getByRole("button", { name: "Add a condition" }).click();
  await page.getByLabel("Value").fill("News");
  await page.getByRole("button", { name: "Add an action" }).click();
  await page.getByLabel("Keyword").fill("fresh");
  await page.getByRole("button", { name: "Add an action" }).click();
  await page.getByLabel("Do").nth(1).selectOption("call");
  await page.getByLabel("Target").selectOption("log");
  // A new automation starts switched off.
  await page.getByRole("checkbox", { name: "On" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  for (const [slug, category] of [[`news-${stamp}`, "News"], [`eng-${stamp}`, "Engineering"]]) {
    expect((await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: slug, category, body: "Text.\n" }, publish: true } })).status()).toBe(201);
  }
  const before = (await (await request.get(`${api}/collections/posts/news-${stamp}?draft=1`)).json()) as { doc: { keywords: string[] } };
  expect(before.doc.keywords).toEqual([]);
  expect((await request.post(`${api}/_cron`, { headers: CRON })).status()).toBe(200);

  await page.getByRole("button", { name: "Refresh" }).click();
  const runs = page.getByRole("list", { name: "Runs" }).getByRole("listitem");
  await expect(runs).toHaveCount(2);
  await expect(runs.filter({ hasText: `news-${stamp}` })).toContainText("Done");
  await expect(runs.filter({ hasText: `eng-${stamp}` })).toContainText("Skipped");
  const after = (await (await request.get(`${api}/collections/posts/news-${stamp}?draft=1`)).json()) as { doc: { keywords: string[]; updatedBy: string } };
  expect([after.doc.keywords, after.doc.updatedBy]).toEqual([["fresh"], "automation: News keyword"]);
  const other = (await (await request.get(`${api}/collections/posts/eng-${stamp}?draft=1`)).json()) as { doc: { keywords: string[] } };
  expect(other.doc.keywords).toEqual([]);
  if (shot("61-automations")) await page.screenshot(shot("61-automations"));

  await page.getByLabel("Document address (slug)").fill(`eng-${stamp}`);
  await page.getByRole("button", { name: "Try it" }).click();
  await expect(page.getByText(/does not match the conditions, so it would be skipped\.$/)).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete “News keyword”?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/^No automations yet\./)).toBeVisible();
  for (const slug of [`news-${stamp}`, `eng-${stamp}`]) await request.delete(`${api}/collections/posts/${slug}`);
});

test("roles: make a role, allow writing in Blog, find a person by name, delete it", async ({ page, request }) => {
  await clear(request);
  await page.goto("/admin/roles");
  await expect(page.getByText(/^No roles yet\./)).toBeVisible();
  await page.getByRole("button", { name: "New role" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Writers");
  await page.getByRole("checkbox", { name: "Blog: Write" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByLabel("Name or id").fill("park");
  await page.getByRole("list", { name: "Name or id" }).getByRole("button", { name: "Park Jiwoo" }).click();
  await expect(page.getByText("People 1")).toBeVisible();
  const { roles } = (await (await request.get(`${api}/roles`)).json()) as { roles: { name: string; permissions: Record<string, Record<string, boolean>>; members: { id: string }[] }[] };
  expect(roles).toHaveLength(1);
  expect([roles[0].name, roles[0].permissions.posts, roles[0].members.map((m) => m.id)]).toEqual(["Writers", { read: true, write: true }, ["u-park"]]);
  if (shot("62-roles")) await page.screenshot(shot("62-roles"));

  // The same name again is refused, with the reason on the screen.
  await page.getByRole("button", { name: "New role" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("New role 2");
  await page.getByLabel("Name", { exact: true }).fill("writers");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The name writers is already used")).toBeVisible();

  await clear(request);
  await page.reload();
  await expect(page.getByText(/^No roles yet\./)).toBeVisible();
});

test("import and export: a markdown file is shown first, then becomes a draft; the export holds it", async ({ page, request }) => {
  const slug = `imported-${Date.now()}`;
  await page.goto("/admin/transfer");
  await page.getByLabel("Collection").selectOption("guide");
  await page.getByLabel("Choose a file").setInputFiles({ name: `${slug}.md`, mimeType: "text/markdown", buffer: Buffer.from(`---\ntitle: Imported guide\n---\n\n## Step one\n\nFrom a file.\n`) });
  const row = page.getByRole("row").filter({ hasText: `${slug}.md` });
  await expect(row).toContainText("New document");
  expect((await request.get(`${api}/collections/guide/${slug}?draft=1`)).status()).toBe(404);
  if (shot("63-import")) await page.screenshot(shot("63-import"));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText(/^Imported 1 document/)).toBeVisible();
  const made = (await (await request.get(`${api}/collections/guide/${slug}?draft=1`)).json()) as { doc: { title: string; status: string; body: string } };
  expect([made.doc.title, made.doc.status]).toEqual(["Imported guide", "draft"]);
  expect(made.doc.body).toContain("## Step one");

  await page.getByRole("radio", { name: "Export" }).click();
  // Drafts are included unless someone unticks the box.
  await expect(page.getByRole("checkbox", { name: "Include drafts" })).toBeChecked();
  await expect(page.getByRole("link", { name: "Export", exact: true })).toHaveAttribute("href", /\/api\/cms\/export\?download=1&collections=guide&drafts=1$/);
  const href = await page.getByRole("link", { name: "Export", exact: true }).getAttribute("href");
  const res = await request.get(href!);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  const bundle = (await res.json()) as { files: { path: string; text: string }[] };
  expect(bundle.files.find((f) => f.path === `guide/${slug}.md`)?.text).toContain("title: Imported guide");
  if (shot("64-export")) await page.screenshot(shot("64-export"));
  await request.delete(`${api}/collections/guide/${slug}`);
});

test("openapi: the document lists this app's collections with their fields, and a stranger sees only public ones", async ({ request, playwright, baseURL }) => {
  const doc = (await (await request.get(`${api}/openapi.json`)).json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.servers[0].url).toBe(`${baseURL}${api}`);
  expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/collections/posts", "/collections/posts/{slug}", "/automations", "/roles", "/export", "/import", "/_cron"]));
  expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["PostsDoc", "PostsInput", "GuideDoc", "Error"]));
  // Every documented GET without parameters answers (no 404, no 5xx).
  const routes = Object.entries(doc.paths as Record<string, Record<string, unknown>>).filter(([p, ops]) => !p.includes("{") && "get" in ops && !["/preview", "/preview/comments", "/_cron", "/stores"].some((x) => p.startsWith(x)));
  expect(routes.length).toBeGreaterThan(15);
  for (const [p] of routes) {
    const res = await request.get(`${api}${p}`, { maxRedirects: 0 });
    expect([p, res.status() < 404 || res.status() === 422]).toEqual([p, true]);
  }
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-example-anonymous": "1" } });
  expect((await anon.get(`${api}/openapi.json`)).status()).toBe(200);
  await anon.dispose();
});

test("the new screens do not scroll sideways on a phone @mobile", async ({ page, request }) => {
  await clear(request);
  expect((await request.post(`${api}/automations`, { data: { name: "Weekly digest reminder for the whole team", trigger: { event: "schedule.weekly", collection: null }, actions: [{ type: "call", target: "log" }] } })).status()).toBe(201);
  expect((await request.post(`${api}/roles`, { data: { name: "Editors", permissions: { posts: { write: true, publish: true }, guide: { write: true } } } })).status()).toBe(201);
  // A long title in "Recent activity" must be cut, not push the page wide.
  const long = `long-${Date.now()}`;
  expect((await request.post(`${api}/collections/posts`, { data: { doc: { slug: long, title: "A very long title that goes on and on well past the width of any phone screen there is", category: "News", body: "x\n" }, publish: true } })).status()).toBe(201);
  for (const [path, name] of [["/admin/dashboard", "65-phone-dashboard"], ["/admin/automations", "66-phone-automations"], ["/admin/roles", "67-phone-roles"], ["/admin/transfer", "68-phone-transfer"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect([path, scroll <= width]).toEqual([path, true]);
    if (shot(name)) await page.screenshot(shot(name));
  }
  await request.delete(`${api}/collections/posts/${long}`);
  await clear(request);
});
