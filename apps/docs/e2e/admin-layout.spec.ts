import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { layoutChecker } from "../../../e2e/layout-kit";

/**
 * The docs site's admin (Base UI components, not the example's Radix ones) on every screen
 * at a wide and a phone width: nothing sticks out or overlaps, selects use our arrow, icons
 * are visible, and opening the account menu or any harmless button does not crash the page.
 * LAYOUT_SHOTS=<dir> writes screenshots and a report instead of failing on the first page.
 */
const SHOTS = process.env.LAYOUT_SHOTS;
const WIDTHS = [
  { name: "wide", width: 1600, height: 1000 },
  { name: "phone", width: 390, height: 844 },
] as const;
const PAGES = ["/admin/dashboard", "/admin/docs", "/admin/docs/security", "/admin/docs/new", "/admin/releases", "/admin/trash", "/admin/keys", "/admin/audit", "/admin/webhooks", "/admin/automations", "/admin/roles", "/admin/transfer", "/admin/misses"];

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel(/Test user/).fill("member");
  await page.getByRole("button", { name: "Sign in (test)" }).click();
  await expect(page).toHaveURL(/\/admin\/docs$/);
}

test("admin layout: every screen, the account menu and what buttons open, wide and phone", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  page.on("dialog", (d) => void d.accept().catch(() => undefined));
  const { check, explore, problems, watch } = layoutChecker({ shots: SHOTS });
  watch(page);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await signIn(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    for (const p of PAGES) {
      await page.goto(p, { timeout: 30_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await check(page, p, w.name);
      // On a phone every list screen opens the menu from its header (the editor has a back button instead).
      if (w.name === "phone" && !/\/admin\/docs\/./.test(p)) {
        const menu = await page.locator("header").getByRole("button", { name: "Menu", exact: true }).first().isVisible().catch(() => false);
        if (!menu) problems.push({ page: p, width: w.name, where: "header", kind: "no-menu-button", detail: "no menu button on a phone" });
      }
      await explore(page, p, w.name);
    }
  }
  if (SHOTS) writeFileSync(`${SHOTS}/report.json`, JSON.stringify(problems, null, 1));
  expect(problems).toEqual([]);
});

test("admin: the account menu opens and every theme can be picked, wide and on a phone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/admin/docs");
    if (w.name === "phone") await page.getByRole("button", { name: /menu/i }).first().click();
    const trigger = page.getByRole("button", { name: /Account menu/i }).last();
    for (const theme of ["Dark", "Light", "System"]) {
      await trigger.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.getByRole("menuitemradio", { name: new RegExp(theme) }).click();
      await expect(page.getByRole("menu")).toBeHidden();
      if (w.name === "phone" && !(await trigger.isVisible())) await page.getByRole("button", { name: /menu/i }).first().click();
    }
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    // The account box at the bottom of the sidebar is opaque and flush with the bottom edge.
    const box = await page.locator("[data-cms-account]").filter({ visible: true }).first().boundingBox();
    expect(box && Math.abs(box.y + box.height - w.height) <= 1, `account box at the bottom at ${w.name}`).toBeTruthy();
  }
  await expect(page.getByText(/Application error|client-side exception/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
