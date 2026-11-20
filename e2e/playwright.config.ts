import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// Browser tests against examples/next (Next 14 + pglite), built from this repo's dist.
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: `npm --prefix ../examples/next run build && npm --prefix ../examples/next run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}/api/cms/_me`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    // The cron route needs a secret; the webhook test sends to the example's own receiver on localhost.
    env: { CMS_CRON_SECRET: process.env.CMS_CRON_SECRET ?? "e2e-cron-secret-e2e-cron-secret", CMS_WEBHOOKS_INSECURE: "1" },
  },
});
