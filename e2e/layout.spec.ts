import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "./fixtures";

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

/** Buttons that change things are not pressed while exploring. */
const RISKY = /delete|trash|remove|purge|revoke|unpublish|publish|rotate|restore|sign out|log ?out|discard|apply|reject|run|test|send|archive|duplicate|save|upload|import|export|download|copy|empty|disable|enable|retry|refresh|leave|close|cancel|next|previous|load more|theme|full screen|move up|move down|merge|approve|request|resolve|reset|clear|select all|undo|redo|logout|turn|switch|show|hide|dismiss|bold|italic|strike|code|link|keep|use this|create|add|new folder|confirm|done|back|^$/i;

interface Problem {
  page: string;
  width: string;
  where: string;
  kind: string;
  detail: string;
}

function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => (b.reduce((c, x) => crcTable[(c ^ x) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + w * 3, 0x88);
  row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Runs in the page: what sticks out where. */
async function measure(page: Page): Promise<{ where: string; kind: string; detail: string }[]> {
  return page.evaluate(() => {
    const out: { where: string; kind: string; detail: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const name = (el: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = el, i = 0; e && i < 3; e = e.parentElement, i++) {
        const id = e.id ? `#${e.id}` : "";
        const label = e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : "";
        const cls = typeof e.className === "string" ? `.${e.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")}` : "";
        parts.unshift(`${e.tagName.toLowerCase()}${id}${label}${cls === "." ? "" : cls}`);
      }
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
      return `${parts.join(" > ")}${text ? ` "${text}"` : ""}`;
    };
    const scrolls = (cs: CSSStyleDeclaration) => /(auto|scroll)/.test(cs.overflowX);
    const clipsX = (cs: CSSStyleDeclaration) => /(hidden|clip)/.test(cs.overflowX);
    if (document.documentElement.scrollWidth > vw + 1) out.push({ where: "page", kind: "page-scrolls-sideways", detail: `${document.documentElement.scrollWidth} > ${vw}` });
    const seen = new Set<Element>();
    const inSeen = (el: Element) => {
      for (let a: Element | null = el; a; a = a.parentElement) if (seen.has(a)) return true;
      return false;
    };
    // Style of each box is read once.
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (el: Element) => {
      let cs = styles.get(el);
      if (!cs) styles.set(el, (cs = getComputedStyle(el)));
      return cs;
    };
    for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 6000)) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const cs = style(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (cs.position === "absolute" && cs.clip !== "auto") continue; // sr-only
      // The nearest box that bounds it: a scrolling box (fine), a clipping box, or a dialog / popover.
      let bound: Element | null = null;
      let kind = "";
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const acs = style(a);
        if (scrolls(acs)) {
          bound = null;
          kind = "scroll";
          break;
        }
        if (clipsX(acs)) {
          bound = a;
          kind = "clipped";
          break;
        }
        const role = a.getAttribute("role");
        if (role === "dialog" || role === "alertdialog" || role === "menu" || role === "listbox" || a.hasAttribute("data-radix-popper-content-wrapper")) {
          bound = a;
          kind = "outside-dialog";
          break;
        }
      }
      if (kind === "scroll") continue;
      const limit = bound ? bound.getBoundingClientRect() : { left: 0, right: vw };
      const past = Math.round(r.right - limit.right);
      const before = Math.round(limit.left - r.left);
      if ((past > 2 || before > 2) && !inSeen(el)) {
        // Text cut with an ellipsis is meant; a clipped box that is the scroll area's child is not.
        if (!(kind === "clipped" && (cs.textOverflow === "ellipsis" || (bound && style(bound).textOverflow === "ellipsis")))) {
          seen.add(el);
          out.push({ where: name(el), kind: bound ? kind : "outside-viewport", detail: past > 2 ? `${past}px past the right edge` : `${before}px past the left edge` });
        }
      }
      // A long word spilling out of its own box.
      if (!clipsX(cs) && !scrolls(cs) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0) && cs.display !== "inline") {
        if (!inSeen(el)) {
          seen.add(el);
          out.push({ where: name(el), kind: "text-spills", detail: `${el.scrollWidth} > ${el.clientWidth}` });
        }
      }
    }
    return out;
  });
}

const problems: Problem[] = [];
let shotN = 0;
async function check(page: Page, label: string, width: string) {
  console.log(`[layout] ${width} ${label}`);
  await page.waitForTimeout(250);
  const t0 = Date.now();
  const found = await Promise.race([measure(page), new Promise<{ where: string; kind: string; detail: string }[]>((r) => setTimeout(() => r([{ where: "page", kind: "measure-timeout", detail: "the page did not answer in 20 s" }]), 20_000))]);
  console.log(`[layout]   measured in ${Date.now() - t0} ms, ${found.length} problems`);
  for (const f of found) problems.push({ page: label, width, ...f });
  if (SHOTS) {
    shotN++;
    const file = `${SHOTS}/${String(shotN).padStart(3, "0")}-${width}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`;
    await Promise.race([page.screenshot({ path: file, fullPage: !label.includes("›"), timeout: 15_000 }).catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]);
  }
  if (!SHOTS) expect(found, `${label} at ${width}`).toEqual([]);
}

/** Opens what each harmless button opens (dialogs, menus, popovers), checks it, closes it. */
async function explore(page: Page, label: string, width: string) {
  const url = page.url();
  // Names first (in the page, no waiting), then each one found again by its name.
  const names: string[] = await page.evaluate((risky) => {
    const re = new RegExp(risky, "i");
    const out: string[] = [];
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("main button, main [role=combobox], header button"))) {
      if (!b.offsetParent || (b as HTMLButtonElement).disabled) continue;
      const role = b.getAttribute("role");
      if (role === "radio" || role === "tab" || role === "checkbox" || role === "switch") continue;
      const name = (b.getAttribute("aria-label") ?? b.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (!name || re.test(name) || out.includes(name)) continue;
      out.push(name);
    }
    return out.slice(0, 30);
  }, RISKY.source);
  const started = Date.now();
  for (const name of names) {
    console.log(`[layout]   try ${name}`);
    if (Date.now() - started > 90_000) break;
    const b = page.locator("main button:visible, main [role=combobox]:visible, header button:visible").filter({ hasText: name }).or(page.locator(`main [aria-label="${name.replace(/"/g, '\\"')}"]:visible, header [aria-label="${name.replace(/"/g, '\\"')}"]:visible`)).first();
    await b.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    const open = page.locator("[role=dialog]:visible, [role=alertdialog]:visible, [role=menu]:visible, [role=listbox]:visible");
    if ((await open.count()) > 0) await check(page, `${label} › ${name}`, width);
    for (let k = 0; k < 3 && (await open.count()) > 0; k++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    if (page.url() !== url || (await open.count()) > 0) await page.goto(url, { timeout: 20_000 }).catch(() => undefined);
  }
}

test.describe.configure({ mode: "serial" });

test("layout: nothing sticks out on any admin screen, dialog or panel, at four widths, with long names everywhere", async ({ page, request }) => {
  test.setTimeout(40 * 60_000);
  // Leaving an editor with changes asks first; the audit always leaves.
  page.on("dialog", (d) => void d.accept().catch(() => undefined));
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
