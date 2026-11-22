import { expect, test, type Page } from "./fixtures";

// The block editor's mouse work in a real browser, the way people do it in
// Notion: drag a block by its handle (up, down, beside another to make
// columns, into a toggle), Alt-drag to copy, draw a box to select, nested
// lists with Tab, toggles, tables edited cell by cell, the handle menu.
const api = "/api/cms";
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: false } : undefined);
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("cms-body-view", JSON.stringify("blocks")));
});

const row = (page: Page, type: string, text: string) => page.locator(`.cms-blocks [data-block-type=${type}]`, { has: page.locator("[role=textbox]", { hasText: text }) }).first();
const line = (page: Page, type: string, text: string) => row(page, type, text).locator("[role=textbox]").first();
const texts = (page: Page) => page.locator(".cms-blocks [data-block-type=p] [role=textbox]").allInnerTexts();
async function markdown(page: Page) {
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  return page.locator("#cms-editor-body");
}
async function open(page: Page, request: import("@playwright/test").APIRequestContext, text: string) {
  const slug = `ntn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const made = await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Notion-like", category: "News", body: text } } });
  expect(made.status()).toBe(201);
  await page.goto(`/admin/posts/${slug}`);
  await expect(page.locator(".cms-blocks [role=textbox]").first()).toBeVisible({ timeout: 20_000 });
  return slug;
}
/** Press the handle of a block and drag it to a point, in small steps like a hand. */
async function drag(page: Page, from: ReturnType<typeof row>, to: { x: number; y: number }, opts: { alt?: boolean; shotName?: string } = {}) {
  await from.hover();
  const handle = from.locator("button[aria-label^='Drag to move']").first();
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  if (opts.alt) await page.keyboard.down("Alt");
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(h.x + ((to.x - h.x) * i) / steps, h.y + ((to.y - h.y) * i) / steps);
  if (opts.shotName) await page.screenshot(shot(opts.shotName));
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up("Alt");
}

test("notion: drag a block by its handle above another, with a line showing where it lands", async ({ page, request }) => {
  await open(page, request, "Alpha\n\nBeta\n\nGamma");
  const target = (await row(page, "p", "Alpha").boundingBox())!;
  await row(page, "p", "Gamma").hover();
  const handle = row(page, "p", "Gamma").locator("button[aria-label^='Drag to move']");
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + 5, h.y + 5);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(h.x + 5 + (target.x + 40 - h.x) * (i / 10), h.y + 5 + (target.y + 3 - h.y) * (i / 10));
  // The picture of the block follows the pointer, the block itself is dimmed, a line shows the place.
  await expect(page.locator("body > div[aria-hidden=true]").last()).toContainText("Gamma");
  await expect(row(page, "p", "Gamma")).toHaveClass(/opacity-35/);
  await page.screenshot(shot("a1-drag-line"));
  await page.mouse.up();
  await expect.poll(() => texts(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  // Esc during a drag puts nothing anywhere.
  await row(page, "p", "Beta").hover();
  const h2 = (await row(page, "p", "Beta").locator("button[aria-label^='Drag to move']").boundingBox())!;
  await page.mouse.move(h2.x + 5, h2.y + 5);
  await page.mouse.down();
  await page.mouse.move(h2.x + 5, target.y - 40, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => texts(page)).toEqual(["Gamma", "Alpha", "Beta"]);
  const md = await markdown(page);
  await expect(md).toHaveValue("Gamma\n\nAlpha\n\nBeta");
});

test("notion: drop beside a block makes columns; moving the last block out takes them away", async ({ page, request }) => {
  await open(page, request, "Left words\n\nRight words\n\nAfter");
  const left = (await row(page, "p", "Left words").boundingBox())!;
  await drag(page, row(page, "p", "Right words"), { x: left.x + left.width - 20, y: left.y + left.height / 2 }, { shotName: "a2-drag-side" });
  await expect(page.locator(".cms-blocks [data-col-id]")).toHaveCount(2);
  await expect(page.locator(".cms-blocks [data-col-id]").nth(0)).toContainText("Left words");
  await expect(page.locator(".cms-blocks [data-col-id]").nth(1)).toContainText("Right words");
  await page.screenshot(shot("a3-columns"));
  let md = await markdown(page);
  await expect(md).toHaveValue(":::columns\n:::col\nLeft words\n:::col\nRight words\n:::\n\nAfter");
  await page.getByRole("button", { name: "Blocks", exact: true }).click();
  // Drag "Right words" back under "After": its column is empty and goes, one column left means no columns.
  const after = (await row(page, "p", "After").boundingBox())!;
  await drag(page, row(page, "p", "Right words"), { x: after.x + 40, y: after.y + after.height - 3 });
  await expect(page.locator(".cms-blocks [data-col-id]")).toHaveCount(0);
  await expect.poll(() => texts(page)).toEqual(["Left words", "After", "Right words"]);
  md = await markdown(page);
  await expect(md).toHaveValue("Left words\n\nAfter\n\nRight words");
});

test("notion: toggles open and close, take blocks dropped into them, and Alt-drag copies", async ({ page, request }) => {
  await open(page, request, ":::toggle Details\nHidden inside\n:::\n\nLoose line");
  const toggle = row(page, "toggle", "Details");
  await expect(toggle.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(line(page, "p", "Hidden inside")).toBeHidden();
  await toggle.getByRole("button", { name: "Open" }).click();
  await expect(line(page, "p", "Hidden inside")).toBeVisible();
  // Drag "Loose line" into the open toggle (onto the lower half of its title).
  const t = (await toggle.boundingBox())!;
  await drag(page, row(page, "p", "Loose line"), { x: t.x + 80, y: t.y + t.height - 4 });
  let md = await markdown(page);
  await expect(md).toHaveValue(":::toggle Details\nLoose line\n\nHidden inside\n:::");
  await page.getByRole("button", { name: "Blocks", exact: true }).click();
  // Alt-drag the whole toggle below itself: a copy with what is inside it.
  const t2 = (await row(page, "toggle", "Details").boundingBox())!;
  const wrap = (await page.locator(".cms-blocks [data-block-wrap]").first().boundingBox())!;
  // The pointer is out to the left of the blocks inside: the copy goes after the toggle, not inside it.
  await drag(page, row(page, "toggle", "Details"), { x: t2.x - 20, y: wrap.y + wrap.height + 20 }, { alt: true });
  await expect(page.locator(".cms-blocks [data-block-type=toggle]")).toHaveCount(2);
  md = await markdown(page);
  await expect(md).toHaveValue(":::toggle Details\nLoose line\n\nHidden inside\n:::\n\n:::toggle Details\nLoose line\n\nHidden inside\n:::");
});

test("notion: Tab nests list items, Shift+Tab takes them out, Enter on an empty nested item goes up a level", async ({ page, request }) => {
  await open(page, request, "- one");
  await line(page, "bullet", "one").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("one a");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("one a i");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // empty nested item: one level up
  await page.keyboard.type("one b");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("two");
  await page.screenshot(shot("a4-nested-list"));
  const md = await markdown(page);
  await expect(md).toHaveValue("- one\n  - one a\n    - one a i\n  - one b\n- two");
});

test("notion: a table edited cell by cell, rows and columns added, a column aligned", async ({ page, request }) => {
  await open(page, request, "Intro");
  await line(page, "p", "Intro").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const cells = page.locator(".cms-blocks [data-block-type=table] [role=textbox]");
  await expect(cells).toHaveCount(9);
  await page.keyboard.type("Name");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Plan");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Price");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Ann");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Pro");
  await page.keyboard.press("Tab");
  await page.keyboard.type("10");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Bo");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("5");
  // Tab in the last cell adds a row.
  await page.keyboard.press("Tab");
  await expect(cells).toHaveCount(12);
  await page.keyboard.type("Cy");
  // Align the price column right from its menu.
  const head = page.locator(".cms-blocks [data-block-type=table] th").nth(2);
  await head.hover();
  await head.getByRole("button", { name: "Column options" }).click();
  await page.getByRole("menuitem", { name: "Align right" }).click();
  await page.screenshot(shot("a5-table"));
  const md = await markdown(page);
  await expect(md).toHaveValue("Intro\n\n| Name | Plan | Price |\n| --- | --- | ---: |\n| Ann | Pro | 10 |\n| Bo |  | 5 |\n| Cy |  |  |");
});

test("notion: a box drawn from the margin selects blocks; the handle menu searches and turns them into another kind", async ({ page, request }) => {
  await open(page, request, "One\n\nTwo\n\nThree\n\nFour");
  const a = (await row(page, "p", "Two").boundingBox())!;
  const b = (await row(page, "p", "Three").boundingBox())!;
  const root = (await page.locator(".cms-blocks").boundingBox())!;
  // From the left margin (the editor's gutter), across Two and Three.
  await page.mouse.move(root.x + 3, a.y + 4);
  await page.mouse.down();
  await page.mouse.move(root.x + 120, b.y + b.height - 4, { steps: 8 });
  await page.screenshot(shot("a6-marquee"));
  await page.mouse.up();
  await expect(page.locator(".cms-blocks [data-block-id][aria-selected=true]")).toHaveCount(2);
  // ⌘/ opens the menu for the selection; type to find "bullet".
  await page.keyboard.press(`${mod}+/`);
  const search = page.getByRole("combobox", { name: "Search actions" });
  await expect(search).toBeFocused();
  await page.keyboard.type("bullet");
  await page.screenshot(shot("a7-block-menu"));
  await page.keyboard.press("Enter");
  await expect(page.locator(".cms-blocks [data-block-type=bullet]")).toHaveCount(2);
  const md = await markdown(page);
  await expect(md).toHaveValue("One\n\n- Two\n- Three\n\nFour");
});

test("notion: dragging to the bottom of a long page scrolls it", async ({ page, request }) => {
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`);
  await open(page, request, lines.join("\n\n"));
  await page.setViewportSize({ width: 1280, height: 640 });
  const first = row(page, "p", "Line 1");
  await first.hover();
  const h = (await first.locator("button[aria-label^='Drag to move']").boundingBox())!;
  await page.mouse.move(h.x + 5, h.y + 5);
  await page.mouse.down();
  await page.mouse.move(h.x + 40, 630, { steps: 10 });
  const before = await page.evaluate(() => {
    const s = document.querySelector(".cms-blocks")!;
    let el: HTMLElement | null = s.parentElement;
    while (el && !(getComputedStyle(el).overflowY.match(/auto|scroll/) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
    return el ? el.scrollTop : window.scrollY;
  });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const s = document.querySelector(".cms-blocks")!;
    let el: HTMLElement | null = s.parentElement;
    while (el && !(getComputedStyle(el).overflowY.match(/auto|scroll/) && el.scrollHeight > el.clientHeight)) el = el.parentElement;
    return el ? el.scrollTop : window.scrollY;
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(after).toBeGreaterThan(before + 100);
});

test("notion: letting go outside the editor moves nothing; + then Esc leaves the page as it was", async ({ page, request }) => {
  await open(page, request, "Alpha\n\nBeta");
  // Drag Beta far to the left (over the sidebar), level with Alpha, and let go.
  const a = (await row(page, "p", "Alpha").boundingBox())!;
  await drag(page, row(page, "p", "Beta"), { x: 20, y: a.y + 4 });
  await expect.poll(() => texts(page)).toEqual(["Alpha", "Beta"]);
  // + opens the / menu; Esc takes back what it wrote.
  await row(page, "p", "Alpha").hover();
  await row(page, "p", "Alpha").getByRole("button", { name: "Add a block below" }).click();
  await expect(page.getByRole("listbox", { name: "Blocks" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Blocks" })).toBeHidden();
  const md = await markdown(page);
  await expect(md).toHaveValue("Alpha\n\nBeta");
});
