import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);

// The docs site on pglite (seeded from content/), with the test login instead of GitHub.
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: `npm run build:registry && npx next build && npx next start -p ${PORT}`,
    cwd: "..",
    url: `http://localhost:${PORT}/llms.txt`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: {
      AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
      AUTH_TEST_LOGIN: "1",
      SITE_URL: `http://localhost:${PORT}`,
      CMS_PREVIEW_SECRET: "e2e-preview-secret-e2e-preview-secret",
      CRON_SECRET: "e2e-cron-secret-e2e-cron-secret",
    },
  },
});
