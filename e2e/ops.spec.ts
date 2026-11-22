import { expect, test, type APIRequestContext } from "./fixtures";

// Webhooks in a real browser, with a real receiver: the example app's own /api/hook, which checks
// the signature with verifyWebhook.
const api = "/api/cms";
const CRON = { authorization: `Bearer ${process.env.CMS_CRON_SECRET ?? "e2e-cron-secret-e2e-cron-secret"}` };

async function clear(request: APIRequestContext) {
  const { webhooks } = (await (await request.get(`${api}/webhooks`)).json()) as { webhooks: { id: string }[] };
  for (const w of webhooks) await request.delete(`${api}/webhooks/${w.id}`);
}

test("webhooks: make one, test it, a publish arrives signed after the cron call, the history shows it", async ({ page, request, baseURL }) => {
  await clear(request);
  const slug = `hook-${Date.now()}`;
  await page.goto("/admin/webhooks");
  await expect(page.getByText("No webhooks yet.")).toBeVisible();
  await page.getByRole("button", { name: "New webhook" }).click();
  const dlg = page.getByRole("dialog", { name: "New webhook" });
  await dlg.getByLabel("Name").fill("Site cache");
  await dlg.getByLabel("Address").fill(`${baseURL}/api/hook`);
  await dlg.getByRole("checkbox", { name: "Publish", exact: true }).click();
  await dlg.getByRole("button", { name: "Create" }).click();
  const made = page.getByRole("dialog", { name: "“Site cache” is ready" });
  await expect(made.getByText(/^whsec_[A-Za-z0-9_-]{20,}$/)).toBeVisible();
  await made.getByRole("button", { name: "Close" }).first().click();

  const panel = page.getByRole("complementary", { name: "Site cache" });
  await panel.getByRole("button", { name: "Send a test" }).click();
  await expect(panel.getByText(/The address answered in \d+ ms\./)).toBeVisible();

  // A save is not asked for; the publish is. Nothing leaves before the cron call.
  expect((await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Hook", body: "Top secret words.\n" } } })).status()).toBe(201);
  expect((await request.post(`${api}/collections/posts/${slug}/publish`, { data: {} })).status()).toBe(200);
  const before = (await (await request.get("/api/hook")).json()) as { events: { event: string; slug: string | null }[] };
  expect(before.events.filter((e) => e.slug === slug)).toEqual([]);
  const run = (await (await request.post(`${api}/_cron`, { headers: CRON })).json()) as { jobs: { ok: number; failed: number } };
  expect(run.jobs).toMatchObject({ ok: 1, failed: 0 });

  const after = (await (await request.get("/api/hook")).json()) as { events: Record<string, unknown>[] };
  const mine = after.events.filter((e) => e.slug === slug);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ event: "doc.published", collection: "posts", version: 1, actor: { kind: "user" } });
  expect(JSON.stringify(mine[0])).not.toContain("Top secret");
  // The receiver refuses what is not signed by us.
  expect((await request.post("/api/hook", { data: mine[0], headers: { "x-cms-signature": "t=1,v1=" + "0".repeat(64) } })).status()).toBe(401);
  expect((await request.post("/api/hook", { data: mine[0] })).status()).toBe(401);

  // The history, after opening the panel again.
  await page.getByRole("button", { name: "Site cache" }).click();
  await page.getByRole("button", { name: "Site cache" }).click();
  const log = page.getByRole("complementary", { name: "Site cache" }).getByRole("list", { name: "Deliveries" });
  await expect(log.getByRole("listitem").filter({ hasText: `Publish, ${slug}` })).toContainText("200");
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("row").filter({ hasText: "Site cache" })).toContainText("Working");

  await page.getByRole("complementary", { name: "Site cache" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete “Site cache”?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No webhooks yet.")).toBeVisible();
});

test("webhooks on a phone: the list and the panel fit the screen @mobile", async ({ page, request, baseURL }) => {
  await clear(request);
  const made = await request.post(`${api}/webhooks`, { data: { name: "Team chat notifications", url: `${baseURL}/api/hook`, events: ["doc.published", "review.requested"] } });
  expect(made.status()).toBe(201);
  await page.goto("/admin/webhooks");
  await page.getByRole("button", { name: "Team chat notifications" }).click();
  await expect(page.getByRole("complementary", { name: "Team chat notifications" }).getByText("Nothing has been sent yet.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole("button", { name: "New webhook" }).click();
  await expect(page.getByRole("dialog", { name: "New webhook" }).getByRole("checkbox", { name: "Comment" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await clear(request);
});
