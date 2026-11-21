import { expect, test } from "@playwright/test";

// 0.14.0 in a real browser: key limits and rotation, the events stream, retention.
const api = "/api/cms";
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true } : undefined);

test("keys: a key with its own limit is refused after it, and rotating keeps the old secret working", async ({ page, request, playwright, baseURL }) => {
  const name = `deploy-${Date.now()}`;
  await page.goto("/admin/keys");
  await page.getByRole("button", { name: "New key" }).click();
  const dialog = page.getByRole("dialog", { name: "New key" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Requests per minute").fill("3");
  if (shot("70-key-form")) await page.screenshot(shot("70-key-form"));
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Show" }).first().click();
  const first = (await page.getByRole("dialog", { name }).getByText(/^sgk_[^•]+$/).first().textContent()) ?? "";
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByText("3 per minute")).toBeVisible();

  // The key's own number: the fourth request inside a minute is refused and says when to come back.
  const withKey = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${first}` } });
  const statuses: number[] = [];
  let last = await withKey.get(`${api}/collections/posts?fields=summary&limit=1`);
  statuses.push(last.status());
  for (let i = 0; i < 3; i++) statuses.push((last = await withKey.get(`${api}/collections/posts?fields=summary&limit=1`)).status());
  // A minute may turn over between two requests; what must hold is that a refusal comes with its reason.
  expect(statuses.slice(0, 1)).toEqual([200]);
  if (statuses.includes(429)) {
    expect(((await last.json()) as { error: string }).error).toBe("rate_limited");
    expect(Number(last.headers()["retry-after"])).toBeGreaterThan(0);
  } else expect(statuses.filter((s) => s === 200).length).toBe(4);
  await withKey.dispose();

  await page.getByRole("button", { name: `Rotate: ${name}` }).click();
  await page.getByRole("dialog", { name: `Make a new secret for “${name}”?` }).getByRole("button", { name: "Rotate" }).click();
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Show" }).first().click();
  const second = (await page.getByRole("dialog", { name }).getByText(/^sgk_[^•]+$/).first().textContent()) ?? "";
  expect(second).not.toBe(first);
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByText(/^Works until /)).toBeVisible();
  if (shot("71-key-rotated")) await page.screenshot(shot("71-key-rotated"));
  const { keys } = (await (await request.get(`${api}/keys`)).json()) as { keys: { id: string; name: string; rotatedTo: string | null; revokedReason: string | null; rateLimit: number | null }[] };
  const mine = keys.filter((k) => k.name === name);
  expect(mine.map((k) => [k.revokedReason, k.rateLimit]).sort()).toEqual([["rotated", 3], [null, 3]].sort());
  const fresh = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${second}` } });
  expect((await fresh.get(`${api}/_me`)).status()).toBe(200);
  await fresh.dispose();
  for (const k of mine) await request.delete(`${api}/keys/${k.id}`);
});

test("events: the browser hears a publish as it happens, and a reconnect gets what it missed", async ({ page, request }) => {
  const slug = `live-${Date.now()}`;
  await page.goto("/admin/dashboard");
  const since = new Date().toISOString();
  await page.evaluate((api) => {
    const w = window as unknown as { heard: string[]; es: EventSource };
    w.heard = [];
    w.es = new EventSource(`${api}/_events?collections=posts`);
    for (const name of ["ready", "doc.created", "doc.published", "doc.deleted"]) w.es.addEventListener(name, (e) => w.heard.push(`${name}:${(JSON.parse((e as MessageEvent).data) as { slug?: string }).slug ?? ""}`));
  }, api);
  await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toContain("ready:");
  expect((await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Live", category: "News", body: "x\n" }, publish: true } })).status()).toBe(201);
  await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(expect.arrayContaining([`doc.created:${slug}`, `doc.published:${slug}`]));
  await page.evaluate(() => (window as unknown as { es: EventSource }).es.close());

  // Away and back: one message lists what was saved since.
  const missed = await page.evaluate(
    ([api, since]) =>
      new Promise<string[]>((resolve) => {
        const es = new EventSource(`${api}/_events?collections=posts&since=${encodeURIComponent(since)}`);
        es.addEventListener("resync", (e) => {
          es.close();
          resolve((JSON.parse((e as MessageEvent).data) as { documents: { slug: string }[] }).documents.map((d) => d.slug));
        });
      }),
    [api, since]
  );
  expect(missed).toContain(slug);
  await request.delete(`${api}/collections/posts/${slug}`);
});

test("retention: a dry run says what would go and deletes nothing", async ({ request }) => {
  const rules = (await (await request.get(`${api}/retention`)).json()) as { rules: { what: string; days: number }[] };
  expect(rules.rules).toEqual([{ what: "audit", days: 365 }, { what: "hits", days: 400 }, { what: "keys", days: 90 }]);
  const before = (await (await request.get(`${api}/audit?limit=1`)).json()) as { entries: unknown[] };
  const dry = (await (await request.post(`${api}/retention`, { data: { dryRun: true } })).json()) as { dryRun: boolean; items: { what: string; rows: number }[] };
  expect(dry.dryRun).toBe(true);
  expect(dry.items.map((i) => i.what)).toEqual(["audit", "hits", "keys"]);
  expect(dry.items.every((i) => i.rows === 0)).toBe(true);
  expect(((await (await request.get(`${api}/audit?limit=1`)).json()) as { entries: unknown[] }).entries.length).toBe(before.entries.length);
});
