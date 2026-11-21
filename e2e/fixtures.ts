import { test as base } from "@playwright/test";

// The older specs type into the markdown text box; the block editor has its own spec (blocks.spec.ts).
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (!window.localStorage.getItem("cms-body-view")) window.localStorage.setItem("cms-body-view", JSON.stringify("markdown"));
    });
    await use(page);
  },
});
export { expect } from "@playwright/test";
