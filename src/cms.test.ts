import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { MemoryRepo } from "./repo";
import { CmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "관리자", isAdmin: true };
const user: Actor = { kind: "user", id: "u2", label: "사용자", isAdmin: false };
const anon: Actor = { kind: "anonymous" };

function setup() {
  const repo = new MemoryRepo();
  const guide = defineCollection({
    slug: "guide",
    label: "가이드",
    categories: ["연동", "만들기"],
    forbiddenChars: ["·"],
    search: { gapLogging: true },
    links: { resolve: (k) => (k === "settings.integrations" ? "/settings/integrations" : null) },
    url: (d) => `/guide/${d.slug}`,
  });
  const updates = defineCollection({
    slug: "updates",
    label: "공지사항",
    versions: { drafts: false },
    fields: z.object({ pinned: z.boolean().default(false) }),
  });
  const cms = createCms({ repo, collections: [guide, updates], searchRefreshMs: 0 });
  return { repo, cms };
}

const slack = {
  slug: "slack-connect",
  title: "Slack 연결하기",
  summary: "Slack을 연결하는 방법",
  category: "연동",
  keywords: ["슬랙", "slack"],
  body: "## 연결하기\n\n1. [[link:settings.integrations|연동 서비스]]를 열어요.\n2. **연결**을 눌러요.\n\n## 연결 끊기\n\n관리에서 연결 해제를 눌러요.",
};

async function reject(p: Promise<unknown>, code: CmsError["code"]) {
  await assert.rejects(p, (e: unknown) => e instanceof CmsError && e.code === code);
}

test("draft is invisible to the public until published", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack);
  await reject(cms.get(anon, "guide", "slack-connect"), "not_found");
  assert.equal((await cms.list(anon, "guide")).length, 0);
  await cms.publish(admin, "guide", "slack-connect");
  const pub = await cms.get(anon, "guide", "slack-connect");
  assert.equal(pub.title, "Slack 연결하기");
});

test("editing a published doc keeps the public copy until republished", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack, { publish: true });
  const d = await cms.update(admin, "guide", "slack-connect", { title: "Slack 연결" });
  assert.equal(d.status, "draft");
  assert.equal(d.version, 2);
  assert.equal((await cms.get(anon, "guide", "slack-connect")).title, "Slack 연결하기");
  assert.equal((await cms.get(admin, "guide", "slack-connect", { draft: true })).title, "Slack 연결");
  await cms.publish(admin, "guide", "slack-connect");
  assert.equal((await cms.get(anon, "guide", "slack-connect")).title, "Slack 연결");
});

test("in-place collections republish on save", async () => {
  const { cms } = setup();
  await cms.create(admin, "updates", { slug: "v1", title: "첫 소식", body: "내용" }, { publish: true });
  const d = await cms.update(admin, "updates", "v1", { title: "고친 소식" });
  assert.equal(d.status, "published");
  assert.equal((await cms.get(anon, "updates", "v1")).title, "고친 소식");
  assert.deepEqual(d.fields, { pinned: false });
});

test("stale expectedVersion is a conflict, not a silent overwrite", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack);
  await cms.update(admin, "guide", "slack-connect", { summary: "A" }, { expectedVersion: 1 });
  await reject(cms.update(admin, "guide", "slack-connect", { summary: "B" }, { expectedVersion: 1 }), "conflict");
  assert.equal((await cms.get(admin, "guide", "slack-connect", { draft: true })).summary, "A");
});

test("restore makes a new version from an old one", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack);
  await cms.update(admin, "guide", "slack-connect", { title: "바뀐 제목" });
  const r = await cms.restore(admin, "guide", "slack-connect", 1);
  assert.equal(r.version, 3);
  assert.equal(r.title, "Slack 연결하기");
  const vs = await cms.versions(admin, "guide", "slack-connect");
  assert.deepEqual(vs.map((v) => v.version), [3, 2, 1]);
  assert.equal(vs[0].note, "v1로 되돌림");
});

test("validation: slug, category, forbidden chars, unknown screen link", async () => {
  const { cms } = setup();
  await reject(cms.create(admin, "guide", { ...slack, slug: "Bad Slug" }), "invalid");
  await reject(cms.create(admin, "guide", { ...slack, category: "기타" }), "invalid");
  await reject(cms.create(admin, "guide", { ...slack, title: "A·B" }), "invalid");
  await reject(cms.create(admin, "guide", { ...slack, body: "[[link:nope|없는 화면]]" }), "invalid");
});

test("access: users read published only; keys need scopes and collections", async () => {
  const { cms } = setup();
  await reject(cms.create(user, "guide", slack), "forbidden");
  await reject(cms.create(anon, "guide", slack), "unauthorized");
  const { secret } = await cms.createKey(admin, { name: "CI", scopes: ["read"] });
  const reader = (await cms.authenticateKey(secret))!;
  await reject(cms.create(reader, "guide", slack), "forbidden");
  const { secret: w } = await cms.createKey(admin, { name: "agent", scopes: ["write"], collections: ["guide"] });
  const writer = (await cms.authenticateKey(w))!;
  await cms.create(writer, "guide", slack);
  await reject(cms.publish(writer, "guide", "slack-connect"), "forbidden");
  await reject(cms.create(writer, "updates", { slug: "x", title: "x" }), "forbidden");
});

test("revoked keys stop working; secrets are never stored", async () => {
  const { cms, repo } = setup();
  const { key, secret } = await cms.createKey(admin, { name: "k", scopes: ["admin"] });
  assert.ok(!JSON.stringify(repo.keys).includes(secret));
  assert.ok(await cms.authenticateKey(secret));
  await cms.revokeKey(admin, key.id);
  assert.equal(await cms.authenticateKey(secret), null);
  await reject(cms.createKey(user, { name: "x", scopes: ["read"] }), "forbidden");
});

test("search finds Korean questions by alias and stem; empty results log a gap", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack, { publish: true });
  const r = await cms.search(anon, ["guide"], "슬랙 어떻게 연결해?");
  assert.equal(r.empty, false);
  assert.equal(r.hits[0].unit.slug, "slack-connect");
  assert.equal(r.hits[0].unit.heading, "연결하기");
  // Anonymous misses are never written (a public search box cannot fill the table).
  assert.equal((await cms.search(anon, ["guide"], "환불 받는 법", { logGap: true })).empty, true);
  await new Promise((res) => setImmediate(res));
  assert.equal((await cms.gaps(admin, "guide")).length, 0);
  await reject(cms.reportGap(anon, "guide", { question: "x" }), "unauthorized");

  const agent: Actor = { kind: "system", label: "agent" };
  await cms.search(agent, ["guide"], "환불 받는 법", { logGap: true });
  await new Promise((res) => setImmediate(res));
  const gaps = await cms.gaps(admin, "guide");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, "no_result");
  await cms.search(agent, ["guide"], "환불 받는 법은?", { logGap: true });
  await new Promise((res) => setImmediate(res));
  assert.equal((await cms.gaps(admin, "guide"))[0].count, 2);
});

test("a key cannot mint a key wider than itself", async () => {
  const { cms } = setup();
  const { secret } = await cms.createKey(admin, { name: "limited", scopes: ["admin", "read"], collections: ["guide"] });
  const k = (await cms.authenticateKey(secret))!;
  await reject(cms.createKey(k, { name: "x", scopes: ["admin"] }), "forbidden");
  await reject(cms.createKey(k, { name: "x", scopes: ["write"], collections: ["guide"] }), "forbidden");
  await cms.createKey(k, { name: "ok", scopes: ["read"], collections: ["guide"] });
});

test("unchanged jsonb key order is not a new version", async () => {
  const { cms } = setup();
  await cms.create(admin, "updates", { slug: "n", title: "t", fields: { pinned: true } }, { publish: true });
  const d = await cms.update(admin, "updates", "n", { fields: { pinned: true } });
  assert.equal(d.version, 1);
});

test("search index follows publish and archive", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack);
  assert.equal((await cms.search(anon, ["guide"], "슬랙", { logGap: false })).empty, true);
  await cms.publish(admin, "guide", "slack-connect");
  assert.equal((await cms.search(anon, ["guide"], "슬랙")).empty, false);
  await cms.archive(admin, "guide", "slack-connect");
  assert.equal((await cms.search(anon, ["guide"], "슬랙", { logGap: false })).empty, true);
});

test("old versions are pruned but the published one is kept", async () => {
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [defineCollection({ slug: "g", label: "g", versions: { max: 2 } })] });
  await cms.create(admin, "g", { slug: "a", title: "v1" }, { publish: true });
  for (let i = 2; i <= 5; i++) await cms.update(admin, "g", "a", { title: `v${i}` });
  const vs = await cms.versions(admin, "g", "a");
  assert.deepEqual(vs.map((v) => v.version), [5, 4, 1]);
  assert.equal(vs.find((v) => v.version === 1)!.published, true);
});

test("publish and restore honour expectedVersion", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", slack);
  await cms.update(admin, "guide", "slack-connect", { summary: "B" });
  await reject(cms.publish(admin, "guide", "slack-connect", { expectedVersion: 1 }), "conflict");
  await reject(cms.restore(admin, "guide", "slack-connect", 1, { expectedVersion: 1 }), "conflict");
  assert.equal((await cms.publish(admin, "guide", "slack-connect", { expectedVersion: 2 })).status, "published");
});

test("unpublish takes a doc off the public site and keeps its first publish time", async () => {
  const { cms } = setup();
  const first = await cms.create(admin, "guide", slack, { publish: true });
  await cms.archive(admin, "guide", "slack-connect");
  const d = await cms.unpublish(admin, "guide", "slack-connect");
  assert.equal(d.status, "draft");
  assert.equal(d.publishedVersion, null);
  await reject(cms.get(anon, "guide", "slack-connect"), "not_found");
  assert.equal((await cms.search(anon, ["guide"], "슬랙", { logGap: false })).empty, true);
  const again = await cms.publish(admin, "guide", "slack-connect");
  assert.equal(again.publishedAt, first.publishedAt);
  await reject(cms.unpublish(user, "guide", "slack-connect"), "forbidden");
});

test("managed collection: only the host app (system) writes; keys and users read", async () => {
  const notes = defineCollection({ slug: "notes", label: "Notes", managed: true, versions: { drafts: false } });
  const cms = createCms({ repo: new MemoryRepo(), collections: [notes] });
  const sys: Actor = { kind: "system", label: "app" };
  const key: Actor = { kind: "key", id: "k", label: "k", scopes: ["admin"], collections: null };
  await cms.create(sys, "notes", { slug: "a", title: "A", body: "x" }, { publish: true });
  await reject(cms.update(admin, "notes", "a", { title: "B" }), "forbidden");
  await reject(cms.update(key, "notes", "a", { title: "B" }), "forbidden");
  await reject(cms.remove(key, "notes", "a"), "forbidden");
  await reject(cms.create(admin, "notes", { slug: "b", title: "B" }), "forbidden");
  assert.equal((await cms.get(key, "notes", "a")).title, "A");
  assert.equal((await cms.update(sys, "notes", "a", { title: "B" })).title, "B");
});
