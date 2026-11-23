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
import { RelationPicker } from "../cms/cms-fields-more";
import { chooseTemplate, SeoPanel } from "../cms/cms-structure";
import type { TemplateView } from "@mainsoft/agent-cms/client";
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

test("rename: Save with a changed published address explains and does not publish; the dialog's button publishes", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "docs", { slug: "intro", title: "Intro", body: "x" }, { publish: true });
  let renamed = "";
  renderWith(s, <CmsDocEditor collection="docs" slug="intro" onRenamed={(c, slug) => (renamed = `${c}/${slug}`)} />);
  await screen.findByLabelText(/^Title/);
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "welcome" } });
  const user = userEvent.setup();
  const before = s.requests.length;
  await user.click(screen.getByRole("button", { name: "Save" }));
  const dlg = await screen.findByRole("alertdialog", { name: "The address changes only when you publish" });
  // Nothing went to the server: a draft save would be refused, and Save must never publish by itself.
  assert.deepEqual(
    s.requests.slice(before).filter((r) => r.method !== "GET" && !/\/(presence|_diagnose)$/.test(r.path)),
    []
  );
  assert.equal((await s.cms.get(admin, "docs", "intro")).slug, "intro");
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));

  // Publish with the changed address asks the same; confirming publishes at the new one.
  await user.click(screen.getByRole("button", { name: "Publish" }));
  const again = await screen.findByRole("alertdialog", { name: "The address changes only when you publish" });
  await user.click(within(again).getByRole("button", { name: "Publish at the new address" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "docs", "welcome")).slug, "welcome"));
  await waitFor(() => assert.equal(renamed, "docs/welcome"));
});

test("rename: without the right to publish the dialog's button is off, with a note", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "docs", { slug: "intro", title: "Intro", body: "x" }, { publish: true });
  // Someone who may edit but not publish: the schema says so.
  const realFetch = s.fetch;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    if (!String(input).includes("/_schema")) return res;
    const body = (await res.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, canPublish: false }), { status: res.status, headers: res.headers });
  }) as typeof fetch;
  renderWith({ ...s, fetch: fetchFn }, <CmsDocEditor collection="docs" slug="intro" />);
  await screen.findByLabelText(/^Title/);
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "welcome" } });
  fireEvent.keyDown(screen.getByLabelText(/^Slug/), { key: "s", ctrlKey: true });
  const dlg = await screen.findByRole("alertdialog", { name: "The address changes only when you publish" });
  assert.equal((within(dlg).getByRole("button", { name: "Publish at the new address" }) as HTMLButtonElement).disabled, true);
  assert.ok(within(dlg).getByText(/cannot publish this document yourself/));
});

test("relation picker: an answer for an older search is dropped; Enter waits for the current one", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "team", { slug: "paul", title: "Paul Park", body: "x" }, { publish: true });
  await s.cms.create(admin, "team", { slug: "lee", title: "Lee Minho", body: "x" }, { publish: true });
  // Searches are held until the test lets them through, by their text.
  const held = new Map<string, () => void>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/team") || (init?.method ?? "GET") !== "GET") return s.fetch(input, init);
    const q = url.searchParams.get("q") ?? "";
    await new Promise<void>((go) => held.set(q, go));
    return s.fetch(input, init);
  }) as typeof fetch;
  const picked: string[] = [];
  renderWith({ ...s, fetch: fetchFn }, <RelationPicker title="Author" collections={["team"]} onPick={(d) => picked.push(d.slug)} onClose={() => {}} />);
  const box = await screen.findByRole("combobox", { name: "Search by title or address" });
  await waitFor(() => assert.ok(held.has("")));
  const user = userEvent.setup();
  await user.type(box, "lee");
  await waitFor(() => assert.ok(held.has("lee")));
  held.get("lee")!();
  await screen.findByText("Lee Minho");
  // The first search (everyone) answers late: it must not replace the results for "lee".
  held.get("")!();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!screen.queryByText("Paul Park"));

  // A new search on its way: the old rows stay but Enter picks nothing.
  await user.clear(box);
  await user.type(box, "paul");
  await waitFor(() => assert.ok(held.has("paul")));
  await user.keyboard("{Enter}");
  assert.deepEqual(picked, []);
  held.get("paul")!();
  await screen.findByText("Paul Park");
  await user.keyboard("{Enter}");
  assert.deepEqual(picked, ["paul"]);
  // Anything else still held is let go so the test ends cleanly.
  for (const go of held.values()) go();
});

test("redirects: the home page / is a valid new address", async () => {
  const s = makeServer({ model: true });
  renderWith(s, <CmsRedirects />);
  await screen.findByText("No redirects yet");
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "New redirect" })[0]);
  const dlg = await screen.findByRole("dialog", { name: "New redirect" });
  await user.clear(within(dlg).getByLabelText("Old address"));
  await user.type(within(dlg).getByLabelText("Old address"), "/old-home");
  assert.equal((within(dlg).getByLabelText("New address") as HTMLInputElement).value, "/");
  const create = within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement;
  assert.equal(create.disabled, false);
  await user.click(create);
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  const [saved] = await s.cms.redirects.list(admin);
  assert.equal(saved.from, "/old-home");
  assert.equal(saved.to, "/");
});

test("templates: values the schema no longer takes are left out, and the editor says which", async () => {
  const s = makeServer({ model: true });
  chooseTemplate("guide", { key: "old", label: "Old one", title: "From an old template", body: "x", fields: { featured: true, plans: ["pro"], order: "high", audience: "nobody", removed: 1 } } as TemplateView);
  renderWith(s, <CmsDocEditor collection="guide" />);
  await waitFor(() => assert.equal((screen.getByLabelText(/^Title/) as HTMLInputElement).value, "From an old template"));
  assert.ok(await screen.findByText(/Started from “Old one”/));
  const status = await screen.findByText(/order, audience, removed/);
  assert.match(status.textContent ?? "", /Started from “Old one”/);
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "from-old" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.deepEqual((await s.cms.get(admin, "guide", "from-old", { draft: true })).fields, { featured: true, plans: ["pro"] }));
});

test("referenced: hiding a document others point at lists them, then hides anyway (list row and editor menu)", async () => {
  const s = makeServer({ model: true });
  const paul = await s.cms.create(admin, "team", { slug: "paul", title: "Paul Park", body: "x" }, { publish: true });
  await s.cms.create(admin, "docs", { slug: "intro", title: "Intro", body: "x", fields: { author: paul.id } }, { publish: true });
  renderWith(s, <CmsDocList collection="team" onOpenDocument={() => {}} />);
  await screen.findByText("Paul Park");
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Select Paul Park" }));
  await user.click(within(screen.getByRole("toolbar", { name: "Bulk actions" })).getByRole("button", { name: "Hide" }));
  const confirm = await screen.findByRole("dialog", { name: /Hide/ });
  await user.click(within(confirm).getByRole("button", { name: "Hide" }));
  const refs = await screen.findByRole("alertdialog", { name: "Other documents point at “Paul Park”" });
  await within(refs).findByText("Intro");
  assert.ok(within(refs).getByText(/readers following those fields will find nothing/));
  assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).status, "published", "nothing hidden yet");
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(refs).getByRole("button", { name: "Hide anyway" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).status, "archived"));
  const forced = s.requests.find((r) => r.method === "POST" && r.path.endsWith("/team/paul/archive"));
  assert.deepEqual(forced?.body, { force: true });
  cleanup();

  // The editor: More → Hide asks the same, Cancel leaves it, Hide anyway hides it; then Unhide.
  await s.cms.unarchive(admin, "team", "paul");
  renderWith(s, <CmsDocEditor collection="team" slug="paul" />);
  await screen.findByLabelText(/^Title/);
  await user.click(screen.getAllByRole("button", { name: "More" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: "Hide" }));
  let ask = await screen.findByRole("alertdialog", { name: "Other documents point at “Paul Park”" });
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).status, "published");
  await user.click(screen.getAllByRole("button", { name: "More" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: "Hide" }));
  ask = await screen.findByRole("alertdialog", { name: "Other documents point at “Paul Park”" });
  await user.click(within(ask).getByRole("button", { name: "Hide anyway" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).status, "archived"));
  await user.click(screen.getAllByRole("button", { name: "More" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: "Unhide" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "team", "paul", { draft: true })).status, "published"));
});

test("redirects: a redirect can follow a document (picker); the list shows its title and 30-day visits, sortable", async () => {
  const s = makeServer({ model: true });
  await s.cms.create(admin, "docs", { slug: "pricing", title: "Pricing page", body: "x" }, { publish: true });
  await s.cms.redirects.create(admin, { from: "/busy", to: "/docs" });
  for (let i = 0; i < 3; i++) await s.cms.redirects.resolve("/busy");
  renderWith(s, <CmsRedirects />);
  await screen.findByText("/busy");
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "New redirect" })[0]);
  const dlg = await screen.findByRole("dialog", { name: "New redirect" });
  await user.clear(within(dlg).getByLabelText("Old address"));
  await user.type(within(dlg).getByLabelText("Old address"), "/old-pricing");
  await user.click(within(dlg).getByRole("radio", { name: "Document" }));
  const create = within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement;
  assert.equal(create.disabled, true, "no document yet");
  await user.click(within(dlg).getByRole("button", { name: /Choose a document/ }));
  const picker = await screen.findByRole("dialog", { name: "Choose: Document" });
  await user.click(within(picker).getByRole("tab", { name: "Docs" }));
  await user.type(within(picker).getByRole("combobox"), "pricing");
  await within(picker).findByText("Pricing page");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.ok(!screen.queryByRole("dialog", { name: "Choose: Document" })));
  // Focus goes back to the button that opened the search, which now names the document.
  await waitFor(() => assert.match(document.activeElement?.textContent ?? "", /Pricing page/));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(screen.getByRole("dialog", { name: "New redirect" })).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  const saved = (await s.cms.redirects.list(admin)).find((r) => r.from === "/old-pricing")!;
  assert.ok(saved.toDocumentId);
  const row = (await screen.findByText("/old-pricing")).closest("tr")!;
  assert.match(row.textContent ?? "", /Pricing page/);
  // The document moves: the redirect follows it.
  await s.cms.update(admin, "docs", "pricing", { slug: "plans" }, { publish: true });
  assert.deepEqual(await s.cms.redirects.resolve("/old-pricing"), { to: "/docs/plans", status: 301 });

  // 30-day visits: a chart with a spoken summary, and sorting by it.
  const busy = screen.getByText("/busy").closest("tr")!;
  assert.ok(within(busy).getByRole("img", { name: /^3 visits in the last 30 days; busiest day 3; today 3$/ }));
  await user.click(screen.getByRole("button", { name: "Sort by visits in the last 30 days" }));
  const firstRow = screen.getAllByRole("row")[1];
  assert.match(firstRow.textContent ?? "", /\/busy/);
  assert.equal(screen.getByRole("columnheader", { name: /Last 30 days/ }).getAttribute("aria-sort"), "descending");
  assert.deepEqual(await axeViolations(), []);

  // Editing back to an address stops following the document.
  await user.click(screen.getByRole("button", { name: "Actions for /old-pricing" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const edit = await screen.findByRole("dialog", { name: "Edit redirect" });
  assert.equal(within(edit).getByRole("radio", { name: "Document" }).getAttribute("aria-checked"), "true");
  await user.click(within(edit).getByRole("radio", { name: "Address" }));
  await user.clear(within(edit).getByLabelText("New address"));
  await user.type(within(edit).getByLabelText("New address"), "/docs");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal((await s.cms.redirects.list(admin)).find((r) => r.from === "/old-pricing")?.toDocumentId, null));
});

test("seo panel: a library share image smaller than 1200×630 shows its size with a warning", async () => {
  const s = makeServer({ media: true });
  const add = async (name: string, w: number, h: number) => {
    const bytes = new Uint8Array(200);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255]);
    const { asset, upload } = await s.cms.assets.requestUpload(admin, { name, size: bytes.length });
    if (upload.kind === "single") await s.stores.public.send(upload.url, bytes);
    return s.cms.assets.completeUpload(admin, asset.id);
  };
  const small = await add("small.png", 800, 400);
  const big = await add("big.png", 1600, 900);
  function Panel({ image }: { image: string }) {
    const [v, setV] = React.useState<{ image?: string | null } | null>({ image });
    return <SeoPanel value={v} onChange={setV} fallback={{ title: "T", description: "D", image: null }} limits={{ titleMax: 60, descriptionMax: 160 }} url="/x" />;
  }
  renderWith(s, <Panel image={`asset:${small.id}/small.png`} />);
  const warn = await screen.findByText(/800×400: smaller than 1200×630/);
  assert.equal(screen.getByLabelText("Share image").getAttribute("aria-describedby"), warn.closest("p")?.id);
  assert.deepEqual(await axeViolations(), []);
  cleanup();
  renderWith(s, <Panel image={`asset:${big.id}/big.png`} />);
  await screen.findByText("1600×900");
  assert.ok(!screen.queryByText(/smaller than 1200×630/));
});
