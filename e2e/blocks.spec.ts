import { expect, test, type Page } from "./fixtures";

// The block editor in a real browser: markdown in, blocks on screen, markdown out.
const api = "/api/cms";
const shot = (name: string) => (process.env.E2E_SHOTS ? { path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: false } : undefined);
const mod = process.platform === "darwin" ? "Meta" : "Control";
const body = ["## Plans", "", "Pick *one* plan, **today**.", "", "- [x] Write the copy", "- [ ] Check the numbers", "", ":::html", '<div class="card">Hello</div>', ":::", "", "Last line."].join("\n");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("cms-body-view", JSON.stringify("blocks")));
});

const line = (page: Page, type: string, text?: string) => page.locator(`.cms-blocks [data-block-type=${type}] [role=textbox]`, text ? { hasText: text } : undefined).first();
const markdown = async (page: Page) => {
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  return page.locator("#cms-editor-body");
};
async function open(page: Page, request: import("@playwright/test").APIRequestContext, text: string, publish = false) {
  const slug = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const made = await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: "Blocks", category: "News", body: text }, publish } });
  expect(made.status()).toBe(201);
  await page.goto(`/admin/posts/${slug}`);
  await expect(page.locator(".cms-blocks [role=textbox]").first()).toBeVisible({ timeout: 20_000 });
  return slug;
}

test("blocks: a document opens as blocks in one column, is not saved by opening, and typing writes markdown back", async ({ page, request }) => {
  const slug = await open(page, request, body, true);
  await expect(line(page, "h2", "Plans")).toBeVisible();
  await expect(page.locator(".cms-blocks em", { hasText: "one" })).toBeVisible();
  await expect(page.locator(".cms-blocks [data-block-type=todo] [role=checkbox]").first()).toHaveAttribute("aria-checked", "true");
  // HTML has no block of its own: drawn as it will look, edited as markdown on request.
  await expect(page.frameLocator("[data-cms-source=html] iframe").getByText("Hello")).toBeVisible();
  // One column: no preview pane beside the blocks.
  await expect(page.getByRole("region", { name: "Preview" })).toHaveCount(0);
  await page.screenshot(shot("90-blocks-editor"));
  await page.waitForTimeout(1500);
  const before = (await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { version: number } };
  expect(before.doc.version).toBe(1);

  await line(page, "p", "Last line.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" More words");
  const md = await markdown(page);
  await expect(md).toHaveValue(/Last line\. More words$/);
  // Untouched blocks keep their text exactly.
  await expect(md).toHaveValue(/:::html\n<div class="card">Hello<\/div>\n:::/);
  await expect(md).toHaveValue(/^## Plans\n\nPick \*one\* plan, \*\*today\*\*\./);
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(async () => ((await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { body: string } }).doc.body, { timeout: 10_000 }).toContain("Last line. More words");
});

test("blocks: markdown shortcuts, the toolbar, Enter and Backspace, undo", async ({ page, request }) => {
  await open(page, request, "Start");
  await line(page, "p", "Start").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Heading");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // an empty item ends the list
  await page.keyboard.type("[] task");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Say **hi** and `code` now");
  await expect(line(page, "h2", "Heading")).toBeVisible();
  await expect(page.locator(".cms-blocks [data-block-type=bullet]")).toHaveCount(2);
  await expect(page.locator(".cms-blocks strong", { hasText: "hi" })).toBeVisible();
  await expect(page.locator(".cms-blocks code", { hasText: "code" })).toBeVisible();

  // Select a word and make it italic from the toolbar.
  const last = line(page, "p", "Say");
  await last.evaluate((el) => {
    const t = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent!.includes("now"))!;
    const r = document.createRange();
    const i = t.textContent!.indexOf("now");
    r.setStart(t, i);
    r.setEnd(t, i + 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  const bar = page.getByRole("toolbar", { name: "Text formatting" });
  await expect(bar).toBeVisible();
  await page.screenshot(shot("94-blocks-toolbar"));
  await bar.getByRole("button", { name: "Italic" }).click();
  await expect(page.locator(".cms-blocks em", { hasText: "now" })).toBeVisible();

  // Backspace at the start of a heading makes it text; again merges it into the line above.
  await line(page, "h2", "Heading").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(line(page, "p", "Heading")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(line(page, "p", "StartHeading")).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(line(page, "p", "Heading")).toBeVisible();

  const md = await markdown(page);
  await expect(md).toHaveValue("Start\n\nHeading\n\n- one\n- two\n\n- [ ] task\n\nSay **hi** and `code` *now*");
});

test("blocks: the slash menu makes real columns, block selection", async ({ page, request }) => {
  await open(page, request, "First.\n\nSecond.");
  await line(page, "p", "First.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const menu = page.getByRole("listbox", { name: "Blocks" });
  await expect(menu.getByText("Two columns")).toBeVisible();
  await page.screenshot(shot("91-blocks-slash"));
  await page.keyboard.type("colu");
  await page.keyboard.press("Enter");
  // Two columns with a line in each; the caret is in the first.
  await expect(page.locator(".cms-blocks [data-col-id]")).toHaveCount(2);
  await page.keyboard.type("Left side");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Right side");
  await expect(page.locator(".cms-blocks [data-col-id]").nth(1)).toContainText("Right side");

  // Esc selects the block, Shift+↓ adds the next, Delete removes both, undo brings them back.
  await line(page, "p", "First.").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".cms-blocks [data-block-id][aria-selected=true]")).toHaveCount(2);
  await page.keyboard.press("Delete");
  await expect(line(page, "p", "First.")).toHaveCount(0);
  // A column left alone is a plain block again.
  await expect(page.locator(".cms-blocks [data-col-id]")).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(line(page, "p", "First.")).toBeVisible();
  const md = await markdown(page);
  await expect(md).toHaveValue("First.\n\n:::columns\n:::col\nLeft side\n:::col\nRight side\n:::\n\nSecond.");
});

test("blocks: moving a block with the keyboard and the handle menu", async ({ page, request }) => {
  await open(page, request, "Alpha\n\nBeta\n\nGamma");
  await line(page, "p", "Gamma").click();
  await page.keyboard.press(`${mod}+Shift+ArrowUp`);
  await page.keyboard.press(`${mod}+Shift+ArrowUp`);
  const texts = () => page.locator(".cms-blocks [data-block-type=p] [role=textbox]").allInnerTexts();
  await expect.poll(texts).toEqual(["Gamma", "Alpha", "Beta"]);
  await line(page, "p", "Beta").hover();
  await page.locator('[data-block-type=p]:has-text("Beta") button[aria-label^="Drag to move"]').click();
  await page.getByRole("option", { name: /Heading/ }).first().click();
  await expect(line(page, "h2", "Beta")).toBeVisible();
});

test("blocks: the preview opens in its own window and follows the typing", async ({ page, request }) => {
  await open(page, request, "Hello preview");
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview in a new window" }).click();
  const win = await popup;
  await expect(win.getByText("Hello preview")).toBeVisible();
  await expect(win.getByText("Live preview: follows your edits")).toBeVisible();
  await line(page, "p", "Hello preview").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(win.getByText("Hello preview and more")).toBeVisible();
  await win.screenshot(shot("95-preview-window"));
  await win.close();
  await expect(page.getByRole("button", { name: "Preview in a new window" })).toHaveAttribute("aria-pressed", "false");
});

test("blocks: full screen covers the admin, keeps the fields one click away, and Esc leaves it", async ({ page, request }) => {
  const slug = await open(page, request, "First line.\n\nSecond line.");
  const nav = page.getByRole("navigation").first();
  await expect(nav).toBeVisible();
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  const region = page.getByRole("region", { name: "Full screen editing" });
  await expect(region).toBeVisible();
  // Covers the window: the sidebar is under it, the fields are folded away, the page behind does not scroll.
  const box = await region.boundingBox();
  const vp = page.viewportSize()!;
  expect(box && Math.round(box.x) === 0 && Math.round(box.width) === vp.width && Math.round(box.height) === vp.height).toBe(true);
  await expect(page.locator("#cms-focus-fields")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
  await page.screenshot(shot("96-focus"));

  // Typing works and fades the bar; Esc inside the text selects the block, it does not leave.
  await line(page, "p", "Second line.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed in full screen.");
  await expect(page.getByRole("button", { name: "Leave full screen" }).locator("xpath=..")).toHaveClass(/opacity-0/);
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(page.getByRole("button", { name: "Leave full screen" }).locator("xpath=..")).not.toHaveClass(/opacity-0/);

  // The fields open under the bar and keep what was typed.
  await page.getByRole("button", { name: "Fields" }).click();
  await expect(page.locator("#cms-focus-fields")).toBeVisible();
  await page.screenshot(shot("97-focus-fields"));

  // Save from the bar.
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(async () => ((await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { body: string } }).doc.body, { timeout: 10_000 }).toContain("Typed in full screen.");

  // Esc while typing selects the block (editor), a second Esc with no text focus leaves full screen.
  await line(page, "p", "First line.").click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(region).toHaveCount(0);
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");

  // The shortcut goes both ways, even from inside the text.
  await line(page, "p", "First line.").click();
  await page.keyboard.press(`${mod}+Shift+f`);
  await expect(page.getByRole("region", { name: "Full screen editing" })).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+f`);
  await expect(page.getByRole("region", { name: "Full screen editing" })).toHaveCount(0);
});

test("blocks: Korean typing (IME) lands as one word @mobile", async ({ page, request }) => {
  await open(page, request, "가");
  await line(page, "p", "가").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("나다라");
  const md = await markdown(page);
  await expect(md).toHaveValue("가나다라");
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
