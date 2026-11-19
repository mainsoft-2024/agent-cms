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
  await box.fill("preview link");
  const first = page.getByRole("option").first();
  await expect(first).toContainText(/preview/i);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/docs\/editing-together#/);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search the docs" }).fill("zzqx nothing here");
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
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs\//);
});
