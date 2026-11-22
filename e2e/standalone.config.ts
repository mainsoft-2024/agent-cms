import { defineConfig, devices } from "@playwright/test";

// The standalone server (`agent-cms dev`) starts inside the spec; no app to build.
export default defineConfig({
  testDir: ".",
  testMatch: /standalone\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  reporter: [["line"]],
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
