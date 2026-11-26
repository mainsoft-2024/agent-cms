/** 0.24.0: the framework-free admin runtime: slot merging, pages, menus, strings. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAdminPlugin, createAdminRuntime, pickText, type AdminPluginShape } from "./admin";

type N = string | string[];
const combine = (parts: N[]): N => parts.flat();
const rt = (plugins: AdminPluginShape<N, string>[], slots?: Record<string, unknown>, onError?: (e: unknown, w: string) => void) => createAdminRuntime<N, string>({ plugins, slots, combine, onError });

test("slots: the app's part first, then plugins in order; nobody → absent; a throwing plugin is left out", () => {
  const errors: string[] = [];
  const r = rt(
    [
      { name: "seo", slots: { editorActions: () => "seo" } },
      { name: "broken", slots: { editorActions: () => { throw new Error("boom"); } } },
      { name: "translate", slots: { editorActions: (ctx: { slug: string }) => `translate:${ctx.slug}` } },
    ],
    { editorActions: () => "app", blockEditor: "AppEditor" },
    (_e, where) => errors.push(where)
  );
  assert.deepEqual((r.slots.editorActions as (c: unknown) => N)({ slug: "a" }), ["app", "seo", "translate:a"]);
  assert.deepEqual(errors, ["admin plugin broken: slot editorActions"]);
  assert.equal(r.slots.editorPanel, undefined);
  assert.equal(r.slots.blockEditor, "AppEditor");
  // Only the app: its own function, untouched.
  const app = () => "x";
  assert.equal(rt([], { fieldAddon: app }).slots.fieldAddon, app);
  // A single slot comes from the first plugin when the app has none.
  assert.equal(rt([{ name: "a", slots: { blockEditor: "A" } }, { name: "b", slots: { blockEditor: "B" } }]).slots.blockEditor, "A");
});

test("pages: literal beats parameter, decoding, unknown plugin or path → null", () => {
  const r = rt([{ name: "stats", pages: { "": "Home", "items/:id": "Item", "items/new": "New", "a/b": "AB" } }]);
  assert.deepEqual(r.page("stats", []), { plugin: "stats", page: "Home", key: "", params: {} });
  assert.equal(r.page("stats", ["items", "new"])?.page, "New");
  assert.deepEqual(r.page("stats", ["items", "a%20b"])?.params, { id: "a b" });
  assert.equal(r.page("stats", ["items"]), null);
  assert.equal(r.page("other", []), null);
  assert.equal(r.href("stats", "items/1"), "/admin/p/stats/items/1");
});

test("0.24.1: pages: the first part that differs decides, whatever order the keys were written in", () => {
  for (const pages of [{ ":kind/edit": "Edit", "items/:id": "Item" }, { "items/:id": "Item", ":kind/edit": "Edit" }]) {
    const r = rt([{ name: "p", pages }]);
    assert.equal(r.page("p", ["items", "edit"])?.page, "Item");
    assert.deepEqual(r.page("p", ["posts", "edit"])?.params, { kind: "posts" });
  }
});

test("0.24.1: wrap: each plugin's slot output is wrapped (the app's is not) with a report to onError", () => {
  const errors: string[] = [];
  const r = createAdminRuntime<N, string>({
    plugins: [{ name: "seo", slots: { editorActions: () => "seo" } }],
    slots: { editorActions: () => "app" },
    combine,
    onError: (_e, where) => errors.push(where),
    wrap: (node, o) => {
      o.report(new Error("later"));
      return `[${o.plugin}/${o.slot}:${node}]`;
    },
  });
  assert.deepEqual((r.slots.editorActions as (c: unknown) => N)({}), ["app", "[seo/editorActions:seo]"]);
  assert.deepEqual(errors, ["admin plugin seo: slot editorActions"]);
});

test("0.24.1: a plugin called \"app\" is still a plugin: its part is wrapped", () => {
  const r = createAdminRuntime<N, string>({
    plugins: [{ name: "app", slots: { editorActions: () => "theirs" } }],
    combine,
    wrap: (node, o) => `[${o.plugin}:${node}]`,
  });
  assert.deepEqual((r.slots.editorActions as (c: unknown) => N)({}), ["[app:theirs]"]);
});

test("nav, labels and strings by language", () => {
  const r = createAdminRuntime<N, string>({
    combine,
    basePath: "/cms/",
    plugins: [
      { name: "stats", label: { en: "Read counts", ko: "읽은 수 통계" }, pages: { "": "Home" }, messages: { en: { hi: "Hi {name}" }, ko: { hi: "안녕 {name}" } } },
      { name: "ops", nav: [{ label: "Ops", path: "run", admin: true }] },
      { name: "quiet", pages: { x: "X" } },
    ],
  });
  assert.deepEqual(r.nav({ locale: "ko-KR", isAdmin: false }), [{ plugin: "stats", label: "읽은 수 통계", href: "/cms/p/stats" }]);
  assert.deepEqual(r.nav({ locale: "en", isAdmin: true }).map((n) => n.href), ["/cms/p/stats", "/cms/p/ops/run"]);
  assert.equal(r.t("stats", "ko", "hi", { name: "Kim" }), "안녕 Kim");
  assert.equal(r.t("stats", "ja", "hi", { name: "Kim" }), "Hi Kim");
  assert.equal(r.t("stats", "en", "missing"), "missing");
  assert.equal(r.label("quiet", "en"), "quiet");
  assert.equal(pickText({ ja: "x" }, "en"), "x");
});

test("bad shapes are refused with a clear message", () => {
  assert.throws(() => checkAdminPlugin({ name: "Stats" }), /lowercase/);
  assert.throws(() => checkAdminPlugin({ name: "s", slots: { header: () => "" } as never }), /unknown slot "header"/);
  assert.throws(() => checkAdminPlugin({ name: "s", pages: { "/x": "X" } }), /not a path/);
  assert.throws(() => rt([{ name: "a" }, { name: "a" }]), /given twice/);
});

test("0.26.0: editorSide is a list (app first, then plugins), each part kept apart; a throwing panel renders nothing", () => {
  const errors: string[] = [];
  const r = rt(
    [
      { name: "ai", slots: { editorSide: { label: { en: "Agent", ko: "에이전트" }, render: (c: { slug: string }) => `ai:${c.slug}` } } },
      { name: "two", slots: { editorSide: [{ label: "A", render: () => "a" }, { label: "B", render: () => { throw new Error("x"); } }] } },
    ],
    { editorSide: { label: "Mine", render: () => "mine" } },
    (_e, where) => errors.push(where)
  );
  const list = r.slots.editorSide as { plugin: string | null; key: string; render: (c: unknown) => N }[];
  assert.deepEqual(list.map((x) => [x.plugin, x.key]), [[null, "app"], ["ai", "p:ai"], ["two", "p:two:1"], ["two", "p:two:2"]]);
  assert.equal(list[1].render({ slug: "s" }), "ai:s");
  assert.deepEqual(list[3].render({}), []);
  assert.deepEqual(errors, ["admin plugin two: slot editorSide"]);
  assert.equal(rt([]).slots.editorSide, undefined);
  assert.throws(() => checkAdminPlugin({ name: "bad", slots: { editorSide: { label: "x" } } }), /expected \{ label, render \}/);
});
