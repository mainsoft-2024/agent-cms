import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CmsAdminProvider, createReactAdminRuntime } from "@mainsoft/agent-cms/react";
import { createTestCms } from "@mainsoft/agent-cms/testing";
import stats, { type StatsSummary } from "./index";
import statsAdmin, { StatsPage } from "./admin";

test("stats: reads are counted, rolled up on cron, and summed by the route and the tool", async () => {
  const t = createTestCms({ plugins: [stats({ top: 5 })] });
  try {
    await t.ready();
    await t.cms.create(t.admin, "pages", { slug: "hello", title: "Hello", body: "Hi\n" }, { publish: true });
    await t.cms.create(t.admin, "pages", { slug: "quiet", title: "Quiet", body: "…\n" }, { publish: true });
    await t.cms.create(t.admin, "pages", { slug: "draft", title: "Draft", body: "…\n" });
    await t.flush();

    // Visitors read `hello` three times; a list and a draft do not count.
    for (let i = 0; i < 3; i++) assert.equal((await t.fetch("/collections/pages/hello", {}, { as: "anon" })).status, 200);
    await t.fetch("/collections/pages", {}, { as: "anon" });
    await t.fetch("/collections/pages/draft?draft=1");

    // Nothing in the store until the job runs.
    assert.equal(((await (await t.fetch("/stats/summary")).json()) as StatsSummary).total, 0);
    const run = await t.cron();
    assert.ok(run.jobs.ok >= 1, JSON.stringify(run.jobs));

    const summary = (await (await t.fetch("/stats/summary")).json()) as StatsSummary;
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.top, [{ collection: "pages", slug: "hello", reads: 3 }]);
    assert.deepEqual(summary.unread.map((u) => u.slug), ["quiet"]);

    // Visitors and writers do not see the numbers (they name documents); admins' agents get the same summary.
    assert.equal((await t.fetch("/stats/summary", {}, { as: "anon" })).status, 401);
    assert.equal((await t.fetch("/stats/summary", {}, { as: "writer" })).status, 403);
    await assert.rejects(t.tool("stats_summary", {}, { as: "writer" }), /admins only/);
    const tool = await t.tool("stats_summary", {});
    assert.deepEqual(tool, { ok: true, value: summary });
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test("stats: only the collections it is given", async () => {
  const { defineCollection } = await import("@mainsoft/agent-cms");
  const t = createTestCms({
    collections: [defineCollection({ slug: "pages", label: "Pages", visibility: "public" }), defineCollection({ slug: "news", label: "News", visibility: "public" })],
    plugins: [stats({ collections: ["news"] })],
  });
  try {
    await t.cms.create(t.admin, "pages", { slug: "a", title: "A", body: "a\n" }, { publish: true });
    await t.cms.create(t.admin, "news", { slug: "b", title: "B", body: "b\n" }, { publish: true });
    await t.fetch("/collections/pages/a", {}, { as: "anon" });
    await t.fetch("/collections/news/b", {}, { as: "anon" });
    await t.cron();
    const r = await t.tool("stats_summary");
    assert.ok(r.ok);
    assert.deepEqual((r.value as StatsSummary).top, [{ collection: "news", slug: "b", reads: 1 }]);
  } finally {
    await t.close();
  }
});

test("stats admin: a page and a menu entry, in the admin's language", () => {
  const runtime = createReactAdminRuntime({ plugins: [statsAdmin] });
  assert.deepEqual(runtime.nav({ locale: "ko", isAdmin: false }), [{ plugin: "stats", label: "조회수 통계", href: "/admin/p/stats" }]);
  assert.equal(runtime.page("stats", [])?.page, StatsPage);
  // The first render (before the numbers come): the title in Korean, then "loading".
  const client = { request: () => new Promise(() => {}) } as never;
  const html = renderToStaticMarkup(
    React.createElement(
      CmsAdminProvider,
      { value: { client, me: null, reloadMe: () => {}, locale: "ko", baseUrl: "/api/cms", basePath: "/admin", appUrl: "/", toast: () => 0, runtime } },
      React.createElement(StatsPage, { plugin: "stats", path: [], params: {} })
    )
  );
  assert.match(html, /<h1[^>]*>조회수 통계<\/h1>/);
  assert.match(html, /불러오는 중/);
});
