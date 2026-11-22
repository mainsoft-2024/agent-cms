import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("home: headline, install command, links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /serverless CMS for agents and humans/i })).toBeVisible();
  await expect(page.getByText("npm i @mainsoft/agent-cms", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: /Get started/ }).click();
  await expect(page).toHaveURL(/\/docs\/introduction$/);
  await axe(page);
});

test("docs page: sidebar, table of contents, markdown copy", async ({ page, request }) => {
  await page.goto("/docs/editing-together");
  await expect(page.getByRole("heading", { level: 1, name: "Editing together" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Docs" }).first().getByRole("link", { name: "Install" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Merge", exact: true }).first()).toHaveAttribute("href", "#merge");
  await axe(page);
  const md = await request.get("/docs/editing-together.md");
  expect(md.headers()["content-type"]).toContain("text/markdown");
  expect(await md.text()).toContain("# Editing together");
});

test("Korean docs and the language switch", async ({ page }) => {
  await page.goto("/docs/install");
  await page.getByRole("link", { name: "KO", exact: true }).click();
  await expect(page).toHaveURL(/\/ko\/docs\/install$/);
  await expect(page.getByRole("heading", { level: 1, name: "설치" })).toBeVisible();
  await expect(page.getByText("시작하기").first()).toBeVisible();
});

test("search finds a section and records a miss", async ({ page }) => {
  await page.goto("/docs/install");
  const box = page.getByRole("combobox", { name: "Search the docs" });
  // The shortcut works once the page has hydrated; press until the dialog opens.
  await expect(async () => {
    if (!(await box.isVisible())) await page.keyboard.press("Control+k");
    await expect(box).toBeVisible({ timeout: 1000 });
  }).toPass();
  await box.fill("draft preview links");
  const first = page.getByRole("option").first();
  await expect(first).toContainText(/preview/i);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/docs\/editing-together#/);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search the docs" }).fill("zzqx vvkw"); // no real words: two of three matching words would count as a hit
  await expect(page.getByText(/Nothing found/)).toBeVisible();
});

test("agents read over MCP without a key, writes are not offered", async ({ request }) => {
  const rpc = (method: string, params?: unknown) => request.post("/api/cms/mcp", { headers: { accept: "application/json, text/event-stream" }, data: { jsonrpc: "2.0", id: 1, method, params } });
  const list = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string }[] } };
  const names = list.result.tools.map((t) => t.name);
  expect(names).toContain("search_documents");
  expect(names).not.toContain("update_document");
  const found = (await (await rpc("tools/call", { name: "read_for_answer", arguments: { query: "how do I create the tables", collections: ["docs"] } })).json()) as { result: { content: { text: string }[] } };
  expect(found.result.content[0].text).toContain("cms://docs/install");
  const llms = await (await request.get("/llms.txt")).text();
  expect(llms).toContain("/docs/install.md");
});

test("component gallery: live demo and theme switch, registry JSON", async ({ page, request }) => {
  await page.goto("/components/cms-doc-list");
  const demo = page.getByRole("region", { name: "Live demo" });
  await expect(demo.getByRole("button", { name: "Install guide", exact: true })).toBeVisible();
  await demo.getByRole("button", { name: "shadcn default" }).click();
  await expect(demo.locator(".theme-shadcn")).toHaveCount(1);
  const item = (await (await request.get("/r/cms-doc-list.json")).json()) as { name: string; files: { target: string }[]; registryDependencies: string[] };
  expect(item.name).toBe("cms-doc-list");
  expect(item.files.every((f) => f.target.startsWith("@components/cms/"))).toBe(true);
  expect(item.registryDependencies.some((d) => /\/r\/cms-lib\.json$/.test(d))).toBe(true);
});

test("admin: outsiders are refused, members edit and publish", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel(/Test user/).fill("outsider");
  await page.getByRole("button", { name: "Sign in (test)" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "can't push" })).toBeVisible();
  await page.getByRole("button", { name: "Use another account" }).click();
  await page.getByLabel(/Test user/).fill("member");
  await page.getByRole("button", { name: "Sign in (test)" }).click();
  await expect(page).toHaveURL(/\/admin\/docs$/);
  await page.getByRole("link", { name: "Security" }).first().click();
  // The docs admin opens documents in the block editor (0.17.1); this test edits the markdown.
  await expect(page.locator(".cms-blocks [role=textbox]").first()).toBeVisible();
  await page.getByRole("button", { name: "Markdown", exact: true }).or(page.getByRole("radio", { name: "Markdown", exact: true })).first().click();
  const body = page.getByRole("textbox", { name: "Markdown", exact: true });
  const stamp = `Edited in the e2e test ${Date.now()}.`;
  await body.fill(`${await body.inputValue()}\n\n${stamp}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Published v/ }).first()).toBeVisible();
  await page.goto("/docs/security");
  await expect(page.getByText(stamp)).toBeVisible();
  await page.goto("/admin/misses");
  await expect(page.getByRole("heading", { name: "Search misses" })).toBeVisible();
  await page.getByRole("link", { name: /Sign out/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/admin/docs");
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("phone: menu and hero fit @mobile", async ({ page }) => {
  await page.goto("/");
  const h1 = page.getByRole("heading", { level: 1 });
  const box = await h1.boundingBox();
  expect(box && box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const lines = await h1.locator(".ln").count();
  expect(lines).toBe(3);
  // The headline lines don't wrap, so also check nothing spills past the screen.
  const widest = await h1.locator(".ln").evaluateAll((els) => Math.max(...els.map((e) => e.scrollWidth)));
  expect(widest).toBeLessThanOrEqual(page.viewportSize()!.width - 32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole("button", { name: "Open menu" }).click();
  // The menu fills the screen under the header (it used to be as short as the header).
  const menu = await page.locator("#site-menu").boundingBox();
  const screen = page.viewportSize()!;
  expect(menu && menu.height).toBeGreaterThan(screen.height - 80);
  for (const name of ["Docs", "Components", "Changelog"]) await expect(page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name })).toBeInViewport();
  await expect(page.locator("#site-menu").getByRole("link", { name: "GitHub" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(page.locator("#site-menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs\//);
});

test("phone: the pages that show a command do not scroll sideways @mobile", async ({ page }) => {
  // The command is one long line with the full package name. It scrolls inside its own box.
  for (const path of ["/", "/docs/install", "/ko/docs/install", "/docs/cli", "/components/cms-doc-list", "/components/cms-preview-comments"]) {
    await page.goto(path);
    await expect(page.getByText("npx @mainsoft/agent-cms").first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});

test("media library: docs pages, the agent page without ./ai, and the read-only demo", async ({ page, request }) => {
  await page.goto("/docs/media-library");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Media library");
  await expect(page.getByRole("heading", { name: "CORS" })).toBeVisible();
  await page.goto("/ko/docs/file-manager");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("파일 관리자");
  await page.goto("/docs/ai-sdk");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your own agent");
  expect(await page.locator("main").innerText()).not.toContain('from "@mainsoft/agent-cms/ai"');
  await page.goto("/changelog");
  await expect(page.getByText("0.8.0: media library", { exact: false }).first()).toBeVisible();

  // The gallery's library: pictures drawn by the site, shown through the demo's own file route.
  await page.goto("/components/cms-media");
  const demo = page.getByRole("region", { name: "Live demo" });
  await expect(demo.getByText("dashboard.svg").first()).toBeVisible();
  await expect(demo.getByRole("button", { name: /^Upload/ })).toHaveCount(0);
  const list = (await (await request.get("/api/demo/assets")).json()) as { assets: { name: string; publicUrl: string }[] };
  expect(list.assets.length).toBe(5);
  const file = await request.get(list.assets[0].publicUrl);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("image/svg+xml");
  expect(file.headers()["content-security-policy"]).toContain("sandbox");
  expect((await request.post("/api/demo/assets/uploads", { data: { name: "x.png", mime: "image/png", size: 10 } })).status()).toBe(403);
  expect((await (await request.get("/r/cms-media.json")).json()).name).toBe("cms-media");
});

test("publishing flow: a draft link with comments, a schedule run by the cron call, trash and releases", async ({ page, request }) => {
  await page.goto("/admin/login");
  await page.getByLabel(/Test user/).fill("member");
  await page.getByRole("button", { name: "Sign in (test)" }).click();
  await expect(page).toHaveURL(/\/admin\/docs$/);
  // The sidebar has the two new screens.
  await expect(page.getByRole("link", { name: "Releases" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Trash/ })).toBeVisible();

  const slug = `flow-${Date.now()}`;
  const api = page.request; // carries the session cookie
  const made = await api.post("/api/cms/collections/docs", {
    data: { doc: { slug, title: "Flow check", summary: "A page made by the e2e test.", category: "Guides", fields: { order: 99 }, body: "## First\n\nA sentence only the draft has.\n" } },
  });
  expect(made.status()).toBe(201);

  // A draft is not public, a signed link shows it with the comment box, and a guest's comment reaches the editor.
  expect((await request.get(`/docs/${slug}`)).status()).toBe(404);
  const link = await (await api.post(`/api/cms/collections/docs/${slug}/preview`, { data: { ttl: "1h", comments: true } })).json();
  expect(link.url).toContain(`/docs/${slug}?cms_preview=`);
  await page.goto(link.url);
  await expect(page.getByRole("status").filter({ hasText: "Draft preview" })).toBeVisible();
  await expect(page.getByText("A sentence only the draft has.")).toBeVisible();
  await page.getByLabel("Name").fill("Reviewer");
  await page.getByLabel("Write a comment").fill("Looks right to me.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Looks right to me.")).toBeVisible();
  const threads = await (await api.get(`/api/cms/collections/docs/${slug}/comments`)).json();
  expect(JSON.stringify(threads)).toContain("Looks right to me.");
  // A link without the right to comment shows the draft and no box; a broken token shows nothing.
  const plain = await (await api.post(`/api/cms/collections/docs/${slug}/preview`, { data: { ttl: "1h" } })).json();
  await page.goto(plain.url);
  await expect(page.getByRole("status").filter({ hasText: "Draft preview" })).toBeVisible();
  await expect(page.getByLabel("Write a comment")).toHaveCount(0);
  expect((await request.get(`/docs/${slug}?cms_preview=${plain.token.slice(0, -4)}AAAA`)).status()).toBe(404);

  // The cron route: closed without the secret, and it publishes what is due.
  expect((await request.get("/api/cms/_cron")).status()).toBe(401);
  const at = new Date(Date.now() + 1500).toISOString();
  expect((await api.post(`/api/cms/collections/docs/${slug}/schedule`, { data: { publishAt: at } })).status()).toBe(200);
  await page.goto("/admin/docs");
  await page.getByRole("radio", { name: /^Scheduled/ }).click();
  await expect(page.getByRole("link", { name: "Flow check" })).toBeVisible();
  await page.waitForTimeout(1800);
  const ran = await request.get("/api/cms/_cron", { headers: { authorization: "Bearer e2e-cron-secret-e2e-cron-secret" } });
  expect(ran.status()).toBe(200);
  expect((await ran.json()).published).toEqual([`docs/${slug}`]);
  await page.goto(`/docs/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: "Flow check" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Draft preview" })).toHaveCount(0);

  // A release from the screen, with the page in it.
  await page.goto("/admin/releases");
  await page.getByRole("button", { name: "New release" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("E2E release");
  await page.getByRole("dialog").getByRole("button", { name: /Create|Save|New release/ }).click();
  await expect(page).toHaveURL(/\/admin\/releases\/[a-z0-9-]+$/);
  await expect(page.getByRole("button", { name: "Add documents" })).toBeVisible();

  // Deleting goes to the trash; restoring makes the published page public again.
  expect((await api.delete(`/api/cms/collections/docs/${slug}`)).status()).toBeLessThan(300);
  expect((await request.get(`/docs/${slug}`)).status()).toBe(404);
  await page.goto("/admin/trash");
  const row = page.getByRole("row").filter({ hasText: "Flow check" });
  await expect(row).toBeVisible();
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await request.get(`/docs/${slug}`)).status()).toBe(200);
  // Tidy up for good, so a re-run starts clean.
  await api.delete(`/api/cms/collections/docs/${slug}`);
  await api.post("/api/cms/trash/_purge", { data: { all: true } });
});

test("gallery: trash and releases have live demos, the comment box says where to see it", async ({ page }) => {
  await page.goto("/components/cms-trash");
  const demo = page.getByRole("region", { name: "Live demo" });
  await expect(demo.getByRole("heading", { name: "Trash" })).toBeVisible();
  await expect(demo.getByRole("row").filter({ hasText: "Pricing in 2025" })).toBeVisible();
  await page.goto("/components/cms-releases");
  await demo.getByRole("link", { name: "New pricing" }).or(demo.getByRole("button", { name: "New pricing" })).first().click();
  await expect(demo.getByText("Moving to the new plans")).toBeVisible();
  await page.goto("/components/cms-preview-comments");
  await expect(page.getByText(/This box goes on your public page/)).toBeVisible();
  await page.goto("/docs/publishing-flow");
  await expect(page.getByRole("heading", { level: 1, name: "Publishing flow" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Preview comments" })).toHaveAttribute("href", "/components/cms-preview-comments");
  await page.goto("/ko/docs/publishing-flow");
  await expect(page.getByRole("heading", { level: 1, name: "게시 흐름" })).toBeVisible();
});
