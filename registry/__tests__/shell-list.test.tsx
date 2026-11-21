import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsShell } from "../cms/cms-shell";
import { CmsDocList } from "../cms/cms-doc-list";
import { CmsEmpty } from "../cms/cms-empty";
import { ko } from "../cms/cms-messages";
import { setMobile } from "./setup";
import { admin, agent, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

test("shell: collections, ops links and the app's extraNav links, 0 axe violations", async () => {
  const s = makeServer();
  renderWith(
    s,
    <CmsShell
      title="Servicer"
      activeCollection="guide"
      extraNav={[{ label: "Servicer", items: [{ label: "Unanswered questions", href: "/admin/servicer/gaps", badge: 12 }] }]}
      onSearch={() => {}}
    >
      <p>content</p>
    </CmsShell>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  await within(nav).findByRole("link", { name: /Guide/ });
  assert.equal(within(nav).getByRole("link", { name: /Guide/ }).getAttribute("aria-current"), "page");
  assert.equal(within(nav).getByRole("link", { name: /Notices/ }).getAttribute("href"), "/admin/notices");
  assert.ok(within(nav).getByRole("link", { name: "API keys" }));
  assert.equal(within(nav).getByRole("link", { name: "Audit log" }).getAttribute("href"), "/admin/audit");
  const extra = within(nav).getByRole("link", { name: /Unanswered questions/ });
  assert.equal(extra.getAttribute("href"), "/admin/servicer/gaps");
  assert.match(extra.textContent ?? "", /12/);
  assert.ok(within(nav).getByRole("heading", { name: "Servicer" }));
  assert.deepEqual(await axeViolations(), []);
});

test("shell: LinkComponent renders the links; mobile menu opens in a sheet", async () => {
  setMobile(true);
  const s = makeServer();
  const Link = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a data-router="" href={href} className={className}>
      {children}
    </a>
  );
  const { CmsDocList: List } = await import("../cms/cms-doc-list");
  renderWith(
    s,
    <CmsShell LinkComponent={Link}>
      <List collection="guide" />
    </CmsShell>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Menu" }));
  const dialog = await screen.findByRole("dialog");
  const link = await within(dialog).findByRole("link", { name: /Guide/ });
  assert.equal(link.getAttribute("data-router"), "");
  assert.deepEqual(await axeViolations(), []);
});

async function seed(s: ReturnType<typeof makeServer>) {
  await s.cms.create(admin, "guide", { slug: "slack-connect", title: "Connect Slack", body: "## Start\nHello", category: "integrations" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "invite", title: "Invite members", body: "Invite" }, { publish: true });
  await s.cms.create(agent, "guide", { slug: "billing", title: "Billing plans", body: "Plans" });
  await s.cms.create(admin, "guide", { slug: "legacy", title: "Old dashboard", body: "Old" }, { publish: true });
  await s.cms.archive(admin, "guide", "legacy");
  await s.cms.recordHits?.([(await s.cms.get(admin, "guide", "slack-connect")).id]);
}

test("list: tabs with counts, rows, views column, 0 axe violations", async () => {
  const s = makeServer();
  await seed(s);
  renderWith(s, <CmsDocList collection="guide" onNewDocument={() => {}} onOpenDocument={() => {}} />);
  await screen.findByText("Connect Slack");
  const tabs = screen.getByRole("radiogroup", { name: "State" });
  await waitFor(() => assert.ok(within(tabs).getByRole("radio", { name: "All 4" })));
  assert.ok(within(tabs).getByRole("radio", { name: "Draft 1" }));
  assert.ok(within(tabs).getByRole("radio", { name: "Hidden 1" }));
  assert.ok(screen.getByRole("columnheader", { name: "Views (7 days)" }));
  assert.equal((await screen.findByText("4 of 4")).getAttribute("role"), "status");
  assert.deepEqual(await axeViolations(), []);

  const user = userEvent.setup();
  await user.click(within(tabs).getByRole("radio", { name: "Draft 1" }));
  await waitFor(() => assert.ok(screen.queryByText("Connect Slack") === null));
  assert.ok(screen.getByText("Billing plans"));
});

test("list: bulk publish asks first, then shows a partial failure per document", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "a", title: "Doc A", body: "a" });
  await s.cms.create(admin, "guide", { slug: "b", title: "Doc B", body: "b" });
  renderWith(s, <CmsDocList collection="guide" onOpenDocument={() => {}} />);
  await screen.findByText("Doc A");
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Select Doc A" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Doc B" }));
  const bar = screen.getByRole("toolbar", { name: "Bulk actions" });
  assert.match(bar.textContent ?? "", /2 selected/);

  // Someone saves Doc B after the list loaded: its publish must fail.
  await s.cms.update(agent, "guide", "b", { body: "b2" });

  await user.click(within(bar).getByRole("button", { name: "Publish" }));
  const confirm = await screen.findByRole("dialog", { name: "Publish 2 documents?" });
  assert.ok(within(confirm).getByText("Doc A"));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(confirm).getByRole("button", { name: "Publish" }));

  const result = await screen.findByRole("dialog", { name: "Published 1, 1 failed" });
  assert.ok(within(result).getByText("Doc A"));
  assert.ok(within(result).getByText("Doc B"));
  assert.ok(within(result).getByRole("button", { name: "Open" }));
  assert.equal((await s.cms.get(admin, "guide", "a")).status, "published");
  assert.equal((await s.cms.get(admin, "guide", "b", { draft: true })).publishedVersion, null);
  assert.deepEqual(await axeViolations(), []);
});

test("list: mobile cards, long press enters selection mode with the bulk bar", async () => {
  setMobile(true);
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "a", title: "Doc A", body: "a" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "b", title: "Doc B", body: "b" });
  const opened: string[] = [];
  renderWith(s, <CmsDocList collection="guide" onOpenDocument={(_c, slug) => opened.push(slug)} />, { messages: ko });
  const card = await screen.findByRole("button", { name: /Doc A/ });
  assert.deepEqual(await axeViolations(), []);
  const user = userEvent.setup();
  await user.click(card);
  assert.deepEqual(opened, ["a"]);
  // A long press (contextmenu on touch) selects.
  fireEvent.contextMenu(card);
  await screen.findByRole("heading", { name: "1개 선택됨" });
  const bar = screen.getByRole("toolbar", { name: "일괄 작업" });
  assert.ok(within(bar).getByRole("button", { name: "게시" }));
  await user.click(screen.getByRole("button", { name: /Doc B/ }));
  await screen.findByRole("heading", { name: "2개 선택됨" });
  assert.deepEqual(opened, ["a"]);
  assert.deepEqual(await axeViolations(), []);
});

test("empty: new document plus the agent guide (CLI, MCP URL, key link)", async () => {
  const s = makeServer();
  renderWith(s, <CmsDocList collection="notices" onNewDocument={() => {}} keysHref="/admin/keys" />);
  await screen.findByRole("heading", { name: "No documents yet" });
  assert.ok(screen.getByText("npx @mainsoft/agent-cms put notices ./post.md"));
  // An absolute baseUrl wins over appUrl.
  assert.ok(screen.getByText("http://localhost/api/cms/mcp"));
  assert.equal(screen.getByRole("link", { name: "Create an API key" }).getAttribute("href"), "/admin/keys");
  assert.deepEqual(await axeViolations(), []);
  cleanup();
  renderWith(s, <CmsEmpty collection="notices" />, { messages: ko });
  await screen.findByRole("heading", { name: "아직 문서가 없음" });
  assert.ok(screen.getByRole("heading", { name: "에이전트로 쓰기" }));
});
