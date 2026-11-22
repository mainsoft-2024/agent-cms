import { deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";

/**
 * Layout checks shared by the example app's and the docs app's browser tests: what sticks
 * out of the page, a dialog or a clipping box; controls drawn over each other; native
 * selects with the browser's arrow; icons too faint to see; and page errors.
 */
/** Buttons that change things are not pressed while exploring. */
export const RISKY = /delete|trash|remove|purge|revoke|unpublish|publish|rotate|restore|sign out|log ?out|discard|apply|reject|run|test|send|archive|duplicate|save|upload|import|export|download|copy|empty|disable|enable|retry|refresh|leave|close|cancel|next|previous|load more|theme|full screen|move up|move down|merge|approve|request|resolve|reset|clear|select all|undo|redo|logout|turn|switch|show|hide|dismiss|bold|italic|strike|code|link|keep|use this|create|add|new folder|confirm|done|back|^$/i;

export interface Problem {
  page: string;
  width: string;
  where: string;
  kind: string;
  detail: string;
}

export function png(w: number, h: number): Buffer {
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
export async function measure(page: Page): Promise<{ where: string; kind: string; detail: string }[]> {
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
    // Controls drawn on top of each other (e.g. a dialog's close button over a header button).
    const visible = (el: Element) => {
      const cs = style(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight && !(cs.position === "absolute" && cs.clip !== "auto");
    };
    const controls = Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=checkbox], [role=switch]"))
      .filter((el) => visible(el) && !el.closest("[aria-hidden=true]") && !el.closest(".sr-only"))
      .slice(0, 400);
    // Only what is on top: with a modal open, the page behind it does not count.
    const modal = document.querySelector("[role=dialog][aria-modal=true], [role=alertdialog]");
    const top = modal ? controls.filter((el) => modal.contains(el)) : controls;
    // A sticky bar or a fixed layer is drawn over the content scrolling under it on purpose:
    // only controls in the same layer can collide.
    const layerOf = (el: Element): Element | null => {
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        const pos = style(a).position;
        if (pos === "sticky" || pos === "fixed") return a;
      }
      return null;
    };
    for (let i = 0; i < top.length; i++) {
      const a = top[i];
      const ra = a.getBoundingClientRect();
      for (let j = i + 1; j < top.length; j++) {
        const b = top[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (layerOf(a) !== layerOf(b)) continue;
        // A control inside a label, or an input with its own button inside the same field, is fine when one wraps the other's area.
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w <= 4 || h <= 4) continue;
        const inside = (x: DOMRect, y: DOMRect) => x.left >= y.left - 1 && x.right <= y.right + 1 && x.top >= y.top - 1 && x.bottom <= y.bottom + 1;
        // A small control laid over a corner of a bigger one on purpose (the select box on a
        // thumbnail) sits wholly inside it and is positioned absolutely: that is a design, not a collision.
        const overlay = (x: Element, rx: DOMRect, ry: DOMRect) => style(x).position === "absolute" && inside(rx, ry) && rx.width * rx.height < (ry.width * ry.height) / 4;
        if (overlay(a, ra, rb) || overlay(b, rb, ra)) continue;
        // An icon button placed inside an input (search clear, show password) is meant.
        if ((a.tagName === "INPUT" && inside(rb, ra)) || (b.tagName === "INPUT" && inside(ra, rb))) continue;
        const key = `${name(a)}|${name(b)}`;
        if (seen.has(a) && seen.has(b)) continue;
        seen.add(a);
        seen.add(b);
        out.push({ where: key, kind: "controls-overlap", detail: `${Math.round(w)}x${Math.round(h)}px` });
      }
    }
    // Native selects must use our own arrow (browsers drew a white arrow on light pages).
    for (const el of Array.from(document.querySelectorAll("select"))) {
      if (!visible(el)) continue;
      const cs = style(el);
      if (cs.appearance !== "none" && (cs as unknown as { webkitAppearance?: string }).webkitAppearance !== "none") out.push({ where: name(el), kind: "native-select-arrow", detail: `appearance: ${cs.appearance}` });
    }
    // Icons and text too faint to see against what is behind them.
    // Any CSS color (rgb, oklch, …) to [r, g, b, a] by painting one pixel.
    const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const colors = new Map<string, number[]>();
    const rgb = (c: string): number[] => {
      if (colors.has(c)) return colors.get(c)!;
      px.clearRect(0, 0, 1, 1);
      px.fillStyle = "#000";
      px.fillStyle = c;
      px.fillRect(0, 0, 1, 1);
      const d = px.getImageData(0, 0, 1, 1).data;
      const v = d[3] === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], d[3] / 255];
      colors.set(c, v);
      return v;
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backOf = (el: Element): number[] => {
      let base = [255, 255, 255];
      const layers: number[][] = [];
      for (let a: Element | null = el; a; a = a.parentElement) {
        const c = rgb(style(a).backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0) {
          layers.push(c);
          if ((c[3] ?? 1) >= 0.99) break;
        }
      }
      for (const c of layers.reverse()) {
        const al = c[3] ?? 1;
        base = base.map((v, k) => v * (1 - al) + c[k] * al);
      }
      return base;
    };
    let faint = 0;
    for (const el of Array.from(document.querySelectorAll("svg.lucide, svg[class*=lucide], button svg, [role=button] svg")).slice(0, 600)) {
      if (!visible(el) || faint > 20) continue;
      const fg = rgb(style(el).color);
      if (fg.length < 3) continue;
      const bg = backOf(el);
      const al = fg[3] ?? 1;
      const mixed = bg.map((v, k) => v * (1 - al) + fg[k] * al);
      const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      if (ratio < 1.6) {
        faint++;
        out.push({ where: name(el.parentElement ?? el), kind: "faint-icon", detail: `contrast ${ratio.toFixed(2)}` });
      }
    }
    return out;
  });
}

/** `check(page, label, width)` measures (and screenshots with `shots`); `explore` opens what harmless buttons open. */
export function layoutChecker(o: { shots?: string; problems?: Problem[] } = {}) {
const SHOTS = o.shots;
const problems: Problem[] = o.problems ?? [];
let shotN = 0;
async function check(page: Page, label: string, width: string) {
  console.log(`[layout] ${width} ${label}`);
  await page.waitForTimeout(250);
  const t0 = Date.now();
  const found = await Promise.race([measure(page), new Promise<{ where: string; kind: string; detail: string }[]>((r) => setTimeout(() => r([{ where: "page", kind: "measure-timeout", detail: "the page did not answer in 20 s" }]), 20_000))]);
  console.log(`[layout]   measured in ${Date.now() - t0} ms, ${found.length} problems`);
  // A crashed screen (the framework's error page) and errors thrown since the last check.
  const crashed = await page.getByText(/Application error|Unhandled Runtime Error|client-side exception/).count().catch(() => 0);
  if (crashed) found.push({ where: "page", kind: "error-page", detail: "the framework's error page is showing" });
  for (const e of errors.splice(0)) found.push({ where: "page", kind: "page-error", detail: e });
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
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("main button, main [role=combobox], header button, aside [data-cms-account] button, [role=dialog] [data-cms-account] button"))) {
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
    const q = name.replace(/"/g, '\\"');
    const b = page.locator("main button:visible, main [role=combobox]:visible, header button:visible").filter({ hasText: name }).or(page.locator(`main [aria-label="${q}"]:visible, header [aria-label="${q}"]:visible, [data-cms-account] [aria-label="${q}"]:visible`)).first();
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
/** Uncaught errors in the page (a menu that throws when it opens) are problems too. */
const errors: string[] = [];
function watch(page: Page) {
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 300)));
}
return { check, explore, problems, watch, errors };
}
