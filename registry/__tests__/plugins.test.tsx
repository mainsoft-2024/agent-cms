// 0.24.0 admin plugins: the plugins screen (state, settings form, restart), the shell's menu,
// plugin pages and slot merging.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { z } from "zod";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { definePlugin } from "../../src/plugin";
import { defineAdminPlugin, useCmsAdmin, usePluginT, type PluginPageProps } from "../../src/react";
import { ko } from "../cms/cms-messages";
import { CmsPluginPage } from "../cms/cms-plugin-page";
import { CmsPlugins, settingsValues } from "../cms/cms-plugins";
import { CmsShell } from "../cms/cms-shell";
import { en } from "../cms/cms-messages";
import { createT } from "../cms/cms-messages";
import { CmsProvider } from "../cms/use-cms";
import { setMobile } from "./setup";
import { axeViolations, BASE, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

/** stats (running, a page), slack-notify (fails: its URL setting is missing), deploy-notes (needs slack-notify). */
function plugins() {
  const stats = definePlugin({
    name: "stats",
    version: "1.2.0",
    setup(ctx) {
      ctx.route("GET", "summary", () => Response.json({ reads: 12480 }));
      ctx.nav({ label: "Read counts" });
    },
  });
  const slack = definePlugin({
    name: "slack-notify",
    version: "0.3.0",
    engine: ">=0.23",
    settings: z.object({
      url: z.string().url().describe("secret: Slack webhook URL"),
      channel: z.string().default("#content").describe("Channel"),
      when: z.enum(["published", "always"]).default("published").describe("When"),
      agents: z.boolean().optional().describe("Also for agents"),
    }),
    setup(ctx) {
      ctx.automationAction("post", { label: "Post to Slack", run: () => {} });
    },
  });
  const deploy = definePlugin({ name: "deploy-notes", version: "0.1.0", requires: ["slack-notify"], setup() {} });
  return [stats, slack, deploy];
}

function StatsPage({ params }: PluginPageProps) {
  const { client } = useCmsAdmin();
  const t = usePluginT("stats");
  const [n, setN] = React.useState<number | null>(null);
  React.useEffect(() => {
    void client.request<{ reads: number }>("GET", "/stats/summary").then((r) => setN(r.reads));
  }, [client]);
  return (
    <p>
      {t("reads", { n: n ?? "…" })}
      {params.id ? ` #${params.id}` : ""}
    </p>
  );
}
function Broken(): React.ReactElement {
  throw new Error("boom");
}
const statsAdmin = defineAdminPlugin({
  name: "stats",
  label: { en: "Read counts", ko: "읽은 수 통계" },
  pages: { "": StatsPage, "items/:id": StatsPage, broken: Broken },
  messages: { en: { reads: "Reads: {n}" }, ko: { reads: "읽음: {n}" } },
});
const ADMIN = [statsAdmin] as const;

test("plugins screen: states, why one failed, settings form from its schema, saving restarts it and the one that needs it", async () => {
  const s = makeServer({ plugins: plugins(), webhooks: true });
  const user = userEvent.setup();
  renderWith(s, <CmsPlugins />, { plugins: ADMIN });
  const table = await screen.findByRole("table");
  // Built-in webhooks and automations are listed too.
  await within(table).findByText("Read counts");
  await screen.findByText(/· 1 failed to start/);
  const row = (name: string) => within(table).getByText(name).closest("tr")!;
  assert.match(row("slack-notify").textContent ?? "", /0\.3\.0.*Failed to start/);
  assert.match(row("deploy-notes").textContent ?? "", /Off \(needs another plugin\)/);
  assert.match(row("webhooks").textContent ?? "", /Built in.*On/);
  assert.match(row("stats").textContent ?? "", /Routes 1 · Menu entries 1 · Pages 3/);

  await user.click(within(row("slack-notify")).getByRole("button", { name: "slack-notify" }));
  const panel = await screen.findByRole("complementary", { name: "slack-notify" });
  within(panel).getByText("Switched off: it could not start");
  within(panel).getByText(/settings: url/);
  within(panel).getByText("Also off, as they need this plugin: deploy-notes");
  // 0.24.1: what it adds, by name.
  within(panel).getByText("slack-notify.post");
  assert.deepEqual(await axeViolations(), []);

  // Restarting the one that needs it does not claim success while it stays off.
  await user.click(within(row("deploy-notes")).getByRole("button", { name: "deploy-notes" }));
  const dep = await screen.findByRole("complementary", { name: "deploy-notes" });
  within(dep).getByText("Off — plugins it needs are not running: slack-notify");
  await user.click(within(dep).getByRole("button", { name: "Restart" }));
  await within(dep).findByText("Still off — plugins it needs are not running: slack-notify");
  assert.ok(!screen.queryByText("Restarted"));
  await user.click(within(row("slack-notify")).getByRole("button", { name: "slack-notify" }));
  await screen.findByRole("complementary", { name: "slack-notify" });

  await user.click(within(await screen.findByRole("complementary", { name: "slack-notify" })).getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "slack-notify settings" });
  const url = (await within(dialog).findByLabelText(/Slack webhook URL/)) as HTMLInputElement;
  assert.equal(url.type, "password");
  within(dialog).getByText("Stored encrypted; it is not shown again after saving.");
  assert.equal((within(dialog).getByLabelText("Channel") as HTMLInputElement).value, "#content");
  const when = within(dialog).getByLabelText("When") as HTMLSelectElement;
  assert.equal(when.selectedOptions[0]?.textContent, "published");
  within(dialog).getByRole("checkbox", { name: "Also for agents" });
  assert.deepEqual(await axeViolations(), []);
  await user.type(url, "https://hooks.example.com/T1");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await screen.findByText("Saved and restarted");
  await waitFor(() => assert.match(row("slack-notify").textContent ?? "", /On/));
  await waitFor(() => assert.match(row("deploy-notes").textContent ?? "", /On/));
  assert.ok(!screen.queryByText(/failed to start/));

  // The secret is stored, never sent back: the form says so and keeps it when left empty.
  await user.click(within(screen.getByRole("complementary", { name: "slack-notify" })).getByRole("button", { name: "Settings" }));
  const again = await screen.findByRole("dialog", { name: "slack-notify settings" });
  await within(again).findByText("A value is stored. Type only to change it.");
  assert.equal((within(again).getByLabelText(/Slack webhook URL/) as HTMLInputElement).value, "");
  await user.clear(within(again).getByLabelText("Channel"));
  await user.type(within(again).getByLabelText("Channel"), "#news");
  await user.click(within(again).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  const saved = await s.cms.plugins.settings("slack-notify");
  assert.deepEqual([saved?.values.channel, saved?.values.url], ["#news", "••••••••"]);
});

test("plugins screen: restart a failed plugin; a bad setting is refused with the server's reason", async () => {
  let fail = true;
  const flaky = definePlugin({
    name: "flaky",
    setup() {},
    start() {
      if (fail) throw new Error("no connection");
    },
  });
  const s = makeServer({ plugins: [flaky] });
  const user = userEvent.setup();
  renderWith(s, <CmsPlugins />, { messages: ko });
  const table = await screen.findByRole("table");
  await user.click(within(table).getByRole("button", { name: "flaky" }));
  const panel = await screen.findByRole("complementary", { name: "flaky" });
  within(panel).getByText("시작하지 못해서 꺼 둠");
  within(panel).getByText("no connection");
  await user.click(within(panel).getByRole("button", { name: "다시 시작" }));
  await within(panel).findByText(/시작하지 못함: no connection/);
  fail = false;
  await user.click(within(panel).getByRole("button", { name: "다시 시작" }));
  await screen.findByText("다시 시작함");
  await waitFor(() => assert.match(within(table).getByText("flaky").closest("tr")!.textContent ?? "", /켜짐/));
});

test("settings form: decimals save; untouched values go back as stored (null, typed choices)", async () => {
  const tuning = definePlugin({
    name: "tuning",
    settings: z.object({
      ratio: z.number().describe("Ratio"),
      sticky: z.boolean().nullable().default(true).describe("Sticky"),
      level: z.union([z.literal(1), z.literal(2)]).optional().describe("Level"),
      mode: z.literal(2).describe("Mode"),
      note: z.string().optional().describe("Note"),
    }),
    setup() {},
  });
  const s = makeServer({ plugins: [tuning] });
  await s.cms.plugins.saveSettings("tuning", { ratio: 1, sticky: null, mode: 2, note: "  keep spaces  " });
  const user = userEvent.setup();
  renderWith(s, <CmsPlugins />);
  const table = await screen.findByRole("table");
  await user.click(within(table).getByRole("button", { name: "tuning" }));
  await user.click(within(await screen.findByRole("complementary", { name: "tuning" })).getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "tuning settings" });
  const ratio = (await within(dialog).findByLabelText("Ratio")) as HTMLInputElement;
  await user.clear(ratio);
  await user.type(ratio, "0.5");
  assert.ok(ratio.checkValidity());
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  const saved = await s.cms.plugins.settings("tuning");
  assert.deepEqual(saved?.values, { ratio: 0.5, sticky: null, mode: 2, note: "  keep spaces  " });
});

test("settings values: numbers, JSON and empty secrets", () => {
  const t = createT(en);
  const fields = [
    { key: "n", type: "number", label: "Count", optional: false },
    { key: "j", type: "json", label: "Extra", optional: true },
    { key: "s", type: "secret", label: "Key", optional: false },
    { key: "b", type: "boolean", label: "On", optional: true },
  ] as const;
  assert.deepEqual(settingsValues([...fields], { n: "3", j: '{"a":1}', s: "", b: true }, t), { values: { n: 3, j: { a: 1 }, b: true } });
  assert.deepEqual(settingsValues([...fields], { n: "x", j: "", s: "", b: false }, t), { error: "Count: not a number" });
  assert.deepEqual(settingsValues([...fields], { n: "1", j: "{", s: "", b: false }, t), { error: "Extra: not valid JSON" });
});

test("0.24.1: the panel names what a plugin adds, its pages included", async () => {
  const s = makeServer({ plugins: plugins() });
  const user = userEvent.setup();
  renderWith(s, <CmsPlugins />, { plugins: ADMIN });
  const table = await screen.findByRole("table");
  await user.click(within(table).getByRole("button", { name: "Read counts" }));
  const panel = await screen.findByRole("complementary", { name: "Read counts" });
  const items = within(panel)
    .getAllByRole("listitem")
    .map((li) => li.textContent);
  assert.deepEqual(items, ["RoutesGET /stats/summary", "Menu entriesRead counts", "Pages/admin/p/stats", "Pages/admin/p/stats/items/:id", "Pages/admin/p/stats/broken"]);
});

test("0.24.1: shell: a plugin link to a CMS page never shows as current next to the CMS's own entry", async () => {
  const s = makeServer({ plugins: [definePlugin({ name: "mirror", setup: (ctx) => ctx.nav({ label: "Mirror", href: "/admin/plugins" }) })] });
  render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch}>
      <CmsShell activeHref="/admin/plugins">
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const mirror = await within(nav).findByRole("link", { name: "Mirror" });
  assert.equal(mirror.getAttribute("aria-current"), null);
  assert.equal(within(nav).getByRole("link", { name: /^Plugins/ }).getAttribute("aria-current"), "page");
  assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
});

test("0.24.2: shell: a CMS entry that is not shown (forms off) does not take its page from a plugin", async () => {
  const s = makeServer({ plugins: [definePlugin({ name: "my-forms", setup: (ctx) => ctx.nav({ label: "My forms", href: "/admin/forms" }) })] });
  render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch}>
      <CmsShell activeHref="/admin/forms">
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const mine = await within(nav).findByRole("link", { name: "My forms" });
  assert.ok(!within(nav).queryByRole("link", { name: "Forms" }));
  await waitFor(() => assert.equal(mine.getAttribute("aria-current"), "page"));
  assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
});

test("0.25.1: shell: on a forms sub-page an exact link wins over Forms (one current entry)", async () => {
  const s = makeServer({ forms: true, plugins: [definePlugin({ name: "reports", setup: (ctx) => ctx.nav({ label: "Form report", href: "/admin/forms/report" }) })] });
  const extra = [{ label: "App", items: [{ label: "Exports", href: "/admin/forms/exports" }] }];
  const { unmount } = render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch}>
      <CmsShell activeHref="/admin/forms/exports" extraNav={extra}>
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  let nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const exportsLink = await within(nav).findByRole("link", { name: "Exports" });
  await within(nav).findByRole("link", { name: /^Forms/ });
  await waitFor(() => assert.equal(exportsLink.getAttribute("aria-current"), "page"));
  assert.equal(within(nav).getByRole("link", { name: /^Forms/ }).getAttribute("aria-current"), null);
  assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
  unmount();

  // A plugin's exact link, too; a page under Forms nobody links to stays with Forms.
  for (const [at, current] of [["/admin/forms/report", "Form report"], ["/admin/forms/contact", "Forms"]] as const) {
    const r = render(
      <CmsProvider baseUrl={BASE} fetch={s.fetch}>
        <CmsShell activeHref={at}>
          <p>body</p>
        </CmsShell>
      </CmsProvider>
    );
    nav = await screen.findByRole("navigation", { name: "Admin navigation" });
    await within(nav).findByRole("link", { name: "Form report" });
    const want = within(nav).getByRole("link", { name: current === "Forms" ? /^Forms/ : current });
    await waitFor(() => assert.equal(want.getAttribute("aria-current"), "page"));
    assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1, at);
    r.unmount();
  }
});

test("0.24.2: shell: an activeCollection that is no collection (\"p\" from the path) does not hide the plugin's current entry", async () => {
  const s = makeServer({ plugins: plugins() });
  render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch} plugins={ADMIN}>
      <CmsShell activeCollection="p" activeHref="/admin/p/stats">
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const link = await within(nav).findByRole("link", { name: "Read counts" });
  await waitFor(() => assert.equal(link.getAttribute("aria-current"), "page"));
});

test("0.24.1: shell: a plugin link to a collection is not current next to that collection", async () => {
  const s = makeServer({ plugins: [definePlugin({ name: "mirror", setup: (ctx) => ctx.nav({ label: "Mirror", href: "/admin/guide" }) })] });
  render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch}>
      <CmsShell activeCollection="guide" activeHref="/admin/guide">
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  await within(nav).findByRole("link", { name: "Mirror" });
  await waitFor(() => assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1));
  assert.equal(within(nav).getByRole("link", { name: "Mirror" }).getAttribute("aria-current"), null);
});

test("shell: Plugins with the failed count for admins; Extensions lists server menus (no href → its page) and admin plugin pages once", async () => {
  const s = makeServer({ plugins: plugins() });
  render(
    <CmsProvider baseUrl={BASE} fetch={s.fetch} plugins={ADMIN}>
      <CmsShell activeHref="/admin/p/stats/items/1">
        <p>body</p>
      </CmsShell>
    </CmsProvider>
  );
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  const plugin = await within(nav).findByRole("link", { name: /^Plugins/ });
  assert.equal(plugin.getAttribute("href"), "/admin/plugins");
  await waitFor(() => assert.match(plugin.textContent ?? "", /1 failed to start/));
  const ext = within(nav).getAllByRole("link", { name: "Read counts" });
  assert.equal(ext.length, 1);
  assert.equal(ext[0].getAttribute("href"), "/admin/p/stats");
  assert.equal(ext[0].getAttribute("aria-current"), "page");
  within(nav).getByRole("heading", { name: "Extensions" });
});

test("plugin page: the page for the path with params and the plugin's strings; a missing page; a page that throws", async () => {
  const s = makeServer({ plugins: plugins() });
  const view = renderWith(s, <CmsPluginPage plugin="stats" path={["items", "7"]} />, { plugins: ADMIN, messages: ko });
  await screen.findByRole("heading", { name: "읽은 수 통계" });
  await screen.findByText("읽음: 12480 #7");
  view.rerender(
    <CmsProvider baseUrl={BASE} fetch={s.fetch} plugins={ADMIN}>
      <CmsPluginPage plugin="stats" path={["nope"]} />
    </CmsProvider>
  );
  await screen.findByText("This page is not here");
  const quiet = console.error;
  console.error = () => {};
  try {
    view.rerender(
      <CmsProvider baseUrl={BASE} fetch={s.fetch} plugins={ADMIN}>
        <CmsPluginPage plugin="stats" path={["broken"]} />
      </CmsProvider>
    );
    await screen.findByText("This page stopped with an error");
  } finally {
    console.error = quiet;
  }
  screen.getByRole("heading", { name: "Read counts" });
});

test("slots: the app's button and each plugin's show side by side in the editor's slot", async () => {
  const s = makeServer();
  const seo = defineAdminPlugin({ name: "seo", slots: { editorActions: (ctx) => <button type="button">SEO {ctx.slug}</button> } });
  const translate = defineAdminPlugin({ name: "translate", slots: { editorActions: () => <button type="button">Translate</button> } });
  function Probe() {
    const { runtime } = useCmsAdmin();
    const fn = runtime.slots.editorActions as (c: { slug: string }) => React.ReactNode;
    return <div data-testid="slot">{fn({ slug: "hello" })}</div>;
  }
  renderWith(s, <Probe />, { plugins: [seo, translate], slots: { editorActions: () => <button type="button">Mine</button> } });
  const slot = await screen.findByTestId("slot");
  assert.deepEqual(
    within(slot)
      .getAllByRole("button")
      .map((b) => b.textContent),
    ["Mine", "SEO hello", "Translate"]
  );
});

test("0.24.1: slots: a plugin part that throws while rendering is left out; the rest stays", async () => {
  const s = makeServer();
  function Bad(): React.ReactElement {
    throw new Error("render boom");
  }
  const broken = defineAdminPlugin({ name: "broken", slots: { editorActions: () => <Bad /> } });
  const ok = defineAdminPlugin({ name: "ok", slots: { editorActions: () => <button type="button">Fine</button> } });
  function Probe() {
    const { runtime } = useCmsAdmin();
    const fn = runtime.slots.editorActions as (c: { slug: string }) => React.ReactNode;
    return <div data-testid="slot">{fn({ slug: "hello" })}</div>;
  }
  const quiet = console.error;
  const seen: string[] = [];
  console.error = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    renderWith(s, <Probe />, { plugins: [broken, ok], slots: { editorActions: () => <button type="button">Mine</button> } });
    const slot = await screen.findByTestId("slot");
    await waitFor(() =>
      assert.deepEqual(
        within(slot)
          .getAllByRole("button")
          .map((b) => b.textContent),
        ["Mine", "Fine"]
      )
    );
  } finally {
    console.error = quiet;
  }
  assert.ok(seen.some((l) => l.includes("admin plugin broken: slot editorActions")), seen.join("\n"));
});

test("0.24.1: slots: a failed part is not handed to the next plugin when an earlier one drops out", async () => {
  const s = makeServer();
  let aThrows = false;
  function Bad(): React.ReactElement {
    throw new Error("render boom");
  }
  const a = defineAdminPlugin({ name: "a", slots: { editorActions: () => { if (aThrows) throw new Error("gone"); return <button type="button">A</button>; } } });
  const b = defineAdminPlugin({ name: "b", slots: { editorActions: () => <Bad /> } });
  const c = defineAdminPlugin({ name: "c", slots: { editorActions: () => <button type="button">C</button> } });
  function Probe({ n }: { n: number }) {
    const { runtime } = useCmsAdmin();
    const fn = runtime.slots.editorActions as (c: { n: number }) => React.ReactNode;
    return <div data-testid="slot">{fn({ n })}</div>;
  }
  const quiet = console.error;
  console.error = () => {};
  try {
    const view = renderWith(s, <Probe n={1} />, { plugins: [a, b, c] });
    const names = () => within(screen.getByTestId("slot")).queryAllByRole("button").map((x) => x.textContent);
    await waitFor(() => assert.deepEqual(names(), ["A", "C"]));
    aThrows = true;
    view.rerender(
      <CmsProvider baseUrl={BASE} fetch={s.fetch} plugins={[a, b, c]}>
        <Probe n={2} />
      </CmsProvider>
    );
    await waitFor(() => assert.deepEqual(names(), ["C"]));
  } finally {
    console.error = quiet;
  }
});

test("phone: the list, then the plugin's details on their own with a way back", async () => {
  setMobile(true);
  const s = makeServer({ plugins: plugins() });
  const user = userEvent.setup();
  renderWith(s, <CmsPlugins />, { plugins: ADMIN });
  const table = await screen.findByRole("table");
  // 0.24.1: on a phone each row says its version and what it adds (or why it failed) under the name.
  await within(table).findByText("1.2.0 · Routes 1 · Menu entries 1 · Pages 3");
  within(table).getByText("settings: url: invalid_type");
  assert.equal(within(table).getAllByText("Built in · Events 1").length, 2);
  await user.click(within(table).getByRole("button", { name: "slack-notify" }));
  const heading = await screen.findByRole("heading", { name: "slack-notify" });
  assert.ok(!screen.queryByRole("table"));
  // Focus moves to the details, then back to the row it came from.
  await waitFor(() => assert.ok(heading.contains(document.activeElement)));
  await user.click(screen.getByRole("button", { name: "Plugins" }));
  const again = await screen.findByRole("table");
  await waitFor(() => assert.ok(document.activeElement === within(again).getByRole("button", { name: "slack-notify" })));
});
