/** 0.10.0 over REST, the admin client and the agent tools: schedules, the cron route, trash, reviews, comments, releases, filters, presence, preview. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestClient, isCmsRemoteError } from "./client";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import { callTool, toolsFor } from "./tools";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const bot: Actor = { kind: "key", id: "k1", label: "docs-bot", scopes: ["read", "write", "publish"], collections: null };

function setup() {
  const clock = { t: Date.parse("2026-11-20T00:00:00Z") };
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `/guide/${d.slug}` });
  const news = defineCollection({ slug: "news", label: "News", visibility: "public", url: (d) => `/news/${d.slug}`, review: { agents: "required" } });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide, news], now: () => new Date(clock.t), previewSecret: "p".repeat(32), cronSecret: "cron-secret-cron-secret" });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch;
  const api = createRestClient({ url: "http://app.test/api/cms", fetch: doFetch });
  const at = (minutes: number) => new Date(clock.t + minutes * 60_000).toISOString();
  return { cms, api, clock, at, doFetch };
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsRemoteError(e) ? e.code : Promise.reject(e)));

test("rest: schedule, the cron route with its own secret, and the trash", async () => {
  const { api, clock, at, doFetch } = setup();
  await api.create("guide", { slug: "a", title: "A", body: "## One\n\ntext\n" });
  const d = await api.schedule("guide", "a", { publishAt: at(5) });
  assert.equal(d.schedule?.publishAt, at(5));
  assert.equal((await api.counts("guide")).scheduled, 1);
  assert.equal(await code(api.schedule("guide", "a", { publishAt: at(-5) })), "schedule_invalid");

  const cron = (auth?: string) => doFetch("http://app.test/api/cms/_cron", { method: "POST", headers: auth ? { authorization: auth } : {} });
  assert.equal((await cron()).status, 401);
  assert.equal((await cron("Bearer wrong-secret-wrong-secre")).status, 401);
  clock.t += 6 * 60_000;
  const run = (await (await cron("Bearer cron-secret-cron-secret")).json()) as { published: string[] };
  assert.deepEqual(run.published, ["guide/a"]);
  assert.equal((await api.get("guide", "a")).status, "published");
  assert.equal(await code(api.unschedule("guide", "a")), "not_scheduled");

  await api.remove("guide", "a");
  const trash = await api.trash();
  assert.deepEqual([trash.days, trash.canPurge, trash.items.map((i) => [i.kind, i.slug, i.state])], [30, true, [["document", "a", "published"]]]);
  assert.deepEqual(await api.restoreTrash(trash.items), { restored: 1 });
  assert.equal((await api.get("guide", "a")).title, "A");
  await api.remove("guide", "a");
  assert.deepEqual(await api.purgeTrash("all"), { purged: 1 });
  assert.equal((await api.me()).trashDays, 30);
});

test("rest: review, comments, releases, filters, presence, labels and the unsaved preview", async () => {
  const { cms, api } = setup();
  await cms.create(bot, "news", { slug: "n", title: "N", body: "## Numbers\n\nSales grew 12%.\n" });
  assert.equal((await api.schema("news")).review?.agents, "required");
  await cms.requestReview(bot, "news", "n", { note: "Check the 12%" });
  assert.deepEqual((await api.reviewRequests()).map((r) => [r.slug, r.review?.note]), [["n", "Check the 12%"]]);
  assert.equal((await api.rejectReview("news", "n", "Source?")).review?.state, "changes_requested");
  await cms.requestReview(bot, "news", "n");
  assert.equal((await api.approveReview("news", "n")).publishedVersion, 1);
  assert.equal(await code(api.approveReview("news", "n")), "review_not_requested");

  const c = await api.addComment("news", "n", { anchor: "numbers", quote: "12%", body: "Is this year over year?" });
  await api.addComment("news", "n", { threadId: c.id, body: "Yes." });
  const threads = await api.comments("news", "n");
  assert.deepEqual(threads.map((t) => [t.located, t.line, t.replies.length]), [["quote", 3, 1]]);
  assert.ok((await api.resolveComment("news", "n", c.id)).resolvedAt);
  const link = await api.previewLink("news", "n", "1h", { comments: true });
  await api.addPreviewComment(link.token, { name: "Guest", body: "Looks right" });
  assert.equal((await api.previewComments(link.token)).length, 2);

  await api.create("guide", { slug: "g", title: "G", body: "g1" });
  const rel = await api.createRelease("Launch");
  const withItems = await api.addToRelease(rel.id, [{ collection: "guide", slug: "g" }]);
  assert.deepEqual(withItems.items.map((i) => [i.slug, i.version, i.stale, i.canPublish]), [["g", 1, false, true]]);
  assert.equal((await api.getWithRelease("guide", "g")).release?.name, "Launch");
  assert.equal((await api.renameRelease(rel.id, "Winter launch")).name, "Winter launch");
  assert.equal((await api.publishRelease(rel.id)).state, "published");
  assert.equal((await api.get("guide", "g")).status, "published");
  assert.equal(await code(api.removeRelease(rel.id)), "release_closed");
  assert.equal((await api.releases()).length, 1);

  const f = await api.saveFilter("guide", { name: "Published", query: { state: "published" }, shared: true });
  assert.deepEqual((await api.filters("guide")).map((x) => [x.name, x.mine, x.shared]), [["Published", true, true]]);
  await api.removeFilter("guide", f.id);
  const here = await api.presence("guide", "g", { cursor: { line: 0, ch: 2 } });
  assert.deepEqual([here.version, here.others.length], [1, 0]);
  assert.deepEqual((await api.presenceIn("guide")).map((p) => [p.slug, p.people[0].label]), [["g", "Kim"]]);
  await api.leave("guide", "g");
  assert.equal((await api.labelVersion("guide", "g", 1, { label: "First", pinned: true })).label, "First");
  const pre = await api.preview("guide", { body: "## New\n\nbody\n" }, "g");
  assert.deepEqual([pre.toc.map((t) => t.text), pre.blocks[0].line, pre.publicUrl, !!pre.diff], [["New"], 1, "/guide/g", true]);
});

test("tools: an agent requests a review, reads comments, uses the trash and a release", async () => {
  const { cms } = setup();
  const names = toolsFor(cms, bot).map((t) => t.name);
  for (const n of ["schedule_document", "request_review", "list_comments", "add_comment", "resolve_comment", "list_trash", "restore_from_trash", "list_releases", "create_release", "add_to_release", "publish_release", "label_version", "preview_document"]) assert.ok(names.includes(n), n);
  assert.ok(!toolsFor(cms, { ...bot, scopes: ["read"] } as Actor).some((t) => t.name === "request_review"));
  await callTool(cms, bot, "create_document", { collection: "news", doc: { slug: "t", title: "T", body: "## A\n\ntext\n" } });
  const refused = (await callTool(cms, bot, "publish_document", { collection: "news", slug: "t" })) as { error?: string };
  assert.equal(refused.error, "review_required");
  const asked = (await callTool(cms, bot, "request_review", { collection: "news", slug: "t", note: "First draft" })) as { review: { state: string } };
  assert.equal(asked.review.state, "requested");
  await cms.addComment(admin, "news", "t", { anchor: "a", body: "Shorter please" });
  const open = (await callTool(cms, bot, "list_comments", { collection: "news", slug: "t", open: true })) as { id: string; body: string }[];
  assert.deepEqual(open.map((c) => c.body), ["Shorter please"]);
  await callTool(cms, bot, "add_comment", { collection: "news", slug: "t", threadId: open[0].id, body: "Done." });
  assert.deepEqual(await callTool(cms, bot, "resolve_comment", { collection: "news", slug: "t", id: open[0].id }), { id: open[0].id, resolved: true });
  await callTool(cms, bot, "create_document", { collection: "guide", doc: { slug: "x", title: "X" } });
  await callTool(cms, bot, "delete_document", { collection: "guide", slug: "x" });
  const trash = (await callTool(cms, bot, "list_trash", {})) as { items: { kind: "document"; id: string; slug: string }[] };
  assert.deepEqual(trash.items.map((i) => i.slug), ["x"]);
  assert.deepEqual(await callTool(cms, bot, "restore_from_trash", { items: [{ kind: "document", id: trash.items[0].id }] }), { restored: 1 });
  const rel = (await callTool(cms, bot, "create_release", { name: "R1" })) as { id: string };
  await callTool(cms, bot, "add_to_release", { id: rel.id, items: [{ collection: "guide", slug: "x" }] });
  assert.deepEqual(await callTool(cms, bot, "publish_release", { id: rel.id }), { id: rel.id, name: "R1", state: "published", documents: 1 });
});
