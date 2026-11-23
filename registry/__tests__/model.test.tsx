// 0.21.0 content model screens: tree view, templates, relations, documents
// that others point at, redirects, singles.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { CmsDocList } from "../cms/cms-doc-list";
import { CmsRedirects } from "../cms/cms-redirects";
import { CmsShell } from "../cms/cms-shell";
import { setMobile } from "./setup";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

test("tree: nested documents show as a tree; Alt+ArrowRight moves one under the one above", async () => {
  const s = makeServer({ model: true });
  const start = await s.cms.create(admin, "docs", { slug: "start", title: "Start", body: "x" });
  await s.cms.create(admin, "docs", { slug: "install", title: "Install", body: "x" });
  await s.cms.move(admin, "docs", "install", { parentId: start.id });
  await s.cms.create(admin, "docs", { slug: "faq", title: "FAQ", body: "x" });
  window.localStorage.setItem("cms-list-view:docs", JSON.stringify("tree"));
  renderWith(s, <CmsDocList collection="docs" onOpenDocument={() => {}} />);
  const tree = await screen.findByRole("tree", { name: "Document tree" });
  await within(tree).findByText("Install");
  const items = within(tree).getAllByRole("treeitem");
  assert.deepEqual(
    items.map((i) => [i.textContent?.match(/Start|Install|FAQ/)?.[0], i.getAttribute("aria-level")]),
    [
      ["Start", "1"],
      ["Install", "2"],
      ["FAQ", "1"],
    ]
  );
  assert.deepEqual(await axeViolations(), []);

  const faq = items[2];
  faq.focus();
  fireEvent.keyDown(faq, { key: "ArrowRight", altKey: true });
  await waitFor(() => assert.ok(s.requests.some((r) => r.path.endsWith("/_move"))));
  const moved = s.requests.find((r) => r.path.endsWith("/_move"))!;
  assert.deepEqual(moved.body, { slug: "faq", parentId: start.id, before: null });
  await waitFor(async () => assert.equal((await s.cms.get(admin, "docs", "faq", { draft: true })).parentId, start.id));
  await waitFor(() => assert.equal(within(screen.getByRole("tree")).getByText("FAQ").closest("[role=treeitem]")?.getAttribute("aria-level"), "2"));
});

test("templates: New asks for a template when the collection has some; the editor starts from it", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "docs", { slug: "a", title: "Overview", body: "x" });
  let opened = "";
  renderWith(s, <CmsDocList collection="docs" onOpenDocument={() => {}} onNewDocument={(c) => (opened = c)} />);
  await screen.findByText("Overview");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New document" }));
  const dlg = await screen.findByRole("dialog", { name: "New document" });
  assert.ok(within(dlg).getByRole("button", { name: /Blank document/ }));
  await user.click(within(dlg).getByRole("button", { name: /How-to/ }));
  assert.equal(opened, "docs");
  cleanup();

  // StrictMode (as in the bundled admin) runs the editor's effects twice: the template must survive that.
  renderWith(
    s,
    <React.StrictMode>
      <CmsDocEditor collection="docs" />
    </React.StrictMode>
  );
  await waitFor(() => assert.equal((screen.getByLabelText(/^Title/) as HTMLInputElement).value, "How to …"));
  assert.ok(await screen.findByText("Started from “How-to”"));
});

test("templates: without templates New goes straight to the editor", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "team", { slug: "paul", title: "Paul", body: "x" });
  let opened = "";
  renderWith(s, <CmsDocList collection="team" onOpenDocument={() => {}} onNewDocument={(c) => (opened = c)} />);
  await screen.findByText("Paul");
  await userEvent.setup().click(screen.getByRole("button", { name: "New document" }));
  await waitFor(() => assert.equal(opened, "team"));
  assert.ok(!screen.queryByRole("dialog"));
});

test("relation: pick a document in the dialog; saving stores its id", async () => {
  const s = makeServer({ model: true });
  const paul = await s.cms.create(admin, "team", { slug: "paul", title: "Paul Park", body: "x" }, { publish: true });
  await s.cms.create(admin, "team", { slug: "lee", title: "Lee Minho", body: "x" }, { publish: true });
  await s.cms.create(admin, "docs", { slug: "intro", title: "Intro", body: "x" });
  renderWith(s, <CmsDocEditor collection="docs" slug="intro" />);
  await screen.findByLabelText(/^Title/);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Choose a document" }));
  const dlg = await screen.findByRole("dialog", { name: "Choose: Author" });
  await within(dlg).findByText("Paul Park");
  await user.click(within(dlg).getByText("Paul Park"));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog", { name: "Choose: Author" })));
  assert.ok(screen.getByText("Paul Park"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "docs", "intro", { draft: true })).fields.author, paul.id));
});

test("referenced: deleting a document others point at lists them, then deletes anyway", async () => {
  const s = makeServer({ model: true });
  const paul = await s.cms.create(admin, "team", { slug: "paul", title: "Paul Park", body: "x" }, { publish: true });
  await s.cms.create(admin, "docs", { slug: "intro", title: "Intro", body: "x", fields: { author: paul.id } });
  renderWith(s, <CmsDocList collection="team" onOpenDocument={() => {}} />);
  await screen.findByText("Paul Park");
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Select Paul Park" }));
  const bar = screen.getByRole("toolbar", { name: "Bulk actions" });
  await user.click(within(bar).getByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: /Delete/ });
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  const refs = await screen.findByRole("alertdialog", { name: "Other documents point at “Paul Park”" });
  await within(refs).findByText("Intro");
  assert.match(within(refs).getByText("Intro").parentElement?.textContent ?? "", /Docs · author/);
  assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).slug, "paul");
  await user.click(within(refs).getByRole("button", { name: "Delete anyway" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  await assert.rejects(s.cms.get(admin, "team", "paul", { draft: true }));
});

test("redirects: create (with the server's refusal inline), edit, delete; nav entry for admins", async () => {
  const s = makeServer({ model: true });
  renderWith(
    s,
    <CmsShell activeHref="/admin/redirects">
      <CmsRedirects />
    </CmsShell>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const link = await within(nav).findByRole("link", { name: "Redirects" });
  assert.equal(link.getAttribute("href"), "/admin/redirects");
  assert.equal(link.getAttribute("aria-current"), "page");
  await screen.findByText("No redirects yet");
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "New redirect" })[0]);
  let dlg = await screen.findByRole("dialog", { name: "New redirect" });
  await user.clear(within(dlg).getByLabelText("Old address"));
  await user.type(within(dlg).getByLabelText("Old address"), "/old");
  await user.clear(within(dlg).getByLabelText("New address"));
  await user.type(within(dlg).getByLabelText("New address"), "/old");
  await user.click(within(dlg).getByRole("button", { name: "Create" }));
  // A redirect to itself: the server says no, shown in the dialog.
  assert.match((await within(dlg).findByRole("alert")).textContent ?? "", /back to itself/);
  assert.equal(within(dlg).getByLabelText("New address").getAttribute("aria-invalid"), "true");
  await user.clear(within(dlg).getByLabelText("New address"));
  await user.type(within(dlg).getByLabelText("New address"), "/new");
  await user.click(within(dlg).getByRole("radio", { name: "302 temporary" }));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dlg).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  const row = (await screen.findByText("/old")).closest("tr")!;
  assert.match(row.textContent ?? "", /\/new/);
  assert.match(row.textContent ?? "", /302/);
  assert.match(row.textContent ?? "", /Manual/);
  const [saved] = await s.cms.redirects.list(admin);
  assert.equal(saved.status, 302);
  assert.deepEqual(await axeViolations(), []);

  // Search filters by address.
  await user.type(screen.getByRole("searchbox", { name: "Find by address" }), "zzz");
  assert.ok(await screen.findByText(/No redirect matches/));
  await user.clear(screen.getByRole("searchbox", { name: "Find by address" }));

  // Edit
  await user.click(screen.getByRole("button", { name: "Actions for /old" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  dlg = await screen.findByRole("dialog", { name: "Edit redirect" });
  await user.clear(within(dlg).getByLabelText("New address"));
  await user.type(within(dlg).getByLabelText("New address"), "/newer");
  await user.click(within(dlg).getByRole("button", { name: "Save" }));
  await screen.findByText("/newer");

  // Delete asks first.
  await user.click(screen.getByRole("button", { name: "Actions for /old" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete the redirect from /old" });
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await screen.findByText("No redirects yet");
  assert.equal((await s.cms.redirects.list(admin)).length, 0);
});

test("redirects: off on the server shows a notice and no nav entry", async () => {
  const s = makeServer();
  renderWith(
    s,
    <CmsShell>
      <CmsRedirects />
    </CmsShell>
  );
  await screen.findByText("Redirects are off");
  const nav = screen.getByRole("navigation", { name: "Admin navigation" });
  await within(nav).findByRole("link", { name: /Guide/ });
  assert.ok(!within(nav).queryByRole("link", { name: "Redirects" }));
  assert.ok(!screen.queryByRole("button", { name: "New redirect" }));
});

test("single: the nav marks it; the editor opens with the defaults and saving creates it", async () => {
  const s = makeServer({ model: true });
  renderWith(
    s,
    <CmsShell>
      <p>content</p>
    </CmsShell>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const link = await within(nav).findByRole("link", { name: /Site settings/ });
  assert.match(link.textContent ?? "", /One document/);
  cleanup();

  // A host that routes the collection to its list is sent to the editor.
  let opened = "";
  renderWith(s, <CmsDocList collection="site" onOpenDocument={(c, slug) => (opened = `${c}/${slug}`)} />);
  await waitFor(() => assert.equal(opened, "site/_single"));
  cleanup();

  renderWith(s, <CmsDocEditor collection="site" slug="_single" />);
  await screen.findByText("Not saved yet: showing the defaults");
  const name = (await screen.findByLabelText(/^name/i)) as HTMLInputElement;
  assert.equal(name.value, "My site");
  const user = userEvent.setup();
  await user.clear(name);
  await user.type(name, "Example");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal(((await s.cms.single(admin, "site", { draft: true })).fields as { name: string }).name, "Example"));
});
