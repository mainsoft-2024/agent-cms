import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { layoutChecker, png } from "./layout-kit";

/**
 * Every admin screen at four widths, with long titles, slugs, names, URLs and
 * file names, and every dialog, menu and panel a harmless button opens:
 * nothing may stick out of the page, out of its dialog, or out of a box
 * that clips it. With LAYOUT_SHOTS=<dir> it also writes screenshots and a
 * report there (`report.json`) instead of failing on the first page.
 */
const api = "/api/cms";
const SHOTS = process.env.LAYOUT_SHOTS;
const WIDTHS = [
  { name: "wide", width: 1600, height: 1000 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 820, height: 1100 },
  { name: "phone", width: 390, height: 844 },
] as const;

const LONG = "an-unusually-long-slug-that-keeps-going-without-any-spaces-at-all-to-test-wrapping-2026";
const LONG_TITLE = "A very long title that goes on and on well past the width of any reasonable column, with words like internationalization and supercalifragilisticexpialidocious";
const LONG_URL = "https://hooks.example-company-with-a-long-domain.com/services/T0000000000/B0000000000/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const LONG_FILE = "a-photo-with-a-really-long-file-name-straight-from-a-camera-roll-IMG_20261122_154812_0001.png";

test.describe.configure({ mode: "serial" });

const { check, explore, problems, watch } = layoutChecker({ shots: SHOTS });

test("layout: nothing sticks out on any admin screen, dialog or panel, at four widths, with long names everywhere", async ({ page, request }) => {
  test.setTimeout(40 * 60_000);
  // Leaving an editor with changes asks first; the audit always leaves.
  page.on("dialog", (d) => void d.accept().catch(() => undefined));
  watch(page);
  // Long things everywhere.
  const made = await request.post(`${api}/collections/posts`, { data: { doc: { slug: `${LONG}-${Date.now() % 1000}`, title: LONG_TITLE, summary: `${LONG_TITLE} ${LONG_TITLE}`.slice(0, 290), category: "Engineering", body: `## ${LONG_TITLE}\n\nSee ${LONG_URL} and \`${LONG}\`.\n\n| a | b |\n|---|---|\n| ${LONG} | ${LONG_URL} |\n` }, publish: true } });
  expect(made.status()).toBe(201);
  const doc = (await made.json()) as { slug: string };
  await request.patch(`${api}/collections/posts/${doc.slug}`, { headers: { "if-match": '"v1"' }, data: { doc: { body: `## Changed\n\n${LONG_URL}\n` } } });
  await request.post(`${api}/keys`, { data: { name: `${LONG_TITLE}`.slice(0, 120), scopes: ["read", "write"] } });
  await request.post(`${api}/webhooks`, { data: { name: LONG_TITLE.slice(0, 100), url: LONG_URL, events: ["doc.published"] } });
  await request.post(`${api}/automations`, { data: { name: LONG_TITLE.slice(0, 100), trigger: { event: "doc.published", collection: "posts" }, actions: [{ type: "call", target: "log" }] } });
  await request.post(`${api}/roles`, { data: { name: LONG_TITLE.slice(0, 60), permissions: { posts: { write: true } } } });
  const rel = await request.post(`${api}/releases`, { data: { name: LONG_TITLE.slice(0, 100) } });
  const relId = rel.ok() ? ((await rel.json()) as { release?: { id: string }; id?: string }) : null;
  if (process.env.S3_ENDPOINT) {
    await page.goto("/admin/media");
    await page.getByLabel("Upload", { exact: true }).setInputFiles({ name: LONG_FILE, mimeType: "image/png", buffer: png(1600, 400) });
    await expect(page.getByText(/Uploaded 1 file/)).toBeVisible({ timeout: 20_000 });
  }

  const pages = ["/admin/dashboard", "/admin/posts", "/admin/posts/new", `/admin/posts/${doc.slug}`, "/admin/guide", "/admin/files", "/admin/releases", ...(relId ? [`/admin/releases/${relId.release?.id ?? relId.id}`] : []), "/admin/trash", "/admin/keys", "/admin/audit", "/admin/webhooks", "/admin/automations", "/admin/roles", "/admin/transfer", "/admin/misses"];
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    for (const p of pages) {
      await page.goto(p, { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await check(page, p, w.name);
      // On a phone every list screen opens the menu from its header (editors have a back button instead).
      if (w.name === "phone" && !/\/admin\/(posts|guide|releases)\/./.test(p)) {
        const menu = await page.locator("header").getByRole("button", { name: "Menu", exact: true }).first().isVisible().catch(() => false);
        if (!menu) problems.push({ page: p, width: w.name, where: "header", kind: "no-menu-button", detail: "no menu button on a phone" });
      }
      // The media detail panel and the editor's side panels open from items, not buttons.
      if (p === "/admin/media" && process.env.S3_ENDPOINT) {
        await page.getByRole("button", { name: LONG_FILE, exact: true }).first().click().catch(() => undefined);
        await check(page, `${p} › detail`, w.name);
      }
      if (w.name === "wide" || w.name === "phone") await explore(page, p, w.name);
    }
  }
  if (SHOTS) writeFileSync(`${SHOTS}/report.json`, JSON.stringify(problems, null, 1));
  expect(problems).toEqual([]);
});

test("layout: the media detail panel with a long file name fits at every width", async ({ page }) => {
  test.skip(!process.env.S3_ENDPOINT, "needs a media store");
  problems.length = 0;
  await page.goto("/admin/media");
  await page.getByLabel("Upload", { exact: true }).setInputFiles({ name: LONG_FILE, mimeType: "image/png", buffer: png(1600, 400) });
  await expect(page.getByText(/Uploaded 1 file/)).toBeVisible({ timeout: 20_000 });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/admin/media");
    const item = page.getByRole("button", { name: new RegExp(LONG_FILE.slice(0, 30)) }).first();
    await item.click();
    // Beside the grid on wide screens, a dialog on narrow ones: either way the name, Copy and Close are on screen.
    const panel = page.locator("aside:has(input), [role=dialog]").last();
    await expect(panel).toBeVisible();
    await check(page, "/admin/media › detail", w.name);
    const box = await panel.boundingBox();
    expect(box && box.x + box.width <= w.width + 1, `detail panel inside the window at ${w.name}`).toBeTruthy();
  }
  if (SHOTS) writeFileSync(`${SHOTS}/report-media.json`, JSON.stringify(problems, null, 1));
  expect(problems).toEqual([]);
});
