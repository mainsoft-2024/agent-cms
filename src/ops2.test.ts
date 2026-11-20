/** 0.13.0: roles, automations, the dashboard's numbers, export and import. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { docFromMarkdown, docToMarkdown } from "./frontmatter";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const lee: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const park: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u3", label: "Park", isAdmin: false };
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? e.code : String(e)));

function setup() {
  const clock = { t: Date.parse("2026-11-23T03:00:00Z") }; // a Monday
  const called: string[] = [];
  const blog = defineCollection({ slug: "blog", label: "Blog", visibility: "public", categories: ["News", "Notes"], fields: z.object({ tags: z.array(z.string()).default([]), reviewed: z.boolean().default(false) }) });
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", access: { write: ({ actor }) => actor.kind === "user" && actor.id === "u3" } });
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [blog, guide],
    now: () => new Date(clock.t),
    cronSecret: "cron-secret-cron-secret",
    automations: { actions: { notify: (c) => void called.push(`${c.automation.name}:${c.doc?.slug ?? "-"}`) } },
    users: { search: (q) => [lee, park].filter((u) => u.label.toLowerCase().includes(q.toLowerCase())).map((u) => ({ id: u.id, label: u.label })), get: (id) => ({ id, label: id === "u2" ? "Lee" : "Someone" }) },
  });
  return { cms, clock, called };
}

test("roles: a writer may write but not publish or delete; no roles means the old rules", async () => {
  const { cms } = setup();
  assert.equal(await code(cms.create(lee, "blog", { slug: "a", title: "A", category: "News" })), "forbidden_write", "nobody is in a role: admins only");
  const writer = await cms.roles.create(admin, { name: "Writer", permissions: { blog: { write: true } } });
  await cms.roles.addMember(admin, writer.id, { id: "u2" });
  assert.equal((await cms.roles.list(admin)).roles[0].members[0].label, "Lee", "the label comes from the app's users");
  await cms.create(lee, "blog", { slug: "a", title: "A", category: "News" });
  assert.equal(await code(cms.publish(lee, "blog", "a")), "forbidden_publish");
  assert.equal(await code(cms.remove(lee, "blog", "a")), "forbidden_publish");
  await cms.roles.update(admin, writer.id, { permissions: { blog: { write: true, publish: true } } });
  await cms.publish(lee, "blog", "a");
  assert.equal(await code(cms.remove(lee, "blog", "a")), "forbidden_publish", "deleting is its own permission for people");
  await cms.roles.update(admin, writer.id, { permissions: { blog: { write: true, publish: true, delete: true } } });
  await cms.remove(lee, "blog", "a");
  // A collection that decides in code is not touched by roles.
  await cms.roles.update(admin, writer.id, { permissions: { blog: { write: true }, guide: { write: true } } });
  assert.equal(await code(cms.create(lee, "guide", { slug: "g", title: "G" })), "forbidden_write");
  assert.deepEqual((await cms.roles.list(admin)).targets.find((t) => t.slug === "guide")?.coded, ["write"]);
  assert.equal(await code(cms.roles.list(lee)), "forbidden_roles");
  assert.equal(await code(cms.roles.create(admin, { name: "X", permissions: { nope: { write: true } } })), "unknown_collection");
  await cms.roles.removeMember(admin, writer.id, "u2");
  assert.equal(await code(cms.create(lee, "blog", { slug: "b", title: "B", category: "News" })), "forbidden_write");
});

test("roles: an admin role makes an admin, and its last member cannot remove themself", async () => {
  const { cms } = setup();
  const owners = await cms.roles.create(admin, { name: "Owners", admin: true });
  await cms.roles.addMember(admin, owners.id, { id: "u2", label: "Lee" });
  assert.equal(cms.isAdmin(lee), true);
  assert.equal((await cms.listKeys(lee)).length, 0, "role admins manage keys too");
  assert.equal(await code(cms.roles.removeMember(lee, owners.id, "u2")), "role_last_admin");
  assert.equal(await code(cms.roles.update(lee, owners.id, { admin: false })), "role_last_admin");
  assert.equal(await code(cms.roles.remove(lee, owners.id)), "role_last_admin");
  await cms.roles.remove(admin, owners.id);
  assert.equal(cms.isAdmin(lee), false);
});

test("automations: an event that matches runs on the next cron call; other documents are skipped", async () => {
  const { cms, called } = setup();
  const auto = await cms.automations.create(admin, {
    name: "News",
    trigger: { event: "doc.published", collection: "blog" },
    conditions: [{ field: "category", op: "is", value: "News" }],
    actions: [{ type: "add_keyword", name: "news" }, { type: "set_field", name: "fields.reviewed", value: "true" }, { type: "call", target: "notify" }],
  });
  await cms.create(admin, "blog", { slug: "hello", title: "Hello", category: "News" }, { publish: true });
  await cms.create(admin, "blog", { slug: "idea", title: "Idea", category: "Notes" }, { publish: true });
  await new Promise((r) => setTimeout(r, 5));
  await cms.cron();
  const runs = await cms.automations.runs(admin, auto.id);
  assert.deepEqual(runs.map((r) => [r.slug, r.state]).sort(), [["hello", "ok"], ["idea", "skipped"]]);
  const doc = await cms.get(admin, "blog", "hello", { draft: true });
  assert.deepEqual([doc.keywords, doc.fields.reviewed, doc.updatedBy], [["news"], true, "automation: News"]);
  assert.deepEqual(called, ["News:hello"]);
  // What the automation saved raised doc.updated; an automation listening for that must not start.
  const loop = await cms.automations.create(admin, { name: "Loop", trigger: { event: "doc.updated", collection: null }, actions: [{ type: "add_keyword", name: "x" }] });
  await cms.update(admin, "blog", "idea", { title: "Idea 2" });
  await new Promise((r) => setTimeout(r, 5));
  await cms.cron();
  await cms.cron();
  assert.equal((await cms.automations.runs(admin, loop.id)).length, 1, "it ran for the person's edit only");
  const t = await cms.automations.test(admin, auto.id, { collection: "blog", slug: "idea" });
  assert.deepEqual([t.matches, t.actions.length], [false, 3]);
  assert.equal(await code(cms.automations.create(admin, { name: "Bad", actions: [{ type: "call", target: "nope" }] })), "automation_invalid");
  assert.equal(await code(cms.automations.list(lee)), "forbidden_automations");
  await cms.automations.update(admin, auto.id, { enabled: false });
  await cms.create(admin, "blog", { slug: "third", title: "Third", category: "News" }, { publish: true });
  await new Promise((r) => setTimeout(r, 5));
  await cms.cron();
  assert.equal((await cms.automations.runs(admin, auto.id)).length, 2, "switched off: nothing new");
});

test("automations: a failing step stops the rest and is recorded; schedules fire once a day", async () => {
  const { cms, clock, called } = setup();
  const a = await cms.automations.create(admin, { name: "Fail", trigger: { event: "doc.created", collection: "blog" }, actions: [{ type: "add_to_release", target: "missing" }, { type: "call", target: "notify" }] });
  await cms.create(admin, "blog", { slug: "x", title: "X", category: "News" });
  await new Promise((r) => setTimeout(r, 5));
  await cms.cron();
  const [run] = await cms.automations.runs(admin, a.id);
  assert.deepEqual([run.state, run.steps.length, called.length], ["failed", 1, 0]);
  const daily = await cms.automations.create(admin, { name: "Daily", trigger: { event: "schedule.daily", collection: null }, actions: [{ type: "call", target: "notify" }] });
  await cms.cron();
  await cms.cron();
  assert.equal((await cms.automations.runs(admin, daily.id)).length, 1);
  clock.t += 86_400_000;
  await cms.cron();
  assert.equal((await cms.automations.runs(admin, daily.id)).length, 2);
  await cms.automations.remove(admin, daily.id);
  assert.equal(await code(cms.automations.runs(admin, daily.id)), "automation_not_found");
});

test("stats: totals match the list counts, changes split people and agents, and only readable collections count", async () => {
  const { cms } = setup();
  const key = await cms.createKey(admin, { name: "bot", scopes: ["write"] });
  const bot = (await cms.authenticateKey(key.secret))!;
  await cms.create(admin, "blog", { slug: "a", title: "A", category: "News" }, { publish: true });
  await cms.create(bot, "blog", { slug: "b", title: "B", category: "News" });
  await cms.update(bot, "blog", "b", { title: "B2" });
  await cms.recordHits([(await cms.get(admin, "blog", "a")).id]);
  const s = await cms.stats(admin, { days: 7 });
  const n = await cms.counts(admin, "blog");
  assert.deepEqual([s.totals.documents, s.totals.published], [n.all, n.published]);
  const today = s.changes[s.changes.length - 1];
  assert.deepEqual([s.changes.length, today.people, today.agents], [7, 1, 2]);
  assert.deepEqual(s.top.map((t) => [t.slug, t.hits]), [["a", 1]]);
  assert.equal(s.recent.some((r) => r.who === "bot" && r.agent), true);
  const mine = await cms.stats(lee);
  assert.deepEqual([mine.totals.documents, mine.changes.every((c) => c.people + c.agents === 0)], [1, true], "a reader sees published documents and no edit history");
  const handler = createCmsHandler({ cms, resolveUser: async () => null });
  assert.equal((await handler(new Request("http://x/api/cms/_stats"))).status, 401);
});

test("export and import: files round-trip; dry run changes nothing; conflicts follow the policy", async () => {
  const { cms } = setup();
  const tricky = { slug: "a", title: 'Say "hi": #1', summary: "two\nlines", category: "News", keywords: ["x, y", "z"], body: "# A\n\ntext", fields: { tags: ["one", "two"], reviewed: true } };
  assert.deepEqual(docFromMarkdown(docToMarkdown(tricky)), tricky);
  await cms.create(admin, "blog", tricky, { publish: true });
  await cms.create(admin, "blog", { slug: "draft", title: "Draft", category: "Notes" });
  const pub = await cms.transfer.export(admin, { collections: ["blog"] });
  assert.deepEqual(pub.files.map((f) => f.path), ["blog/a.md", "_meta.json"]);
  const all = await cms.transfer.export(admin, { drafts: true });
  assert.equal(all.documents, 2);
  assert.equal(await code(cms.transfer.export({ kind: "anonymous" })), "unauthorized");

  const other = setup().cms;
  const dry = await other.transfer.import(admin, all.files, { dryRun: true });
  assert.deepEqual([dry.applied, dry.items.map((i) => i.change), (await other.counts(admin, "blog")).all], [false, ["new", "new"], 0]);
  const done = await other.transfer.import(admin, all.files, { publish: true });
  assert.deepEqual(done.items.map((i) => [i.slug, i.toVersion, i.published ?? false]), [["a", 1, true], ["draft", 1, false]]);
  const back = await other.get(admin, "blog", "a");
  assert.deepEqual([back.title, back.summary, back.keywords, back.fields, back.status], [tricky.title, tricky.summary, tricky.keywords, tricky.fields, "published"]);
  assert.deepEqual((await other.transfer.import(admin, all.files)).items.map((i) => i.change), ["same", "same"]);

  const edited = all.files.map((f) => (f.path === "blog/a.md" ? { ...f, text: f.text.replace("text", "new text") } : f));
  const skip = await other.transfer.import(admin, edited, { onConflict: "db-wins" });
  assert.deepEqual(skip.items.map((i) => i.change), ["skip", "same"]);
  const up = await other.transfer.import(admin, edited, { diff: true });
  assert.deepEqual([up.items[0].change, up.items[0].fromVersion, up.items[0].toVersion, /\+new text/.test(up.items[0].diff ?? "")], ["update", 1, 2, true]);
  assert.equal((await other.get(admin, "blog", "a")).body, "# A\n\ntext", "an import makes a draft: the public copy stays");
  const bad = await other.transfer.import(admin, [{ path: "blog/bad.md", text: "---\ntitle: Bad\ncategory: Nope\n---\nx" }, { path: "nope/x.md", text: "x" }]);
  assert.deepEqual(bad.items.map((i) => i.change), ["error", "error"]);
  assert.equal((await other.transfer.import(lee, all.files)).items.every((i) => i.change === "error"), true, "no write permission");
});
