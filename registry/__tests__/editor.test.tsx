import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor, revertChange } from "../cms/cms-doc-editor";
import { CmsMerge } from "../cms/cms-merge";
import { setMobile } from "./setup";
import { admin, agent, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

const BODY = ["## Connect", "1. Open settings.", "2. Press Add.", "3. Allow.", "", "## Disconnect", "Press remove."].join("\n");

test("editor: renders form from _schema, preview, 0 axe violations (desktop and mobile)", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", summary: "How to", body: BODY, fields: { plans: ["pro"], order: 3 } }, { publish: true });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" publicUrlFor={(_c, slug) => `https://app.example.com/guide/${slug}`} onOpenVersions={() => {}} />);
  await screen.findByLabelText(/^Title/);
  assert.equal((screen.getByLabelText(/^Title/) as HTMLInputElement).value, "Connect Slack");
  assert.ok(screen.getByRole("group", { name: /Plans/ }));
  assert.ok(screen.getByRole("checkbox", { name: "pro" }));
  assert.equal(screen.getByRole("checkbox", { name: "pro" }).getAttribute("data-state"), "checked");
  assert.ok(screen.getByLabelText(/^Order/));
  assert.ok(screen.getByRole("checkbox", { name: "featured" }));
  assert.ok(screen.getByLabelText(/^tags/));
  assert.ok(screen.getByRole("combobox", { name: /audience/ }));
  assert.equal((screen.getByLabelText(/^Slug/) as HTMLInputElement).disabled, true);
  assert.equal(screen.getByRole("link", { name: "Public page" }).getAttribute("target"), "_blank");
  const preview = screen.getByRole("region", { name: "Preview" });
  assert.ok(within(preview).getByRole("heading", { name: "Connect" }));
  assert.deepEqual(await axeViolations(), []);
  cleanup();

  setMobile(true);
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" onBack={() => {}} />);
  await screen.findByRole("tab", { name: "Edit" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Document info/ }));
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  await screen.findByRole("heading", { name: "Disconnect" });
  assert.deepEqual(await axeViolations(), []);
});

test("editor: a field error from diagnose() sets aria-invalid and aria-describedby", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" autosaveDelay={50} />);
  const order = (await screen.findByLabelText(/^Order/)) as HTMLInputElement;
  assert.equal(order.getAttribute("aria-invalid"), null);
  fireEvent.change(order, { target: { value: "500" } });
  await waitFor(() => assert.equal(order.getAttribute("aria-invalid"), "true"), { timeout: 3000 });
  const ids = (order.getAttribute("aria-describedby") ?? "").split(" ");
  assert.ok(ids.includes(`${order.id}-help`));
  const err = document.getElementById(`${order.id}-err`);
  assert.ok(err && err.textContent);
  assert.ok(ids.includes(`${order.id}-err`));
  assert.ok(await screen.findByRole("button", { name: /1 problems/ }));
  assert.deepEqual(await axeViolations(), []);
});

test("editor: autosave on edit, restore offer on reload", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" autosaveDelay={30} />);
  const body = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: BODY + "\nMore." } });
  await screen.findByText(/^Autosaved/, undefined, { timeout: 3000 });
  const put = s.requests.find((r) => r.method === "PUT" && r.path.endsWith("/autosave"));
  assert.ok(put);
  assert.equal((put.body as { baseVersion: number }).baseVersion, 1);
  cleanup();

  renderWith(s, <CmsDocEditor collection="guide" slug="slack" />);
  const restore = await screen.findByRole("button", { name: "Restore" });
  await userEvent.setup().click(restore);
  assert.match((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value, /More\.$/);
});

test("editor: agent blocks, accept one, revert another, save records the revert", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY }, { publish: true });
  const changed = BODY.replace("1. Open settings.", "1. Open integrations.").replace("Press remove.", "Press remove.\n\nAsk an admin if it fails.");
  await s.cms.update(agent, "guide", "slack", { body: changed }, { expectedVersion: 1 });
  const pending = await s.cms.agentChanges(admin, "guide", "slack");
  assert.equal(pending.length, 2);

  renderWith(s, <CmsDocEditor collection="guide" slug="slack" />);
  const blocks = await screen.findByRole("list", { name: "Agent changes" });
  assert.equal(within(blocks).getAllByRole("listitem").length, 2);
  assert.match(screen.getByText(/docs-agent changed 2 places/).textContent ?? "", /reviewed 0\/2/);
  assert.deepEqual(await axeViolations(), []);

  const user = userEvent.setup();
  const [first, second] = within(blocks).getAllByRole("listitem");
  await user.click(within(first).getByRole("button", { name: /^Accept/ }));
  await within(first).findByText(/accepted/);
  const reviewReq = s.requests.find((r) => r.path.endsWith("/review"));
  assert.deepEqual(reviewReq?.body, { hunks: [pending.find((p) => p.added.some((l) => l.includes("integrations")))!.id], action: "accepted" });

  await user.click(within(second).getByRole("button", { name: /^Revert/ }));
  await within(second).findByText(/reverted/);
  const textarea = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
  assert.ok(!textarea.value.includes("Ask an admin"));
  assert.ok(textarea.value.includes("1. Open integrations."));
  assert.match(screen.getByText(/docs-agent changed 2 places/).textContent ?? "", /reviewed 2\/2/);

  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved v3");
  const reverted = s.requests.find((r) => r.path.endsWith("/review") && (r.body as { action: string }).action === "reverted");
  assert.ok(reverted);
  const doc = await s.cms.get(admin, "guide", "slack", { draft: true });
  assert.equal(doc.version, 3);
  assert.ok(!doc.body.includes("Ask an admin"));
  const v2 = await s.cms.version(admin, "guide", "slack", 2);
  assert.deepEqual(v2.reviewed.map((r) => r.action).sort(), ["accepted", "reverted"]);
  assert.equal((await s.cms.agentChanges(admin, "guide", "slack")).length, 0);
});

test("editor: revertChange puts removed lines back and drops added ones", () => {
  assert.equal(revertChange("a\nX\nc", { added: ["X"], removed: ["b"], before: "a" }), "a\nb\nc");
  assert.equal(revertChange("a\nc", { added: [], removed: ["b"], before: "a" }), "a\nb\nc");
  assert.equal(revertChange("a\nc", { added: ["zz"], removed: [], before: "a" }), null);
});

test("editor: preview link dialog, 24h by default, ttl choice makes a new link", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Preview link" }));
  const dialog = await screen.findByRole("dialog", { name: "Preview link" });
  const group = within(dialog).getByRole("radiogroup", { name: "Expires in" });
  assert.equal(within(group).getByRole("radio", { name: "24 hours" }).getAttribute("aria-checked"), "true");
  await within(dialog).findByText(/Valid until/);
  assert.match(within(dialog).getByText(/cms_preview=/).textContent ?? "", /^https:\/\/app\.example\.com\/guide\/slack\?cms_preview=/);
  assert.equal((s.requests.filter((r) => r.path.endsWith("/preview")).at(-1)?.body as { ttl: string }).ttl, "24h");
  assert.deepEqual(await axeViolations(), []);

  await user.click(within(group).getByRole("radio", { name: "7 days" }));
  await waitFor(() => assert.equal((s.requests.filter((r) => r.path.endsWith("/preview")).at(-1)?.body as { ttl: string }).ttl, "7d"));
  await within(dialog).findByText(/Valid until/);
  await user.click(within(dialog).getAllByRole("button", { name: /Copy/ })[0]);
});

test("editor: no preview link button when preview links are off", async () => {
  const s = makeServer({ previewSecret: null });
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" />);
  await screen.findByLabelText("Markdown");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(screen.queryByRole("button", { name: "Preview link" }), null);
});

test("editor: a 409 on save opens the merge; choose and save merged", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" />);
  const body = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;

  // Someone else saves first (same line, and the title).
  await s.cms.update(agent, "guide", "slack", { body: BODY.replace("2. Press Add.", "2. Press Connect."), title: "Slack" }, { expectedVersion: 1 });

  fireEvent.change(body, { target: { value: BODY.replace("2. Press Add.", "2. Press **Add**.").replace("Press remove.", "Press remove now.") } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByRole("heading", { name: "Merge" });
  assert.match(screen.getByText(/saved v2 first/).textContent ?? "", /docs-agent/);
  assert.deepEqual(await axeViolations(), []);

  const choice = screen.getByRole("radiogroup", { name: "To choose 1/1" });
  await user.click(within(choice).getByRole("radio", { name: "Mine" }));
  await user.click(screen.getByRole("button", { name: "Save merged" }));
  await screen.findByText("Saved v3");
  const doc = await s.cms.get(admin, "guide", "slack", { draft: true });
  assert.equal(doc.title, "Slack");
  assert.ok(doc.body.includes("2. Press **Add**."));
  assert.ok(doc.body.includes("Press remove now."));
});

test("merge: both keeps theirs then mine; a second 409 restarts with the newest copy", async () => {
  const s = makeServer();
  const v1 = await s.cms.create(admin, "guide", { slug: "slack", title: "T", body: "a\nb\nc" });
  const theirs = await s.cms.update(agent, "guide", "slack", { body: "a\nB1\nc" }, { expectedVersion: 1 });
  const saved: number[] = [];
  renderWith(s, <CmsMerge collection="guide" slug="slack" base={v1} baseVersion={1} mine={{ ...v1, body: "a\nB2\nc", title: "T mine" }} theirs={theirs} onSaved={(d) => saved.push(d.version)} onCancel={() => {}} />);
  const user = userEvent.setup();
  const body = await screen.findByRole("radiogroup", { name: "To choose 1/1" });
  assert.ok(within(body).getByRole("radio", { name: "Both" }));
  await user.click(within(body).getByRole("radio", { name: "Both" }));

  // They save again before we do.
  await s.cms.update(agent, "guide", "slack", { summary: "new summary" }, { expectedVersion: 2 });
  await user.click(screen.getByRole("button", { name: "Save merged" }));
  await screen.findByText(/saved again \(v3\)/);
  assert.deepEqual(saved, []);
  await user.click(screen.getByRole("button", { name: "Save merged" }));
  await waitFor(() => assert.deepEqual(saved, [4]));
  const doc = await s.cms.get(admin, "guide", "slack", { draft: true });
  assert.equal(doc.body, "a\nB1\nB2\nc");
  assert.equal(doc.summary, "new summary");
  assert.equal(doc.title, "T mine");
});

test("editor: new document creates and calls onCreated", async () => {
  const s = makeServer();
  const created: string[] = [];
  renderWith(s, <CmsDocEditor collection="guide" onCreated={(_c, slug) => created.push(slug)} />);
  const user = userEvent.setup();
  fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: "Hello" } });
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "hello" } });
  fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "Body" } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.deepEqual(created, ["hello"]));
});

test("editor: a new document's saved line survives the move to its own address", async () => {
  window.sessionStorage.clear();
  const s = makeServer();
  let at: string | null = null;
  const first = renderWith(s, <CmsDocEditor collection="guide" onCreated={(_c, slug) => (at = slug)} />);
  const user = userEvent.setup();
  fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: "Kept" } });
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "kept" } });
  fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "Body" } });
  await user.click(screen.getByRole("button", { name: "Publish" }));
  await waitFor(() => assert.equal(at, "kept"));
  // The app answers onCreated with a new page: a new editor, with nothing of the old one's state.
  first.unmount();
  renderWith(s, <CmsDocEditor collection="guide" slug="kept" />);
  assert.ok(await screen.findByText("Published v1"));
  assert.equal(window.sessionStorage.length, 0);
  // Shown once: opening the document again does not repeat it.
  cleanup();
  renderWith(s, <CmsDocEditor collection="guide" slug="kept" />);
  await screen.findByDisplayValue("Kept");
  assert.equal(screen.queryByText("Published v1"), null);
});
