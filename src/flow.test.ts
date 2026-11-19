/** 0.10.0: scheduled publishing, the trash, reviews, comments, releases, labels, saved filters, presence. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import { MemoryRepo } from "./repo";
import { MemoryStorage } from "./storage";
import { isCmsError, type Actor } from "./types";

const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => `/guide/${d.slug}`, versions: { max: 2 } });
const news = defineCollection({ slug: "news", label: "News", visibility: "public", review: { agents: "required" } });
const legal = defineCollection({ slug: "legal", label: "Legal", visibility: "public", review: { everyone: "required" }, access: { write: ({ actor }) => actor.kind === "user", publish: ({ actor }) => actor.kind === "user" } });

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const lee: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };
const bot: Actor = { kind: "key", id: "k1", label: "docs-bot", scopes: ["read", "write", "publish"], collections: null };

function setup(o: { trashDays?: number } = {}) {
  const repo = new MemoryRepo();
  const clock = { t: Date.parse("2026-11-20T00:00:00Z") };
  const store = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example" });
  const cms = createCms({
    repo,
    collections: [guide, news, legal],
    now: () => new Date(clock.t),
    previewSecret: "s".repeat(32),
    trash: o.trashDays === undefined ? undefined : { days: o.trashDays },
    media: { stores: { public: { visibility: "public", adapter: store } } },
  });
  const at = (minutes: number) => new Date(clock.t + minutes * 60_000).toISOString();
  return { repo, cms, clock, at, store };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (isCmsError(e)) return e.code;
    throw e;
  }
  return "ok";
};

test("schedule: the version that was current goes out at its time; later edits wait; unpublish follows", async () => {
  const { cms, clock, at, repo } = setup();
  await cms.create(admin, "guide", { slug: "launch", title: "Launch", body: "v1" });
  assert.equal(await code(cms.schedule(admin, "guide", "launch", { publishAt: at(-1) })), "schedule_invalid");
  assert.equal(await code(cms.schedule(admin, "guide", "launch", { publishAt: at(10), unpublishAt: at(5) })), "schedule_invalid");
  assert.equal(await code(cms.schedule(lee, "guide", "launch", { publishAt: at(10) })), "forbidden_publish");
  const d = await cms.schedule(admin, "guide", "launch", { publishAt: at(10), unpublishAt: at(60) });
  assert.deepEqual([d.schedule?.version, d.schedule?.by, d.dueAt], [1, "Kim", at(10)]);
  assert.equal((await cms.counts(admin, "guide")).scheduled, 1);
  assert.equal((await cms.page(admin, "guide", { drafts: true, state: "scheduled" })).docs[0].schedule?.publishAt, at(10));

  // An edit after scheduling makes v2; v1 is what was scheduled.
  await cms.update(admin, "guide", "launch", { body: "v2 not reviewed" });
  assert.deepEqual((await cms.runScheduled()).published, [], "not yet");
  clock.t += 11 * 60_000;
  const run = await cms.runScheduled();
  assert.deepEqual(run.published, ["guide/launch"]);
  const pub = await cms.get(anon, "guide", "launch");
  assert.equal(pub.body, "v1");
  const cur = await cms.get(admin, "guide", "launch", { draft: true });
  assert.deepEqual([cur.publishedVersion, cur.version, cur.schedule?.publishAt, cur.dueAt], [1, 2, null, cur.schedule?.unpublishAt]);
  assert.deepEqual((await cms.runScheduled()).published, [], "a second run does nothing");
  const entry = repo.audit.find((a) => a.action === "doc.publish");
  assert.deepEqual([entry?.actorKind, entry?.detail.scheduledBy], ["system", "Kim"]);

  clock.t += 60 * 60_000;
  assert.deepEqual((await cms.runScheduled()).unpublished, ["guide/launch"]);
  assert.equal(await code(cms.get(anon, "guide", "launch")), "not_found");
  assert.equal((await cms.get(admin, "guide", "launch", { draft: true })).schedule, null);

  // Publishing by hand uses up a waiting publish; unschedule clears it.
  await cms.schedule(admin, "guide", "launch", { publishAt: at(500) });
  await cms.publish(admin, "guide", "launch");
  assert.equal((await cms.get(admin, "guide", "launch", { draft: true })).schedule, null);
  assert.equal(await code(cms.unschedule(admin, "guide", "launch")), "not_scheduled");
  await cms.schedule(admin, "guide", "launch", { unpublishAt: at(900) });
  assert.equal((await cms.unschedule(admin, "guide", "launch")).dueAt, null);
});

test("schedule: a version that no longer passes its checks is not published and the failure is recorded", async () => {
  const { cms, clock, at, repo } = setup();
  const a = await cms.assets.put(admin, { name: "hero.png", mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), alt: "Hero" });
  await cms.create(admin, "guide", { slug: "pic", title: "Pic", body: `![Hero](asset:${a.id}/hero.png)` });
  await cms.schedule(admin, "guide", "pic", { publishAt: at(5) });
  await cms.update(admin, "guide", "pic", { body: "no picture any more" });
  await cms.assets.remove(admin, a.id, { confirm: true });
  await cms.trash.purge(admin, [{ kind: "asset", id: a.id }]);
  clock.t += 6 * 60_000;
  const run = await cms.runScheduled();
  assert.deepEqual([run.published, run.failed.map((f) => f.code)], [[], ["asset_missing"]]);
  assert.equal(await code(cms.get(anon, "guide", "pic")), "not_found");
  assert.equal((await cms.get(admin, "guide", "pic", { draft: true })).schedule, null);
  assert.ok(repo.audit.some((e) => e.action === "doc.schedule" && e.outcome === "failed"));
});

test("trash: a deleted document is gone everywhere, keeps its address, comes back as it was, and is purged after 30 days", async () => {
  const { cms, clock, repo } = setup();
  await cms.create(admin, "guide", { slug: "old", title: "Old page", body: "## Topic\n\nfindme words\n" }, { publish: true });
  await cms.create(admin, "guide", { slug: "draft", title: "Draft" });
  await cms.remove(admin, "guide", "old");
  await cms.remove(admin, "guide", "draft");
  assert.equal(await code(cms.get(anon, "guide", "old")), "not_found");
  assert.equal(await code(cms.get(admin, "guide", "old", { draft: true })), "not_found");
  assert.equal((await cms.list(admin, "guide", { drafts: true })).length, 0);
  assert.equal((await cms.search(anon, ["guide"], "findme")).empty, true);
  assert.equal(await code(cms.create(admin, "guide", { slug: "old", title: "New" })), "slug_in_trash");
  assert.equal((await cms.diagnose(admin, "guide", { slug: "old", title: "New" }))[0].code, "slug_in_trash");

  const t = await cms.trash.list(admin);
  assert.deepEqual(t.items.map((i) => [i.kind, i.slug, i.state, i.deletedBy]).sort(), [["document", "draft", "draft", "Kim"], ["document", "old", "published", "Kim"]]);
  assert.equal(t.items[0].purgeAt, new Date(clock.t + 30 * 86_400_000).toISOString());
  assert.equal(await code(cms.trash.list(anon)), "unauthorized");
  assert.equal((await cms.trash.list(lee)).items.length, 0, "not an editor of this collection");

  const old = t.items.find((i) => i.slug === "old")!;
  assert.equal(await code(cms.trash.restore(lee, [old])), "forbidden_publish");
  await cms.trash.restore(admin, [old]);
  assert.equal((await cms.get(anon, "guide", "old")).title, "Old page", "public again at once");
  assert.equal((await cms.search(anon, ["guide"], "findme")).empty, false);

  assert.equal(await code(cms.trash.purge(lee, "all")), "forbidden_trash");
  clock.t += 29 * 86_400_000;
  assert.equal((await cms.runScheduled()).purged.documents, 0);
  clock.t += 2 * 86_400_000;
  assert.equal((await cms.runScheduled()).purged.documents, 1);
  assert.equal(repo.docs.size, 1);
  await cms.create(admin, "guide", { slug: "draft", title: "The address is free again" });

  await cms.remove(admin, "guide", "draft");
  assert.deepEqual(await cms.trash.purge(admin, "all"), { purged: 1 });
  assert.deepEqual(repo.audit.filter((e) => e.action.startsWith("doc.")).map((e) => e.action), ["doc.publish", "doc.delete", "doc.delete", "doc.undelete", "doc.purge", "doc.delete", "doc.purge"]);
});

test("trash: files go to the trash too; `trash: { days: 0 }` deletes at once", async () => {
  const { cms, store } = setup();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const a = await cms.assets.put(admin, { name: "a.png", mime: "image/png", bytes: png });
  await cms.assets.remove(admin, a.id);
  assert.equal(await code(cms.assets.get(admin, a.id)), "asset_not_found");
  assert.equal((await cms.assets.list(admin)).assets.length, 0);
  assert.ok(store.objects.has("a.png"), "the object stays until the file is purged");
  assert.equal((await cms.assets.put(admin, { name: "a.png", mime: "image/png", bytes: png })).name, "a-2.png", "the name stays taken");
  const items = (await cms.trash.list(admin, { kind: "asset" })).items;
  assert.deepEqual(items.map((i) => [i.kind, i.title, i.state]), [["asset", "a.png", "image"]]);
  await cms.trash.restore(admin, items);
  assert.equal((await cms.assets.get(admin, a.id)).name, "a.png");
  await cms.assets.remove(admin, a.id);
  await cms.trash.purge(admin, [{ kind: "asset", id: a.id }]);
  assert.ok(!store.objects.has("a.png"));

  const now = setup({ trashDays: 0 });
  await now.cms.create(admin, "guide", { slug: "x", title: "X" });
  await now.cms.remove(admin, "guide", "x");
  assert.equal(now.repo.docs.size, 0);
  assert.equal((await now.cms.trash.list(admin)).items.length, 0);
});

test("review: agents cannot publish where a review is required; a person approves exactly the requested version", async () => {
  const { cms, repo } = setup();
  assert.equal(await code(cms.create(bot, "news", { slug: "n1", title: "N1" }, { publish: true })), "review_required");
  await cms.create(bot, "news", { slug: "n1", title: "N1", body: "draft by the bot" });
  assert.equal(await code(cms.publish(bot, "news", "n1")), "review_required");
  assert.equal(await code(cms.update(bot, "news", "n1", { body: "x" }, { publish: true })), "review_required");
  assert.equal(await code(cms.update({ ...admin, agent: { label: "assistant" } }, "news", "n1", { body: "y" }, { publish: true })), "review_required");
  assert.equal(await code(cms.schedule(bot, "news", "n1", { publishAt: "2030-01-01T00:00:00Z" })), "review_required");
  assert.equal(await code(cms.approveReview(admin, "news", "n1")), "review_not_requested");

  const asked = await cms.requestReview(bot, "news", "n1", { note: "Please check the numbers" });
  assert.deepEqual([asked.review?.state, asked.review?.version, asked.review?.by, asked.review?.note], ["requested", 1, "docs-bot", "Please check the numbers"]);
  assert.equal((await cms.counts(admin, "news")).review, 1);
  assert.deepEqual((await cms.reviewRequests(admin)).map((d) => d.slug), ["n1"]);
  // The request follows the document.
  const moved = await cms.update(bot, "news", "n1", { body: "second draft" });
  assert.equal(moved.review?.version, 2);
  assert.equal(await code(cms.approveReview(bot, "news", "n1")), "review_people_only");
  assert.equal(await code(cms.approveReview(lee, "news", "n1")), "forbidden_publish");

  const back = await cms.rejectReview(admin, "news", "n1", { note: "Numbers are off" });
  assert.deepEqual([back.review?.state, back.review?.note, back.review?.answeredBy], ["changes_requested", "Numbers are off", "Kim"]);
  assert.equal(await code(cms.approveReview(admin, "news", "n1")), "review_not_requested");

  await cms.update(bot, "news", "n1", { body: "third draft" });
  await cms.requestReview(bot, "news", "n1");
  const done = await cms.approveReview(admin, "news", "n1");
  assert.deepEqual([done.publishedVersion, done.review, done.published?.body], [3, null, "third draft"]);
  const v3 = await cms.version(admin, "news", "n1", 3);
  assert.equal(v3.approvedBy, "Kim");
  // A person publishes without a review here; an approved version can be published by the agent again.
  await cms.unpublish(admin, "news", "n1");
  assert.equal((await cms.publish(bot, "news", "n1", { version: 3 })).publishedVersion, 3);
  assert.deepEqual(repo.audit.filter((e) => e.action.startsWith("review.")).map((e) => e.action), ["review.request", "review.reject", "review.request", "review.approve"]);
});

test("review: with `everyone` nobody publishes their own request", async () => {
  const { cms } = setup();
  const kim2: Actor = { kind: "user", id: "u3", label: "Park", isAdmin: false };
  await cms.create(lee, "legal", { slug: "terms", title: "Terms", body: "v1" });
  assert.equal(await code(cms.publish(lee, "legal", "terms")), "review_required");
  await cms.requestReview(lee, "legal", "terms");
  assert.equal(await code(cms.approveReview(lee, "legal", "terms")), "review_self");
  const ok = await cms.approveReview(kim2, "legal", "terms", { publish: false });
  assert.deepEqual([ok.publishedVersion, ok.review], [null, null]);
  assert.equal((await cms.publish(lee, "legal", "terms")).publishedVersion, 1, "an approved version may go out");
});

test("comments: threads sit on a quote or a section, answers stay one level deep, a preview link can allow them", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "c", title: "C", body: "intro\n\n## Setup\n\nInstall the app first.\n\n## Use\n\nOpen it.\n" });
  const c1 = await cms.addComment(admin, "guide", "c", { anchor: "setup", quote: "Install the app", body: "Which app?" });
  const c2 = await cms.addComment(bot, "guide", "c", { anchor: "use", body: "Too short" });
  const r1 = await cms.addComment(bot, "guide", "c", { threadId: c1.id, body: "The desktop app. Fixed." });
  const r2 = await cms.addComment(admin, "guide", "c", { threadId: r1.id, body: "Thanks" });
  assert.equal(r2.threadId, c1.id, "an answer to an answer joins the thread");
  assert.equal(await code(cms.addComment(admin, "guide", "c", { body: " " })), "comment_invalid");
  assert.equal(await code(cms.addComment(lee, "guide", "c", { body: "hi" })), "forbidden_write");

  let list = await cms.comments(admin, "guide", "c");
  assert.deepEqual(list.map((t) => [t.body, t.located, t.line, t.replies.length, t.authorKind]), [["Which app?", "quote", 5, 2, "user"], ["Too short", "section", 7, 0, "key"]]);
  // The quote goes, the section stays; then the section goes too.
  await cms.update(admin, "guide", "c", { body: "intro\n\n## Setup\n\nGet the desktop app.\n" });
  list = await cms.comments(admin, "guide", "c");
  assert.deepEqual(list.map((t) => [t.located, t.line]), [["section", 3], ["lost", null]]);

  const done = await cms.resolveComment(bot, "guide", "c", r1.id);
  assert.deepEqual([done.id, done.resolvedBy], [c1.id, "docs-bot"]);
  assert.equal((await cms.resolveComment(admin, "guide", "c", c1.id, { resolved: false })).resolvedAt, null);
  assert.equal(await code(cms.resolveComment(admin, "guide", "c", "nope")), "comment_not_found");

  const plain = await cms.createPreviewLink(admin, "guide", "c");
  assert.equal(await code(cms.previewComments(plain.token)), "comments_off");
  const open = await cms.createPreviewLink(admin, "guide", "c", { comments: true });
  assert.equal((await cms.readPreview(open.token)).comments, true);
  const g = await cms.addPreviewComment(open.token, { name: "  Outside reviewer ", body: "Looks good", anchor: "setup" });
  assert.deepEqual([g.authorKind, g.authorLabel], ["guest", "Outside reviewer"]);
  assert.equal((await cms.previewComments(open.token)).length, 3);
  assert.equal(c2.authorLabel, "docs-bot");
});

test("release: pinned versions go out together or not at all; a release can be scheduled", async () => {
  const { cms, clock, at, repo } = setup();
  await cms.create(admin, "guide", { slug: "a", title: "A", body: "a1" });
  await cms.create(admin, "guide", { slug: "b", title: "B", body: "b1" }, { publish: true });
  await cms.create(bot, "news", { slug: "n", title: "N", body: "n1" });
  const rel = await cms.releases.create(admin, { name: "Winter launch" });
  assert.equal(await code(cms.releases.publish(admin, rel.id)), "release_empty");
  await cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "a" }, { collection: "guide", slug: "b", action: "unpublish" }]);
  const other = await cms.releases.create(admin, { name: "Other" });
  assert.equal(await code(cms.releases.add(admin, other.id, [{ collection: "guide", slug: "a" }])), "in_other_release");
  assert.deepEqual(await cms.releases.of((await cms.get(admin, "guide", "a", { draft: true })).id), { id: rel.id, name: "Winter launch", state: "open", publishAt: null });

  await cms.update(admin, "guide", "a", { body: "a2 written later" });
  let view = await cms.releases.get(admin, rel.id);
  assert.deepEqual(view.items.map((i) => [i.slug, i.action, i.version, i.currentVersion, i.stale]), [["a", "publish", 1, 2, true], ["b", "unpublish", 1, 1, false]]);

  // The bot may not publish in "news" without a review: everything stops.
  await cms.releases.add(admin, rel.id, [{ collection: "news", slug: "n" }]);
  let blocked: unknown = null;
  try {
    await cms.releases.publish(bot, rel.id);
  } catch (e) {
    blocked = isCmsError(e) ? [e.code, (e.current as { blocked: { slug: string; code: string }[] }).blocked.map((b) => [b.slug, b.code])] : e;
  }
  assert.deepEqual(blocked, ["release_blocked", [["n", "review_required"]]]);
  assert.equal(await code(cms.get(anon, "guide", "a")), "not_found", "nothing went out");
  assert.equal((await cms.get(anon, "guide", "b")).body, "b1");
  assert.equal(await code(cms.releases.publish(lee, rel.id)), "release_blocked");

  view = await cms.releases.removeItem(admin, rel.id, view.items[0].documentId);
  view = await cms.releases.add(admin, rel.id, [{ collection: "guide", slug: "a" }]);
  assert.equal(view.items.find((i) => i.slug === "a")?.version, 2, "added again at the latest version");
  assert.equal(await code(cms.releases.schedule(admin, rel.id, { publishAt: at(-5) })), "schedule_invalid");
  assert.equal((await cms.releases.schedule(admin, rel.id, { publishAt: at(30) })).state, "scheduled");
  clock.t += 31 * 60_000;
  const run = await cms.runScheduled();
  assert.deepEqual(run.releases.map((r) => [r.name, r.ok]), [["Winter launch", true]]);
  assert.equal((await cms.get(anon, "guide", "a")).body, "a2 written later");
  assert.equal(await code(cms.get(anon, "guide", "b")), "not_found");
  assert.equal((await cms.get(anon, "news", "n")).body, "n1");
  const done = await cms.releases.get(admin, rel.id);
  assert.deepEqual([done.state, done.publishedBy, done.canPublish], ["published", "scheduler", false]);
  assert.equal((await cms.version(admin, "guide", "a", 2)).label, "Winter launch");
  assert.equal(await code(cms.releases.remove(admin, rel.id)), "release_closed");
  assert.equal(await code(cms.releases.list({ ...bot, scopes: ["read"] })), "forbidden", "not an editor of anything");
  assert.ok(repo.audit.some((e) => e.action === "release.publish" && e.detail.documents === 3));
  await cms.releases.remove(admin, other.id);
  assert.equal((await cms.releases.list(admin)).length, 1);
});

test("versions: a label and a pin; pinned versions survive pruning", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "v", title: "V", body: "1" });
  const v1 = await cms.labelVersion(admin, "guide", "v", 1, { label: " First cut ", pinned: true });
  assert.deepEqual([v1.label, v1.pinned], ["First cut", true]);
  for (const body of ["2", "3", "4"]) await cms.update(admin, "guide", "v", { body });
  assert.deepEqual((await cms.versionList(admin, "guide", "v")).map((v) => v.version), [4, 3, 1], "max is 2, v1 is pinned");
  assert.equal((await cms.labelVersion(admin, "guide", "v", 1, { label: "" })).label, null);
  assert.equal(await code(cms.labelVersion(admin, "guide", "v", 9, { pinned: true })), "version_not_found");
});

test("saved filters, presence and the unsaved preview", async () => {
  const { cms, clock } = setup();
  await cms.create(admin, "guide", { slug: "p", title: "P", body: "## One\n\ntext\n\n## Two\n\nmore\n" });
  const mine = await cms.filters.save(admin, "guide", { name: "Drafts by agents", query: { state: "draft", by: "key", evil: "x" }, shared: true });
  assert.deepEqual(mine.query, { state: "draft", by: "key" });
  assert.equal(await code(cms.filters.save(bot, "guide", { name: "x", query: {} })), "forbidden");
  assert.equal(await code(cms.filters.save(admin, "guide", { name: "", query: {} })), "name_invalid");
  assert.deepEqual((await cms.filters.list(bot, "guide")).map((f) => [f.name, f.mine]), [["Drafts by agents", false]]);
  await cms.filters.remove(admin, mine.id);
  assert.equal((await cms.filters.list(admin, "guide")).length, 0);

  const first = await cms.presence.touch(admin, "guide", "p", { cursor: { line: 2, ch: 1 } });
  assert.deepEqual([first.version, first.others], [1, []]);
  await cms.update(bot, "guide", "p", { summary: "an agent's save leaves a sign of life" });
  await new Promise((r) => setTimeout(r, 5));
  const second = await cms.presence.touch(admin, "guide", "p", {});
  assert.deepEqual([second.version, second.others.map((o) => [o.label, o.kind])], [2, [["docs-bot", "key"]]]);
  assert.deepEqual((await cms.presence.in(admin, "guide")).map((x) => [x.slug, x.people.length]), [["p", 2]]);
  clock.t += 46_000;
  assert.deepEqual((await cms.presence.in(admin, "guide")).length, 0, "gone after 45 seconds of silence");
  await cms.presence.leave(admin, "guide", "p");

  const pre = await cms.preview(admin, "guide", { body: "## One\n\nchanged\n" }, { slug: "p" });
  assert.deepEqual(pre.toc.map((t) => t.text), ["One"]);
  assert.deepEqual(pre.blocks.map((b) => [b.t, b.line, b.endLine]), [["heading", 1, 1], ["p", 3, 3]]);
  assert.ok(pre.diff?.includes("+changed"));
  assert.equal(pre.publicUrl, "/guide/p");
  assert.equal((await cms.get(admin, "guide", "p", { draft: true })).body.includes("changed"), false, "nothing was saved");
});
