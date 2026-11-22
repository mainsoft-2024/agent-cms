import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsKeys } from "../cms/cms-keys";
import { CmsAudit } from "../cms/cms-audit";
import { CmsVersions } from "../cms/cms-versions";
import { CmsCommand } from "../cms/cms-command";
import { ko } from "../cms/cms-messages";
import { setMobile } from "./setup";
import { admin, agent, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
});

test("keys: list with expired badge; create shows the secret once with MCP and CLI tabs", async () => {
  const s = makeServer();
  await s.cms.createKey(admin, { name: "docs-agent", scopes: ["read", "write"], collections: ["guide"] });
  const old = await s.cms.createKey(admin, { name: "old-script", scopes: ["read"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  renderWith(s, <CmsKeys />);
  await screen.findByText("docs-agent");
  assert.ok(screen.getByRole("columnheader", { name: "Expires" }));
  assert.ok(screen.getByText("Guide"));
  assert.ok(screen.getByText(old.key.prefix));
  assert.deepEqual(await axeViolations(), []);

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New key" }));
  const dialog = await screen.findByRole("dialog", { name: "New key" });
  await user.type(within(dialog).getByLabelText("Name"), "release-bot");
  // Least privilege first: a new key starts as read-only, and says so.
  const access = within(dialog).getByRole("radiogroup", { name: "What it may do" });
  assert.equal(within(access).getByRole("radio", { name: "Read" }).getAttribute("aria-checked"), "true");
  assert.ok(within(dialog).getByText(/reads every collection · never expires · from anywhere/));
  await user.click(within(access).getByRole("radio", { name: "Custom" }));
  assert.equal(within(dialog).getByRole("checkbox", { name: "read" }).getAttribute("data-state"), "checked");
  await user.click(within(dialog).getByRole("checkbox", { name: "publish" }));
  await user.click(within(dialog).getByRole("checkbox", { name: "Notices" }));
  const expiry = within(dialog).getByRole("radiogroup", { name: "Expires" });
  assert.equal(within(expiry).getByRole("radio", { name: "None" }).getAttribute("aria-checked"), "true");
  await user.click(within(expiry).getByRole("radio", { name: "30 days" }));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByRole("button", { name: "Create" }));

  const done = await screen.findByRole("dialog", { name: "release-bot" });
  assert.ok(within(done).getByText("This key is shown only now, once."));
  assert.ok(within(done).queryByText(/^sgk_[A-Za-z0-9_-]{20,}$/) === null, "masked until Show");
  await user.click(within(done).getAllByRole("button", { name: "Show" })[0]);
  const secret = within(done).getAllByText(/^sgk_[^•]+$/)[0].textContent ?? "";
  assert.match(secret, /^sgk_/);
  const cliTab = within(done).getByRole("tab", { name: "CLI (.env)" });
  assert.equal(cliTab.getAttribute("aria-selected"), "true");
  for (const b of within(done).queryAllByRole("button", { name: "Show", pressed: false })) await user.click(b);
  assert.ok(within(done).getByText((t) => t.includes(`AGENT_CMS_KEY=${secret}`)));
  assert.ok(within(done).getByText("npx @mainsoft/agent-cms collections"));
  await user.click(within(done).getByRole("tab", { name: "MCP" }));
  for (const b of within(done).queryAllByRole("button", { name: "Show", pressed: false })) await user.click(b);
  assert.ok(within(done).getByText((t) => t.includes('"mcpServers"') && t.includes("http://localhost/api/cms/mcp") && t.includes(`Bearer ${secret}`)));
  // user-event swaps in its own clipboard; put a spy back.
  const copied: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => void copied.push(v) } });
  await user.click(within(done).getAllByRole("button", { name: /^Copy/ })[0]);
  await waitFor(() => assert.deepEqual(copied, [secret]));
  assert.deepEqual(await axeViolations(), []);

  const keys = await s.cms.listKeys(admin);
  const made = keys.find((k) => k.name === "release-bot")!;
  assert.deepEqual(made.scopes, ["read", "publish"]);
  assert.deepEqual(made.collections, ["notices"]);
  assert.ok(made.expiresAt && Date.parse(made.expiresAt) > Date.now() + 29 * 86_400_000);

  // Closing hides the secret for good.
  await user.click(within(done).getAllByRole("button", { name: "Close" })[0]);
  await waitFor(() => assert.ok(screen.queryByText(secret) === null));
  await screen.findByText("release-bot");
  assert.ok(screen.queryByText(secret) === null);
});

test("keys: expired badge, revoke with confirm", async () => {
  const s = makeServer();
  const k = await s.cms.createKey(admin, { name: "old-script", scopes: ["read"], expiresAt: new Date(Date.now() + 1000).toISOString() });
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    renderWith(s, <CmsKeys />, { messages: ko });
    await screen.findByText("old-script");
    assert.ok(screen.getByText("만료됨"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "폐기: old-script" }));
    const confirm = await screen.findByRole("dialog", { name: "old-script 키를 폐기할지 확인" });
    assert.deepEqual(await axeViolations(), []);
    await user.click(within(confirm).getByRole("button", { name: "폐기" }));
    await screen.findByText("폐기됨");
    assert.ok((await s.cms.listKeys(admin)).find((x) => x.id === k.key.id)?.revokedAt);
  } finally {
    Date.now = realNow;
  }
});

test("audit: entries, filters, 0 axe violations", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "a" }, { publish: true });
  await s.cms.createKey(admin, { name: "bot", scopes: ["read", "write"] });
  await new Promise((r) => setTimeout(r, 20));
  renderWith(s, <CmsAudit />);
  await screen.findByText("Create key");
  assert.ok(screen.getByText("Publish"));
  assert.ok(screen.getByText("guide/a"));
  assert.ok(screen.getByRole("combobox", { name: "Action" }));
  assert.ok(screen.getByRole("combobox", { name: "Who" }));
  assert.ok(screen.getByRole("combobox", { name: "Result" }));
  assert.deepEqual(await axeViolations(), []);
});

test("versions: list, side-by-side by default, unified toggle remembered, restore with confirm", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Slack", body: "## Connect\n1. Open settings apps.\n2. Press Add.", keywords: ["slack"] }, { publish: true });
  await s.cms.update(agent, "guide", "slack", { body: "## Connect\n1. Open settings integrations.\n2. Press Add.", keywords: ["slack", "alerts"] }, { expectedVersion: 1, note: "rename" });
  renderWith(s, <CmsVersions collection="guide" slug="slack" onBack={() => {}} />);
  const nav = await screen.findByRole("navigation", { name: "Versions" });
  await within(nav).findByText("v2");
  assert.ok(within(nav).getByText("rename"));
  assert.ok(within(nav).getByText("Agent"));
  await screen.findByText("v1 (published)", { selector: "span" });
  const view = screen.getByRole("radiogroup", { name: "Diff view" });
  assert.equal(within(view).getByRole("radio", { name: "Side by side" }).getAttribute("aria-checked"), "true");
  await waitFor(() => assert.ok(document.querySelector("ins")));
  assert.ok([...document.querySelectorAll("ins")].some((n) => n.textContent?.includes("integrations")));
  assert.ok([...document.querySelectorAll("del")].some((n) => n.textContent?.includes("apps")));
  assert.deepEqual(await axeViolations(), []);

  const user = userEvent.setup();
  await user.click(within(view).getByRole("radio", { name: "Unified" }));
  assert.equal(window.localStorage.getItem("agent-cms:diff-view"), '"unified"');
  assert.deepEqual(await axeViolations(), []);

  await user.click(screen.getByRole("button", { name: "Restore v1" }));
  const confirm = await screen.findByRole("dialog", { name: "Restore v1?" });
  await user.click(within(confirm).getByRole("button", { name: "Restore v1" }));
  await screen.findByText("Restored as v3");
  const doc = await s.cms.get(admin, "guide", "slack", { draft: true });
  assert.equal(doc.version, 3);
  assert.ok(doc.body.includes("apps"));
});

test("versions: mobile is unified only", async () => {
  setMobile(true);
  window.localStorage.setItem("agent-cms:diff-view", '"split"');
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Slack", body: "a\nb" }, { publish: true });
  await s.cms.update(admin, "guide", "slack", { body: "a\nc" }, { expectedVersion: 1 });
  renderWith(s, <CmsVersions collection="guide" slug="slack" onBack={() => {}} />);
  await waitFor(() => assert.ok(document.querySelector("ins")));
  assert.ok(screen.queryByRole("radiogroup", { name: "Diff view" }) === null);
  assert.ok(screen.getByRole("button", { name: "Publish v2" }));
  assert.deepEqual(await axeViolations(), []);
});

test("command: Ctrl+K opens, finds drafts across collections, opens a document", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: "a" });
  await s.cms.create(admin, "notices", { slug: "slack-news", title: "Slack news", body: "b" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "other", title: "Calendar", body: "c" });
  const opened: string[] = [];
  const created: string[] = [];
  renderWith(s, <CmsCommand collection="guide" onOpenDocument={(c, slug) => opened.push(`${c}/${slug}`)} onNewDocument={(c) => created.push(c)} />);
  await new Promise((r) => setTimeout(r, 30));
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Quick open" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByRole("combobox"), "slack");
  await within(dialog).findByText("news", { exact: false });
  await waitFor(() => assert.ok(within(dialog).queryByText("Calendar") === null));
  assert.ok(within(dialog).getByText("Draft v1"));
  assert.ok(within(dialog).getByText("New document in Guide"));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByText("news", { exact: false }));
  assert.deepEqual(opened, ["notices/slack-news"]);
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
});
