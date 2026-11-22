import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { totp } from "../src/auth/totp";

/**
 * The CMS as a server of its own (`npx @mainsoft/agent-cms dev`), in a real
 * browser: the first admin with the setup code from the terminal, two-step
 * sign-in with an authenticator app, a passkey (Chrome's virtual
 * authenticator), inviting someone by email and their first sign-in, the
 * people screen, the dark theme, and signing out. E2E_SHOTS=<dir> keeps screenshots.
 */
const PORT = 3400;
// Passkeys need a host name (an IP address cannot be a WebAuthn RP id).
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS;
let server: ChildProcess;
let dir: string;
let lines = "";

test.describe.configure({ mode: "serial" });
test.use({ baseURL: BASE });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-cms-serve-"));
  server = spawn(process.execPath, [resolve(process.cwd(), "../dist/bin.js"), "dev", "--port", String(PORT), "--memory"], { cwd: dir, env: { ...process.env, PORT: String(PORT) } });
  server.stdout!.on("data", (b: Buffer) => (lines += b.toString()));
  server.stderr!.on("data", (b: Buffer) => (lines += b.toString()));
  for (let i = 0; i < 100 && !/setup code [A-Z0-9-]+/.test(lines); i++) await new Promise((r) => setTimeout(r, 100));
  expect(lines).toMatch(/setup code [A-Z0-9-]+/);
});
test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const ADMIN = { email: "owner@example.com", password: "violet tractor harbor 42" };
let secret = "";
let recovery: string[] = [];

test("serve: the first admin signs up with the setup code from the terminal", async ({ page }) => {
  const r = await page.request.get("/healthz");
  expect(r.status()).toBe(200);
  expect((await page.request.get("/admin")).headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/(login|setup)/);
  await expect(page.getByRole("heading", { name: "Create the first admin" })).toBeVisible();
  await page.getByLabel("Setup code").fill("WRONG-CODE");
  await page.getByLabel("Name").fill("Olivia Owner");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("short");
  await expect(page.getByRole("button", { name: "Create admin and sign in" })).toBeDisabled();
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin and sign in" }).click();
  await expect(page.getByText(/setup code is not right/)).toBeVisible();
  const code = /setup code ([A-Z0-9-]+)/.exec(lines)![1];
  await page.getByLabel("Setup code").fill(code);
  await shot(page, "s1-setup");
  await page.getByRole("button", { name: "Create admin and sign in" }).click();
  await expect(page.getByRole("heading", { name: "My account" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Account menu of Olivia Owner/ })).toBeVisible();
});

test("serve: two-step sign-in with an authenticator app, recovery codes, and a passkey", async ({ page, context }) => {
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto("/admin/account#two-step");
  await page.getByRole("button", { name: "Set up", exact: true }).click();
  // Changing how you sign in asks who you are first (a fresh sign-in counts for 10 minutes).
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /QR code/ })).toBeVisible();
  secret = ((await dialog.locator("code").innerText()) ?? "").replace(/\s+/g, "");
  await shot(page, "s2-totp-setup");
  await dialog.getByLabel("Code from the app").fill(totp(secret, Date.now()));
  await dialog.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog.getByRole("heading", { name: "Keep your recovery codes" })).toBeVisible();
  await expect(dialog.locator("ol li")).toHaveCount(10);
  recovery = await dialog.locator("ol li").allInnerTexts();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeDisabled();
  await dialog.getByLabel("I have kept these codes somewhere safe").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("10 of 10 left")).toBeVisible();

  // A passkey, with Chrome's virtual authenticator.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByLabel("Passkey name")).toBeVisible();
  await page.getByLabel("Passkey name").fill("Test laptop");
  await page.getByLabel("Passkey name").press("Enter");
  await expect(page.getByText("Test laptop")).toBeVisible();
  await shot(page, "s3-account");

  // Signed out, then in with the passkey alone: no password, no code.
  await page.getByRole("button", { name: /Account menu of/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("button", { name: /Account menu of Olivia Owner/ })).toBeVisible();
});

test("serve: password sign-in asks for the 6-digit code; a wrong one is refused", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("not the password at all");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Wrong email or password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await page.getByLabel("Code").fill("000000");
  await expect(page.getByText(/That code is not right/)).toBeVisible();
  await shot(page, "s4-code");
  await page.getByLabel("Code").fill(totp(secret, Date.now() + 30_000));
  await expect(page.getByRole("button", { name: /Account menu of Olivia Owner/ })).toBeVisible();
});

test("serve: invite by email, accept the link in another browser, show up on People", async ({ page, browser }) => {
  await signIn(page, ADMIN.email, ADMIN.password, true);
  await page.goto("/admin/people");
  await page.getByRole("button", { name: "Invite people" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Emails").fill("writer@example.com, ");
  await expect(d.getByText("writer@example.com")).toBeVisible();
  await d.getByRole("radio", { name: "Copy links" }).click();
  await shot(page, "s5-invite");
  await d.getByRole("button", { name: "Make 1 links" }).click();
  const link = await d.locator("code").first().getAttribute("title");
  expect(link).toMatch(/\/admin\/invite#/);
  await d.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Not accepted yet")).toBeVisible();

  const other = await browser.newContext({ baseURL: BASE });
  const p2 = await other.newPage();
  await p2.goto(link!.replace(/^https?:\/\/[^/]+/, BASE));
  await expect(p2.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(p2.getByLabel("Email")).toHaveValue("writer@example.com");
  await p2.getByLabel("Name").fill("Wendy Writer");
  await p2.getByLabel("Password", { exact: true }).fill("copper lantern meadow 77");
  await p2.getByRole("button", { name: "Set password and start" }).click();
  await expect(p2.getByRole("button", { name: /Account menu of Wendy Writer/ })).toBeVisible();
  // The link works once.
  const p3 = await (await browser.newContext({ baseURL: BASE })).newPage();
  await p3.goto(link!.replace(/^https?:\/\/[^/]+/, BASE));
  await expect(p3.getByRole("heading", { name: "Invitation not valid" })).toBeVisible();
  await other.close();

  await page.reload();
  await expect(page.getByText("Wendy Writer")).toBeVisible();
  await expect(page.getByText("Password only", { exact: true })).toBeVisible();
  await expect(page.getByText(/Signing in with a password only: 1/)).toBeVisible();
  await shot(page, "s6-people");
});

test("serve: the dark theme follows the choice everywhere, also after a reload", async ({ page }) => {
  await signIn(page, ADMIN.email, ADMIN.password, true);
  await page.goto("/admin/posts");
  await page.getByRole("button", { name: /Account menu of/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await shot(page, "s7-dark");
});

async function signIn(page: Page, email: string, password: string, withCode = false) {
  await page.goto("/admin/login");
  if (await page.getByRole("button", { name: /Account menu of/ }).isVisible().catch(() => false)) return;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (withCode || secret) {
    const step = page.getByRole("heading", { name: "Two-step sign-in" });
    if (await step.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
      // App codes are used up within their window by the earlier tests: a recovery code (each works once).
      await page.getByRole("button", { name: /Use a recovery code/ }).click();
      await page.getByLabel("Recovery code").fill(recovery.shift()!);
      await page.getByRole("button", { name: "Confirm" }).click();
    }
  }
  await expect(page.getByRole("button", { name: /Account menu of/ }).or(page.getByRole("heading", { name: "My account" }))).toBeVisible();
}
