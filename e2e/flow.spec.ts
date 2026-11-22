import { expect, test, type APIRequestContext } from "./fixtures";

// The publishing flow in a real browser: schedule, review, comments, trash, releases.
const api = "/api/cms";
const BODY = "## Connect\n\n1. Open settings.\n2. Press Add.\n\n## Disconnect\n\nPress remove.";

async function createDoc(request: APIRequestContext, collection: string, slug: string, o: { publish?: boolean; headers?: Record<string, string> } = {}) {
  const r = await request.post(`${api}/collections/${collection}`, { data: { doc: { slug, title: `T ${slug}`, body: BODY }, publish: o.publish }, headers: o.headers });
  expect(r.status()).toBe(201);
}

test("schedule from the publish button, then cancel", async ({ page, request }) => {
  const slug = `sched-${Date.now()}`;
  await createDoc(request, "posts", slug);
  await page.goto(`/admin/posts/${slug}`);
  await page.getByRole("button", { name: "Publish options" }).click();
  const panel = page.getByRole("dialog", { name: "Schedule publishing" });
  await expect(panel.getByText("Asia/Seoul")).toBeVisible();
  await panel.getByLabel("Publish at: Date", { exact: true }).fill("2099-11-24");
  await panel.getByLabel("Publish at: Time", { exact: true }).fill("09:00");
  await panel.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText(/v1 goes out/)).toBeVisible();
  const doc = (await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { schedule: { publishAt: string } } };
  expect(doc.doc.schedule.publishAt).toBe("2099-11-24T00:00:00.000Z");
  await page.goto("/admin/posts");
  await page.getByRole("radio", { name: /Scheduled/ }).click();
  await expect(page.getByRole("link", { name: `T ${slug}` }).first()).toBeVisible();
  await page.goto(`/admin/posts/${slug}`);
  await page.getByRole("button", { name: "Cancel schedule" }).click();
  await expect(page.getByText(/v1 goes out/)).toHaveCount(0);
});

test("an agent's guide waits for a person: approve and publish", async ({ page, request }) => {
  const slug = `review-${Date.now()}`;
  const key = (await (await request.post(`${api}/keys`, { data: { name: `bot-${slug}`, scopes: ["read", "write", "publish"] } })).json()) as { secret: string };
  const headers = { authorization: `Bearer ${key.secret}` };
  await createDoc(request, "guide", slug, { headers });
  const refused = await request.post(`${api}/collections/guide/${slug}/publish`, { data: {}, headers });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toBe("review_required");
  expect((await request.post(`${api}/collections/guide/${slug}/review/request`, { data: { note: "Please check" }, headers })).ok()).toBe(true);
  await page.goto(`/admin/guide/${slug}`);
  await expect(page.getByText(`bot-${slug} asked for a review of v1`)).toBeVisible();
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Published v1/ }).first()).toBeVisible();
});

test("comment on selected text; the mark sits behind the text", async ({ page, request }) => {
  const slug = `cm-${Date.now()}`;
  await createDoc(request, "posts", slug);
  await page.goto(`/admin/posts/${slug}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Markdown", exact: true });
  await box.evaluate((el: HTMLTextAreaElement) => {
    const at = el.value.indexOf("2. Press Add.");
    el.focus();
    el.setSelectionRange(at, at + 13);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  const panel = page.getByRole("complementary", { name: "Comments" });
  await panel.getByLabel("Write a comment").fill("Is this the button name?");
  await expect(panel.getByText("On the selected text")).toBeVisible();
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.getByText("Is this the button name?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Comments 1" })).toBeVisible();
  // The mark is drawn where the text is: same left edge and line as the text box would put it.
  const mark = page.locator("[data-cms-backdrop] mark");
  await expect(mark).toHaveText("2. Press Add.");
  const [m, b] = [await mark.boundingBox(), await box.boundingBox()];
  const pad = await box.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(Math.abs(m!.x - (b!.x + pad))).toBeLessThan(2);
  const font = await page.locator("[data-cms-backdrop]").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toBe(await box.evaluate((el) => getComputedStyle(el).fontFamily));
});

test("a deleted document waits in the trash and comes back published", async ({ page, request }) => {
  const slug = `trash-${Date.now()}`;
  await createDoc(request, "posts", slug, { publish: true });
  expect((await request.delete(`${api}/collections/posts/${slug}`)).ok()).toBe(true);
  expect((await request.get(`/posts/${slug}`)).status()).toBe(404);
  await page.goto("/admin/trash");
  await page.getByRole("checkbox", { name: `Select T ${slug}` }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored 1")).toBeVisible();
  expect((await request.get(`/posts/${slug}`)).status()).toBe(200);
});

test("a release publishes its documents together", async ({ page, request }) => {
  const stamp = Date.now();
  await createDoc(request, "posts", `rel-a-${stamp}`);
  await createDoc(request, "posts", `rel-b-${stamp}`);
  await page.goto("/admin/releases");
  await page.getByRole("button", { name: "New release" }).click();
  await page.getByLabel("Name").fill(`Release ${stamp}`);
  await page.getByRole("dialog").getByRole("button", { name: "New release" }).click();
  await expect(page).toHaveURL(/\/admin\/releases\/[\w-]+$/);
  await page.getByRole("button", { name: "Add documents" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Find a document").fill(`rel-`);
  await dlg.getByRole("checkbox", { name: new RegExp(`T rel-a-${stamp}`) }).click();
  await dlg.getByRole("checkbox", { name: new RegExp(`T rel-b-${stamp}`) }).click();
  await dlg.getByRole("button", { name: "Add documents" }).click();
  await expect(page.getByText("2 documents")).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published the release")).toBeVisible();
  expect((await request.get(`/posts/rel-a-${stamp}`)).status()).toBe(200);
  expect((await request.get(`/posts/rel-b-${stamp}`)).status()).toBe(200);
});

test("phone: the trash and a release fit the screen @mobile", async ({ page, request }) => {
  const slug = `ph-${Date.now()}`;
  await createDoc(request, "posts", slug);
  await request.delete(`${api}/collections/posts/${slug}`);
  await page.goto("/admin/trash");
  await expect(page.getByText(`T ${slug}`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/admin/releases");
  await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a guest comments through a preview link that allows it", async ({ page, request }) => {
  const slug = `guest-${Date.now()}`;
  await createDoc(request, "posts", slug);
  const link = (await (await request.post(`${api}/collections/posts/${slug}/preview`, { data: { ttl: "1h", comments: true } })).json()) as { url: string };
  await page.goto(link.url);
  await expect(page.getByRole("status")).toHaveText("Draft preview");
  await page.getByLabel("Name").fill("Lee");
  await page.getByLabel("Write a comment").fill("Reads well");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Reads well")).toBeVisible();
  const all = (await (await request.get(`${api}/collections/posts/${slug}/comments`)).json()) as { comments: { authorKind: string; authorLabel: string; body: string }[] };
  expect(all.comments.map((c) => [c.authorKind, c.authorLabel, c.body])).toEqual([["guest", "Lee", "Reads well"]]);
  // A link without "Allow comments" shows no box.
  const plain = (await (await request.post(`${api}/collections/posts/${slug}/preview`, { data: { ttl: "1h" } })).json()) as { url: string };
  await page.goto(plain.url);
  await expect(page.getByRole("status")).toHaveText("Draft preview");
  await expect(page.getByLabel("Write a comment")).toHaveCount(0);
});

test("a paste from a web page lands as markdown and can be undone", async ({ page, request }) => {
  const slug = `paste-${Date.now()}`;
  await createDoc(request, "posts", slug);
  await page.goto(`/admin/posts/${slug}`);
  const box = page.getByRole("textbox", { name: "Markdown", exact: true });
  await expect(box).toHaveValue(BODY);
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const data = new DataTransfer();
    data.setData("text/html", '<h2>Pasted</h2><p>With <b>bold</b> and <span style="color:red">red</span>.</p>');
    data.setData("text/plain", "Pasted\nWith bold and red.");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box).toHaveValue(`${BODY}## Pasted\n\nWith **bold** and red.`);
  await expect(page.getByText("Pasted as markdown. Colours and font sizes were left out.")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(box).toHaveValue(BODY);
});

test("the text and the preview scroll together; a click in the preview finds the lines", async ({ page, request }) => {
  const slug = `sync-${Date.now()}`;
  // Twelve sections; every third has a paragraph long enough to wrap, so lines and pixels do not match one to one.
  const body = Array.from({ length: 12 }, (_, i) => `## Part ${i + 1}\n\n${"A sentence that fills the line and then some more. ".repeat((i + 1) % 3 === 0 ? 12 : 2).trim()}\n\n- one\n- two\n\n\`\`\`\nconst n = ${i + 1};\n\`\`\``).join("\n\n");
  expect((await request.post(`${api}/collections/posts`, { data: { doc: { slug, title: `T ${slug}`, body } } })).status()).toBe(201);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/admin/posts/${slug}`);
  const box = page.getByRole("textbox", { name: "Markdown", exact: true });
  await expect(box).toHaveValue(body);
  const preview = page.getByRole("region", { name: "Preview" }).locator("div.overflow-auto");
  const heading = (n: number) => preview.getByRole("heading", { name: `Part ${n}`, exact: true });
  /** How far below the top of the preview pane a heading sits. */
  const offset = async (n: number) => (await heading(n).boundingBox())!.y - (await preview.boundingBox())!.y;

  // The whole page does not scroll: the two panes do, each in its own box.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);

  // Text to preview: put "## Part 8" at the top of the text box (measured with a copy of the box, wraps included).
  await box.evaluate((el: HTMLTextAreaElement) => {
    const cs = getComputedStyle(el);
    const copy = document.createElement("div");
    copy.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${el.clientWidth}px;font:${cs.font};line-height:${cs.lineHeight};padding:${cs.padding};letter-spacing:${cs.letterSpacing}`;
    const at = el.value.indexOf("## Part 8");
    copy.append(el.value.slice(0, at));
    const mark = document.createElement("span");
    mark.textContent = "x";
    copy.append(mark);
    document.body.append(copy);
    el.scrollTop = mark.offsetTop;
    copy.remove();
  });
  await expect.poll(() => offset(8)).toBeLessThan(24);
  expect(await offset(8)).toBeGreaterThan(-24);
  // Working in the body gave it the window: the info form is above, the header and the status line stay.
  await expect(page.getByRole("button", { name: "Save" })).toBeInViewport();
  await expect(page.getByText("No problems")).toBeInViewport();

  // The ends meet.
  await box.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => preview.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2);
  await page.waitForTimeout(250);

  // Preview to text: bring "Part 4" to the top of the preview; the text box shows its line at the top.
  await preview.evaluate((el) => {
    const h = [...el.querySelectorAll("h2")].find((x) => x.textContent === "Part 4")!;
    el.scrollTop += h.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  await page.waitForTimeout(250);
  const firstVisible = await box.evaluate((el: HTMLTextAreaElement) => {
    // The text of the line at the top of the box: walk lines until one starts below scrollTop.
    const cs = getComputedStyle(el);
    const copy = document.createElement("div");
    copy.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${el.clientWidth}px;font:${cs.font};line-height:${cs.lineHeight};padding:${cs.padding};letter-spacing:${cs.letterSpacing}`;
    const spans = el.value.split("\n").map((l) => {
      const s = document.createElement("span");
      s.textContent = `${l || " "}\n`;
      copy.append(s);
      return s;
    });
    document.body.append(copy);
    const hit = spans.find((s) => s.offsetTop >= el.scrollTop - 4);
    copy.remove();
    return hit?.textContent?.trim();
  });
  expect(firstVisible).toBe("## Part 4");

  // A click on a block in the preview selects its lines, and the preview stays where it was.
  await page.waitForTimeout(250);
  const before = await preview.evaluate((el) => el.scrollTop);
  await preview.getByText("const n = 5;").click();
  await expect.poll(() => box.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("```\nconst n = 5;\n```");
  await expect(box).toBeFocused();
  expect(Math.abs((await preview.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(2);
});

test("sections change order with the cards and the keyboard, and the order is saved", async ({ page, request }) => {
  const slug = `order-${Date.now()}`;
  await createDoc(request, "posts", slug);
  await page.goto(`/admin/posts/${slug}`);
  await expect(page.getByRole("textbox", { name: "Markdown", exact: true })).toHaveValue(BODY);
  await page.getByRole("button", { name: "Section order" }).click();
  const list = page.getByRole("list", { name: "Section order" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await list.getByRole("button", { name: "Move “Disconnect” up" }).click();
  await expect(page.getByText("Moved “Disconnect” to place 1 of 2")).toBeVisible();
  await expect(list.getByRole("listitem").first()).toContainText("Disconnect");
  // The preview follows at once.
  await expect(page.getByRole("region", { name: "Preview" }).getByRole("heading", { level: 2 }).first()).toHaveText("Disconnect");
  // Keyboard: focus stayed on the card that moved; its other arrow moves it back, Enter again moves it forward.
  await expect(list.getByRole("button", { name: "Move “Disconnect” down" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list.getByRole("listitem").first()).toContainText("Connect");
  await list.getByRole("button", { name: "Move “Disconnect” up" }).click();
  // Dragging a card with the mouse.
  await list.getByRole("listitem").nth(1).dragTo(list.getByRole("listitem").first(), { targetPosition: { x: 40, y: 3 } });
  await expect(list.getByRole("listitem").first()).toContainText("Connect");
  await list.getByRole("listitem").nth(1).dragTo(list.getByRole("listitem").first(), { targetPosition: { x: 40, y: 3 } });
  await expect(list.getByRole("listitem").first()).toContainText("Disconnect");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved v2/)).toBeVisible();
  const saved = (await (await request.get(`${api}/collections/posts/${slug}?draft=1`)).json()) as { doc: { body: string } };
  expect(saved.doc.body).toBe("## Disconnect\n\nPress remove.\n\n## Connect\n\n1. Open settings.\n2. Press Add.");
});
