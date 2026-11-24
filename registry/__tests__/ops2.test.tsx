// 0.13.0 screens: automations, roles, the dashboard, import and export.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isCmsError } from "../../src/errors";
import type { Actor } from "../../src/types";
import { CmsAutomations } from "../cms/cms-automations";
import { CmsDashboard } from "../cms/cms-dashboard";
import { ko } from "../cms/cms-messages";
import { CmsRoles } from "../cms/cms-roles";
import { CmsTransfer } from "../cms/cms-transfer";
import { setMobile } from "./setup";
import { admin, agent, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? e.code : String(e)));
const tick = () => new Promise((r) => setTimeout(r, 10));

test("automations: make one on the screen; a publish that matches runs on the next cron call, another is skipped; try it; delete", async () => {
  const s = makeServer();
  const user = userEvent.setup();
  renderWith(s, <CmsAutomations />);
  await screen.findByText(/^No automations yet\./);

  await user.click(screen.getByRole("button", { name: "New automation" }));
  const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
  assert.equal(name.value, "New automation 1");
  await screen.findByText(/^It has not run yet\./);
  await user.clear(name);
  await user.type(name, "News keyword");
  await user.selectOptions(screen.getByLabelText("When"), "doc.published");
  await user.selectOptions(screen.getByLabelText("Collection"), "guide");
  await user.click(screen.getByRole("button", { name: "Add a condition" }));
  await user.type(screen.getByLabelText("Value"), "start");
  await user.click(screen.getByRole("button", { name: "Add an action" }));
  await user.type(screen.getByLabelText("Keyword"), "news");
  await user.click(screen.getByRole("button", { name: "Add an action" }));
  await user.selectOptions(screen.getAllByLabelText("Do")[1], "call");
  await user.selectOptions(screen.getByLabelText("Target"), "notify");
  await user.click(screen.getByRole("checkbox", { name: "On" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  const nav = screen.getByRole("navigation", { name: "Automations" });
  await within(nav).findByText("News keyword");
  assert.match(nav.textContent ?? "", /A document is published/);
  assert.deepEqual(await axeViolations(), []);

  // Nothing runs inside the request that published; the cron call does the work.
  await s.cms.create(admin, "guide", { slug: "hello", title: "Hello", category: "start", body: "x\n" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "other", title: "Other", category: "integrations", body: "x\n" }, { publish: true });
  await tick();
  assert.deepEqual((await s.cms.get(admin, "guide", "hello", { draft: true })).keywords, []);
  await s.cms.cron();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  const runs = screen.getByRole("list", { name: "Runs" });
  await waitFor(() => assert.equal(within(runs).getAllByRole("listitem").length, 2));
  assert.deepEqual(
    within(runs)
      .getAllByRole("listitem")
      .map((li) => (li.textContent ?? "").replace(/(Hello|Other).*$/, "$1"))
      .sort(),
    ["DoneHello", "SkippedOther"]
  );
  const hello = await s.cms.get(admin, "guide", "hello", { draft: true });
  assert.deepEqual([hello.keywords, hello.updatedBy, s.notified], [["news"], "automation: News keyword", ["News keyword:hello"]]);
  await waitFor(() => assert.match(nav.textContent ?? "", /A document is published · (Done|Skipped)/));

  // "Try it" changes nothing and says what would happen.
  const before = s.requests.length;
  // The document is found by its title: nobody types a slug.
  const pick = async (title: string) => {
    const other = screen.queryByRole("button", { name: "Pick another document" });
    if (other) await user.click(other);
    await user.type(screen.getByRole("combobox", { name: "Document to try it on" }), title);
    // Options from an older query cannot be picked while the new answer is on its way.
    const option = await waitFor(() => {
      const o = screen.getByRole("option", { name: new RegExp(title) });
      assert.ok(o.getAttribute("aria-disabled") === null);
      return o;
    });
    await user.click(option);
  };
  await pick("Other");
  await user.click(screen.getByRole("button", { name: "Try it" }));
  await screen.findByText("“Other” does not match the conditions, so it would be skipped.");
  await pick("Hello");
  await user.click(screen.getByRole("button", { name: "Try it" }));
  await screen.findByText("“Hello” matches. It would do: Add a keyword, Call an app function");
  assert.ok(s.requests.slice(before).every((r) => r.method === "GET" || r.path.endsWith("/test")), "no write was made");
  await user.click(screen.getByRole("button", { name: "Pick another document" }));
  await user.type(screen.getByRole("combobox", { name: "Document to try it on" }), "nope-nothing");
  await screen.findByText("No document matches.");

  // An action without what it needs is refused with the reason.
  await user.selectOptions(screen.getAllByLabelText("Do")[1], "add_to_release");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/needs a target/);
  await user.click(screen.getAllByRole("button", { name: "Remove this step" })[2]);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");

  await user.click(screen.getByRole("button", { name: "Delete" }));
  const dlg = await screen.findByRole("dialog", { name: "Delete “News keyword”?" });
  assert.match(dlg.textContent ?? "", /Its run history goes with it\./);
  await user.click(within(dlg).getByRole("button", { name: "Delete" }));
  await screen.findByText(/^No automations yet\./);
  assert.equal((await s.cms.automations.list(admin)).automations.length, 0);
});

test("automations 0.22.2: \"Send a webhook\" with no webhook yet makes one right there, picks it, and only then saves", async () => {
  const s = makeServer({ webhooks: true });
  const auto = await s.cms.automations.create(admin, { name: "Tell Slack", trigger: { event: "doc.published", collection: null }, actions: [] });
  const user = userEvent.setup();
  renderWith(s, <CmsAutomations />);
  await screen.findByDisplayValue("Tell Slack");
  await user.click(screen.getByRole("button", { name: "Add an action" }));
  await user.selectOptions(screen.getByLabelText("Do"), "webhook");
  await screen.findByText("No webhook to send to yet");
  await screen.findByText("Pick a webhook to save.");
  assert.ok((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, "nothing to send to: no saving");

  await user.click(screen.getByRole("button", { name: "Create a webhook" }));
  const dlg = await screen.findByRole("dialog", { name: "New webhook" });
  assert.match(dlg.textContent ?? "", /Once created, it is picked for this action\./);
  // "Only automations" comes first and is picked.
  const only = within(dlg).getByRole("radio", { name: "Only automations" });
  assert.equal(only.getAttribute("aria-checked"), "true");
  await user.type(within(dlg).getByLabelText("Name"), "Slack");
  await user.type(within(dlg).getByLabelText("Address"), "https://hooks.example/slack");
  await user.click(within(dlg).getByRole("button", { name: "Create and pick" }));
  // The secret is shown once; the new webhook is picked in the row.
  const secret = await screen.findByRole("dialog", { name: /Slack/ });
  await user.click(within(secret).getAllByRole("button", { name: "Close" }).at(-1)!);
  await waitFor(() => assert.equal((screen.getByLabelText("Target") as HTMLSelectElement).selectedOptions[0]?.textContent, "Slack"));
  const [made] = await s.cms.webhooks.list(admin);
  assert.deepEqual(made.events, ["automation"]);
  assert.equal((await s.cms.automations.list(admin)).automations[0].actions.length, 0, "nothing saved by making the webhook");

  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  const saved = (await s.cms.automations.list(admin)).automations.find((a) => a.id === auto.id)!;
  assert.deepEqual(saved.actions, [{ type: "webhook", target: made.id }]);
});

test("automations 0.22.2: webhooks off on the server: the action says so instead of an empty list", async () => {
  const s = makeServer();
  await s.cms.automations.create(admin, { name: "Old", trigger: { event: "doc.published", collection: null }, actions: [{ type: "webhook", target: "gone" }] });
  renderWith(s, <CmsAutomations />, { messages: ko });
  await screen.findByDisplayValue("Old");
  const note = await screen.findByRole("note");
  assert.match(note.textContent ?? "", /이 서버는 웹훅이 꺼져 있음\. 이 동작은 실행되지 않음\./);
  assert.match(note.textContent ?? "", /secretsKey/);
  assert.ok(screen.queryByLabelText("대상") === null, "no empty list to pick from");
  const opt = within(screen.getByLabelText("동작")).getByRole("option", { name: "웹훅 보내기 (꺼짐)" }) as HTMLOptionElement;
  assert.ok(opt.selected);
});

test("automations: Korean strings, and someone who is not an admin is told so", async () => {
  const s = makeServer();
  await s.cms.automations.create(admin, { name: "알림", trigger: { event: "schedule.weekly", collection: null }, actions: [{ type: "call", target: "notify" }] });
  renderWith(s, <CmsAutomations />, { messages: ko });
  await screen.findByRole("heading", { name: "자동화" });
  assert.match((await screen.findByRole("navigation", { name: "자동화" })).textContent ?? "", /알림매주 월요일/);
  assert.equal((screen.getByLabelText("언제") as HTMLSelectElement).value, "schedule.weekly");
  assert.ok(screen.queryByLabelText("컬렉션") === null, "a schedule has no collection");
  await screen.findByText(/^아직 실행된 적이 없음\./);
  cleanup();

  s.session.user = { kind: "user", id: "u5", label: "Reader", isAdmin: false };
  renderWith(s, <CmsAutomations />);
  await screen.findByText(/admin/i);
  assert.ok(screen.queryByLabelText("Name") === null);
});

test("roles: a role lets a person write but not publish; code-decided collections are fixed; people are found by name", async () => {
  const s = makeServer({ users: true, codedWrite: true });
  const user = userEvent.setup();
  const park: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u7", label: "Park Jiwoo", isAdmin: false };
  assert.equal(await code(s.cms.create(park, "guide", { slug: "p", title: "P", body: "x\n" })), "forbidden_write");

  renderWith(s, <CmsRoles />);
  await screen.findByText("No roles yet");
  // The name comes first, with a starting point; nothing is made until "Create role".
  await user.click(screen.getAllByRole("button", { name: "New role" })[0]);
  const dlg0 = await screen.findByRole("dialog", { name: "New role" });
  await user.type(within(dlg0).getByLabelText("Name"), "Writers");
  await user.click(within(dlg0).getByRole("radio", { name: /Nothing yet/ }));
  await user.click(within(dlg0).getByRole("button", { name: "Create role" }));
  await screen.findByText("Created the role Writers");

  const table = await screen.findByRole("table");
  const row = (label: string) => within(table).getByText(label).closest("tr")!;
  assert.equal(within(row("Notices")).getAllByText("Set in code").length, 1, "write is decided in code");
  assert.ok(within(row("Notices")).queryByRole("checkbox", { name: "Notices: Write" }) === null);
  assert.ok((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, "nothing to save yet");
  await user.click(within(row("Guide")).getByRole("checkbox", { name: "Guide: Write" }));
  await screen.findByText("Unsaved changes");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/^Saved/);

  // People are found by name; nobody types an id.
  await screen.findByText(/No one is in this role yet/);
  await user.type(screen.getByRole("combobox", { name: "Add a person" }), "park");
  await user.click(await screen.findByRole("option", { name: /Park Jiwoo/ }));
  await screen.findByRole("button", { name: "Remove Park Jiwoo" });
  assert.deepEqual(await axeViolations(), []);

  await s.cms.create(park, "guide", { slug: "p", title: "P", body: "x\n" });
  assert.equal(await code(s.cms.publish(park, "guide", "p")), "forbidden_publish");
  await user.click(within(row("Guide")).getByRole("checkbox", { name: "Guide: Publish" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal(await code(s.cms.publish(park, "guide", "p")), "ok"));
  assert.equal(await code(s.cms.remove(park, "guide", "p")), "forbidden_publish", "deleting is its own box");

  // An admin role hides the table: it may do everything.
  const adminBox = () => screen.getAllByRole("checkbox").find((c) => c.closest("label")?.textContent?.startsWith("Admin"))!;
  await user.click(adminBox());
  assert.ok(screen.queryByRole("table") === null);
  await user.click(adminBox());

  await user.click(screen.getByRole("button", { name: "Remove Park Jiwoo" }));
  await screen.findByText(/No one is in this role yet/);
  assert.equal(await code(s.cms.update(park, "guide", "p", { title: "P2" })), "forbidden_write");

  await user.click(screen.getByRole("button", { name: "Delete" }));
  const dlg = await screen.findByRole("dialog", { name: "Delete the role “Writers”?" });
  await user.click(within(dlg).getByRole("button", { name: "Delete" }));
  await screen.findByText("No roles yet");
});

test("roles: someone who has not signed in yet is added by email and joins at first sign-in; on a phone the roles are a row above the form", async () => {
  setMobile(true);
  const s = makeServer();
  const user = userEvent.setup();
  await s.cms.roles.create(admin, { name: "Editors", permissions: { guide: { write: true, publish: true } } });
  await s.cms.roles.create(admin, { name: "Owners", admin: true });
  renderWith(s, <CmsRoles />, { messages: ko });
  const nav = await screen.findByRole("navigation", { name: "역할" });
  await within(nav).findByRole("button", { name: /Editors/ });
  assert.equal((screen.getByRole("checkbox", { name: "Guide: 게시" }) as HTMLElement).getAttribute("aria-checked"), "true");
  await user.type(screen.getByRole("combobox", { name: "사람 추가" }), "new.person@example.com");
  await user.click(await screen.findByRole("option", { name: /new\.person@example\.com 추가/ }));
  await screen.findByText("아직 로그인 안 함");
  const members = () => s.cms.roles.list(admin).then((r) => r.roles.find((x) => x.name === "Editors")!.members);
  assert.deepEqual(await members(), [{ id: "email:new.person@example.com", label: "new.person@example.com", email: "new.person@example.com", pending: true }]);
  // Their first visit with that email turns the invitation into a membership.
  await s.cms.roles.seen({ kind: "user", id: "u42", label: "New Person", email: "New.Person@example.com", isAdmin: false });
  assert.deepEqual(await members(), [{ id: "u42", label: "New Person", email: "new.person@example.com" }]);
  await user.click(within(nav).getByRole("button", { name: /Owners/ }));
  await waitFor(() => assert.ok(screen.queryByRole("table") === null));
  assert.equal((screen.getByLabelText("이름") as HTMLInputElement).value, "Owners");
});

test("dashboard: the cards match the lists, changes split people and agents, the period switches", async () => {
  const s = makeServer();
  const user = userEvent.setup();
  await s.cms.create(admin, "guide", { slug: "a", title: "Getting started", category: "start", body: "x\n" }, { publish: true });
  await s.cms.create(agent, "guide", { slug: "b", title: "From the agent", category: "start", body: "x\n" });
  await s.cms.recordHits([(await s.cms.get(admin, "guide", "a")).id]);
  renderWith(s, <CmsDashboard />);
  const card = async (label: string) => (await screen.findByText(label, { selector: "dt" })).parentElement!.querySelector("dd")!.textContent;
  const counts = await s.cms.counts(admin, "guide");
  assert.deepEqual([await card("Documents"), await card("Published"), await card("Waiting for review"), await card("Scheduled")], [String(counts.all), String(counts.published), "0", "0"]);

  const bars = screen.getByRole("list", { name: "Changes" });
  assert.equal(within(bars).getAllByRole("listitem").length, 14);
  assert.match(within(bars).getAllByRole("listitem")[13].textContent ?? "", /: people 1, agents 1$/);
  const top = screen.getByRole("heading", { name: "Most read" }).parentElement!;
  const link = within(top).getByRole("link", { name: "Getting started" });
  assert.equal(link.getAttribute("href"), "/admin/guide/a");
  assert.match(link.closest("li")!.textContent ?? "", /^1Getting started1 reads$/);
  const recent = screen.getByRole("heading", { name: "Recent activity" }).parentElement!;
  assert.match(recent.textContent ?? "", /docs-agent created From the agent/);
  assert.match(recent.textContent ?? "", /Admin published Getting started/);
  assert.deepEqual(await axeViolations(), []);

  await user.click(screen.getByRole("radio", { name: "7 days" }));
  await waitFor(() => assert.equal(within(screen.getByRole("list", { name: "Changes" })).getAllByRole("listitem").length, 7));
  assert.equal(s.requests.filter((r) => r.path.startsWith("/_stats")).pop()?.path, "/_stats?days=7");
});

test("dashboard: empty CMS, Korean, and a reader sees only what they may read", async () => {
  const s = makeServer();
  renderWith(s, <CmsDashboard basePath="/cms" />, { messages: ko });
  await screen.findByText("이 기간에 읽힌 문서가 없음.");
  await screen.findByText("아직 활동이 없음.");
  assert.equal(screen.getByText("문서", { selector: "dt" }).parentElement!.querySelector("dd")!.textContent, "0");
  cleanup();

  await s.cms.create(admin, "notices", { slug: "n", title: "Internal", body: "x\n" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "g", title: "Public", body: "x\n" });
  s.session.user = { kind: "user", id: "u5", label: "Reader", isAdmin: false };
  renderWith(s, <CmsDashboard />);
  const docs = (await screen.findByText("Documents", { selector: "dt" })).parentElement!.querySelector("dd")!.textContent;
  assert.equal(docs, "1", "the draft in Guide is not theirs to see; the published notice is");
  assert.ok(!/Admin/.test(screen.getByRole("heading", { name: "Recent activity" }).parentElement!.textContent ?? ""), "no edit history for a reader");
});

test("import: a bundle is looked at first, then only the ticked files become drafts; export links follow the choices", async () => {
  const s = makeServer();
  const user = userEvent.setup();
  await s.cms.create(admin, "guide", { slug: "a", title: "A", category: "start", body: "one\n" }, { publish: true });
  const bundle = await s.cms.transfer.export(admin, { drafts: true });
  const files = [
    ...bundle.files.map((f) => (f.path === "guide/a.md" ? { ...f, text: f.text.replace("one", "two") } : f)),
    { path: "guide/b.md", text: "---\ntitle: B\ncategory: start\n---\nbody\n" },
    { path: "guide/c.md", text: "---\ntitle: C\ncategory: start\n---\nbody\n" },
    { path: "guide/bad.md", text: "---\ntitle: Bad\ncategory: nope\n---\nx\n" },
  ];

  renderWith(s, <CmsTransfer />);
  await screen.findByText("Drop an export file, markdown files or a .zip (also a Notion export) here");
  // Keeping what is there is the default: an existing document is skipped, new ones come in.
  await user.upload(screen.getByLabelText("Choose a file"), new File([JSON.stringify({ files })], "cms-export.json", { type: "application/json" }));
  const item = async (path: string) => (await screen.findByText(path, { selector: "span[title]" })).closest("li")!;
  assert.match((await item("guide/a.md")).textContent ?? "", /Skipped/);
  await screen.findByText(/2 new · 0 would change/);
  // Replacing is a choice made on purpose, and asked once more.
  await user.selectOptions(screen.getByLabelText("When the address exists"), "file-wins");
  await waitFor(async () => assert.match((await item("guide/a.md")).textContent ?? "", /v1 → v2/));
  assert.match((await item("guide/b.md")).textContent ?? "", /New document/);
  assert.match((await item("guide/bad.md")).textContent ?? "", /Cannot import/i);
  assert.equal((within(await item("guide/bad.md")).getByRole("checkbox") as HTMLButtonElement).disabled, true);
  await screen.findByText("3 of 4 files selected");
  assert.equal((await s.cms.counts(admin, "guide")).all, 1, "looking changes nothing");
  assert.deepEqual(await axeViolations(), []);

  // Leave one out, then import.
  await user.click(within(await item("guide/c.md")).getByRole("checkbox"));
  await screen.findByText("2 of 4 files selected");
  await user.click(screen.getByRole("button", { name: "Import 2" }));
  const sure = await screen.findByRole("alertdialog", { name: "Replace 1 existing documents?" }).catch(() => screen.findByRole("dialog", { name: "Replace 1 existing documents?" }));
  await user.click(within(sure).getByRole("button", { name: "Replace and import" }));
  await screen.findByText("Imported 2 documents as drafts.");
  assert.equal((await s.cms.get(admin, "guide", "a", { draft: true })).body.trim(), "two");
  assert.equal((await s.cms.get(admin, "guide", "a")).body.trim(), "one", "the public copy stays until someone publishes");
  assert.equal((await s.cms.get(admin, "guide", "b", { draft: true })).status, "draft");
  assert.equal(await code(s.cms.get(admin, "guide", "c", { draft: true })), "not_found");

  // "Keep what is there" skips a document that exists.
  await user.selectOptions(screen.getByLabelText("When the address exists"), "db-wins");
  await user.upload(screen.getByLabelText("Choose a file"), new File([files[0].text.replace("two", "three")], "a.md", { type: "text/markdown" }));
  await screen.findByText("Unknown collection: a.md");
  await user.selectOptions(screen.getByLabelText("Collection"), "guide");
  await waitFor(async () => assert.match((await item("a.md")).textContent ?? "", /Skipped/));
  assert.equal((screen.getByRole("button", { name: "Import 0" }) as HTMLButtonElement).disabled, true);

  // A file that is not an export.
  await user.upload(screen.getByLabelText("Choose a file"), new File(["{\"nope\":1}"], "x.json", { type: "application/json" }));
  await screen.findByText("This file cannot be read.");

  await user.click(screen.getByRole("radio", { name: "Export" }));
  const link = screen.getByRole("link", { name: "Export" });
  assert.equal(link.getAttribute("href"), "http://localhost/api/cms/export?download=1&collections=guide&drafts=1");
  await user.selectOptions(screen.getByLabelText("Collection"), "");
  await user.click(screen.getByRole("checkbox", { name: "Include drafts" }));
  assert.equal(screen.getByRole("link", { name: "Export" }).getAttribute("href"), "http://localhost/api/cms/export?download=1");
});
