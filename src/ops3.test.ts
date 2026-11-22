/** 0.14.0: request limits, allowed addresses, key rotation, retention, the remaining hooks, the events stream. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { badRanges, createLimiter, ipAllowed, MemoryRateLimitStore } from "./limits";
import { MemoryRepo } from "./repo";
import type { Actor, CmsDoc } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const reader: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const anon: Actor = { kind: "anonymous" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? e.code : Promise.reject(e)));

function setup(o: Partial<Parameters<typeof createCms>[0]> & { hooks?: NonNullable<Parameters<typeof defineCollection>[0]["hooks"]> } = {}) {
  const clock = { t: Date.parse("2026-11-21T00:00:10Z") };
  const { hooks, ...rest } = o;
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public", hooks });
  const notes = defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });
  const repo = new MemoryRepo();
  const errors: string[] = [];
  const cms = createCms({ repo, collections: [guide, notes], now: () => new Date(clock.t), cronSecret: "c".repeat(32), onError: (e, where) => void errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`), warn: () => {}, ...rest });
  const session = { user: null as Extract<Actor, { kind: "user" }> | null };
  const handler = createCmsHandler({ cms, resolveUser: async () => session.user });
  const call = (path: string, init: RequestInit & { key?: string; ip?: string } = {}) =>
    handler(new Request(`http://app.test/api/cms${path}`, { ...init, headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.ip ? { "x-forwarded-for": `${init.ip}, 10.0.0.1` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) } }));
  const minutes = (n: number) => (clock.t += n * 60_000);
  return { cms, repo, clock, session, handler, call, minutes, errors };
}

test("limits: a window counts per bucket and starts over each minute; old windows are dropped", async () => {
  let t = 60_000 * 1000 + 59_000;
  const store = new MemoryRateLimitStore(() => t);
  const limiter = createLimiter({ store, now: () => t });
  assert.deepEqual(await limiter.check("a", 2), { ok: true, limit: 2, remaining: 1, retryAfter: 1 });
  assert.equal((await limiter.check("a", 2)).ok, true);
  assert.deepEqual(await limiter.check("a", 2), { ok: false, limit: 2, remaining: 0, retryAfter: 1 });
  assert.equal((await limiter.check("b", 2)).ok, true, "another caller has its own count");
  assert.equal((await limiter.check("a", null)).ok, true, "no number, no limit");
  t += 1000;
  assert.deepEqual(await limiter.check("a", 2), { ok: true, limit: 2, remaining: 1, retryAfter: 60 });
  t += 61_000;
  await limiter.check("c", 5);
  assert.equal(store.size, 1, "the windows that ended are gone");
});

test("limits: addresses and ranges, IPv4 and IPv6", () => {
  assert.deepEqual(badRanges(["203.0.113.7", "10.0.0.0/8", "2001:db8::/32", "::1", "300.1.1.1", "10.0.0.0/33", "example.com", "2001:db8::/129", "1:2:3"]), ["300.1.1.1", "10.0.0.0/33", "example.com", "2001:db8::/129", "1:2:3"]);
  assert.equal(ipAllowed("203.0.113.7", []), true, "an empty list allows everything");
  assert.equal(ipAllowed(null, ["10.0.0.0/8"]), false, "an unknown address is not in any range");
  assert.deepEqual(["10.1.2.3", "11.0.0.1", "10.255.255.255"].map((ip) => ipAllowed(ip, ["10.0.0.0/8"])), [true, false, true]);
  assert.deepEqual(["203.0.113.7", "203.0.113.8"].map((ip) => ipAllowed(ip, ["203.0.113.7"])), [true, false]);
  assert.deepEqual(["192.168.1.129", "192.168.1.126"].map((ip) => ipAllowed(ip, ["192.168.1.128/25"])), [true, false]);
  assert.deepEqual(["2001:db8:1::5", "2001:db9::1", "::1"].map((ip) => ipAllowed(ip, ["2001:db8::/32", "::1"])), [true, false, true]);
  assert.equal(ipAllowed("::ffff:203.0.113.7", ["203.0.113.0/24"]), true, "an IPv4 address written the IPv6 way");
  assert.equal(ipAllowed("not an ip", ["0.0.0.0/0"]), false);
  assert.equal(ipAllowed("8.8.8.8", ["0.0.0.0/0"]), true);
});

test("request limits: a key's own number wins over the default, 429 says when to come back, strangers are counted by address", async () => {
  const s = setup({ rateLimit: { perMinute: 3, anonymousPerMinute: 2 } });
  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  const normal = await s.cms.createKey(admin, { name: "default", scopes: ["read"] });
  const tight = await s.cms.createKey(admin, { name: "tight", scopes: ["read"], rateLimit: 1 });
  assert.deepEqual([normal.key.rateLimit, tight.key.rateLimit], [null, 1]);

  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await s.call("/collections/guide/a", { key: normal.secret })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal((await s.call("/collections/guide/a", { key: tight.secret })).status, 200);
  const refused = await s.call("/collections/guide/a", { key: tight.secret });
  assert.deepEqual([refused.status, refused.headers.get("retry-after")], [429, "50"]);
  const body = (await refused.json()) as { error: string; message: string; params: { retryAfter: number; limit: number } };
  assert.deepEqual([body.error, body.params, body.message], ["rate_limited", { retryAfter: 50, limit: 1 }, "Too many requests. Try again in 50 seconds"]);

  // Strangers: two per minute per address; another address has its own count.
  assert.deepEqual([(await s.call("/collections/guide/a", { ip: "198.51.100.1" })).status, (await s.call("/collections/guide/a", { ip: "198.51.100.1" })).status, (await s.call("/collections/guide/a", { ip: "198.51.100.1" })).status], [200, 200, 429]);
  assert.equal((await s.call("/collections/guide/a", { ip: "198.51.100.2" })).status, 200);
  // A signed-in person is not counted.
  s.session.user = admin;
  for (let i = 0; i < 5; i++) assert.equal((await s.call("/collections/guide/a", { ip: "198.51.100.1" })).status, 200);
  s.session.user = null;

  s.minutes(1);
  assert.equal((await s.call("/collections/guide/a", { key: tight.secret })).status, 200, "a new minute, a new count");
  assert.equal(await code(s.cms.createKey(admin, { name: "bad", scopes: ["read"], rateLimit: 0 })), "invalid_rate_limit");
  assert.equal(await code(s.cms.createKey(admin, { name: "bad", scopes: ["read"], rateLimit: 1.5 })), "invalid_rate_limit");

  // Without the option nothing is counted.
  const free = setup();
  await free.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  for (let i = 0; i < 20; i++) assert.equal((await free.call("/collections/guide/a")).status, 200);
});

test("allowed addresses: a key is refused from anywhere else", async () => {
  const s = setup();
  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  const { key, secret } = await s.cms.createKey(admin, { name: "office", scopes: ["read"], allowedIps: [" 203.0.113.0/24 ", "2001:db8::/32", "203.0.113.0/24"] });
  assert.deepEqual(key.allowedIps, ["203.0.113.0/24", "2001:db8::/32"]);
  assert.equal((await s.call("/collections/guide/a", { key: secret, ip: "203.0.113.9" })).status, 200);
  assert.equal((await s.call("/collections/guide/a", { key: secret, ip: "2001:db8::1" })).status, 200);
  const other = await s.call("/collections/guide/a", { key: secret, ip: "198.51.100.1" });
  assert.deepEqual([other.status, ((await other.json()) as { error: string }).error], [403, "forbidden_ip"]);
  assert.equal((await s.call("/collections/guide/a", { key: secret })).status, 403, "no address known: refused");
  assert.equal(await code(s.cms.createKey(admin, { name: "bad", scopes: ["read"], allowedIps: ["office"] })), "invalid_ip_range");
  // The app can say where the address comes from.
  const own = createCmsHandler({ cms: s.cms, resolveUser: async () => null, clientIp: (req) => req.headers.get("cf-connecting-ip") });
  const viaHeader = (h: Record<string, string>) => own(new Request("http://app.test/api/cms/collections/guide/a", { headers: { authorization: `Bearer ${secret}`, ...h } }));
  assert.deepEqual([(await viaHeader({ "cf-connecting-ip": "203.0.113.4", "x-forwarded-for": "198.51.100.1" })).status, (await viaHeader({ "x-forwarded-for": "203.0.113.4" })).status], [200, 403]);
});

test("key rotation: the new secret works at once, the old one until the grace time ends, limits come along", async () => {
  const s = setup();
  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  const first = await s.cms.createKey(admin, { name: "deploy", scopes: ["read", "write"], collections: ["guide"], rateLimit: 30, allowedIps: ["203.0.113.0/24"] });
  const res = await s.call(`/keys/${first.key.id}/rotate`, { method: "POST", body: JSON.stringify({ graceMinutes: 10 }), headers: { origin: "http://app.test" } });
  assert.equal(res.status, 401, "only an admin rotates");
  s.session.user = admin;
  const rotated = (await (await s.call(`/keys/${first.key.id}/rotate`, { method: "POST", body: JSON.stringify({ graceMinutes: 10 }), headers: { origin: "http://app.test" } })).json()) as Awaited<ReturnType<typeof s.cms.rotateKey>>;
  s.session.user = null;
  assert.notEqual(rotated.secret, first.secret);
  assert.deepEqual([rotated.key.name, rotated.key.scopes, rotated.key.collections, rotated.key.rateLimit, rotated.key.allowedIps], ["deploy", ["read", "write"], ["guide"], 30, ["203.0.113.0/24"]]);
  assert.equal(rotated.previous.worksUntil, new Date(s.clock.t + 10 * 60_000).toISOString());

  const use = async (secret: string) => (await s.call("/collections/guide/a", { key: secret, ip: "203.0.113.5" })).status;
  assert.deepEqual([await use(first.secret), await use(rotated.secret)], [200, 200]);
  s.minutes(9);
  assert.equal(await use(first.secret), 200, "still inside the grace time");
  s.minutes(2);
  assert.deepEqual([await use(first.secret), await use(rotated.secret)], [401, 200]);

  const list = await s.cms.listKeys(admin);
  const old = list.find((k) => k.id === first.key.id)!;
  assert.deepEqual([old.revokedReason, old.rotatedTo, !!old.revokedAt], ["rotated", rotated.key.id, true]);
  assert.equal(await code(s.cms.rotateKey(admin, first.key.id)), "key_not_found", "a revoked key cannot be rotated");
  assert.equal(await code(s.cms.rotateKey(reader, rotated.key.id)), "forbidden_keys");

  // No grace: the old secret stops now. A rotating key can still be revoked outright.
  const again = await s.cms.rotateKey(admin, rotated.key.id, { graceMinutes: 0 });
  assert.deepEqual([await use(rotated.secret), await use(again.secret)], [401, 200]);
  const third = await s.cms.rotateKey(admin, again.key.id, { graceMinutes: 60 });
  await s.cms.revokeKey(admin, again.key.id, { reason: "  leaked in a log  " });
  assert.equal(await use(again.secret), 401);
  assert.equal((await s.cms.listKeys(admin)).find((k) => k.id === again.key.id)?.revokedReason, "leaked in a log");
  assert.equal(await use(third.secret), 200);
  const audit = (await s.cms.audit(admin, { action: "key.rotate" })).entries;
  assert.equal(audit.length, 3);
});

test("retention: a dry run counts, a run deletes, and cron does it once a day", async () => {
  const s = setup({ retention: { auditDays: 30, hitsDays: 7, revokedKeysDays: 10 } });
  const doc = await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  const gone = await s.cms.createKey(admin, { name: "old", scopes: ["read"] });
  await s.cms.revokeKey(admin, gone.key.id);
  await s.cms.recordHits([doc.id]);
  await tick();
  const before = { audit: s.repo.audit.length, hits: s.repo.hits.size, keys: s.repo.keys.length };
  assert.ok(before.audit >= 3 && before.hits === 1 && before.keys === 1);

  s.minutes(60 * 24 * 8); // eight days on: the hit count is old, the rest is not
  const kept = await s.cms.createKey(admin, { name: "new", scopes: ["read"] });
  await s.cms.recordHits([doc.id]);
  const dry = await s.cms.retention.run(admin, { dryRun: true });
  assert.deepEqual(dry.items.map((i) => [i.what, i.days, i.rows]), [["audit", 30, 0], ["hits", 7, 1], ["keys", 10, 0]]);
  assert.equal(s.repo.hits.size, 2, "a dry run deletes nothing");
  assert.equal(await code(s.cms.retention.run(reader)), "forbidden_admin");
  assert.equal(await code(s.cms.retention.run(anon)), "unauthorized");

  s.minutes(60 * 24 * 25); // day 33: the first audit entries and the revoked key are past their time
  const res = await s.call("/retention", { method: "POST", body: JSON.stringify({ dryRun: true }) });
  assert.equal(res.status, 401);
  s.session.user = admin;
  const viaRest = (await (await s.call("/retention", { method: "POST", body: JSON.stringify({ dryRun: true }), headers: { origin: "http://app.test" } })).json()) as typeof dry;
  assert.deepEqual(viaRest.items.map((i) => [i.what, i.rows]), [["audit", before.audit], ["hits", 2], ["keys", 1]]);
  assert.deepEqual(((await (await s.call("/retention")).json()) as { rules: unknown[] }).rules, [{ what: "audit", days: 30 }, { what: "hits", days: 7 }, { what: "keys", days: 10 }]);

  // The cron call runs it, once per day.
  const auditBefore = s.repo.audit.length;
  await s.cms.cron();
  await tick();
  assert.equal(s.repo.hits.size, 0);
  assert.deepEqual(s.repo.keys.map((k) => k.id), [kept.key.id]);
  assert.equal(s.repo.audit.filter((e) => e.action === "retention.run").length, 1);
  assert.ok(s.repo.audit.length < auditBefore + 1, "old entries went");
  const entry = s.repo.audit.find((e) => e.action === "retention.run")!;
  assert.deepEqual([entry.actorKind, entry.actorLabel], ["system", "retention"]);
  // The same day again: nothing runs, even with something old to delete. The next day it does.
  s.repo.hits.set(`${doc.id}|2020-01-01|rest`, 1);
  await s.cms.cron();
  assert.equal(s.repo.hits.size, 1);
  s.minutes(60 * 24);
  await s.cms.cron();
  await tick();
  assert.equal(s.repo.hits.size, 0);
  assert.equal(s.repo.audit.filter((e) => e.action === "retention.run").length, 2);

  // No rules: nothing runs and nothing is recorded.
  const none = setup();
  assert.equal(await none.cms.retention.tick(), null);
  assert.deepEqual((await none.cms.retention.run(admin)).items, []);
});

test("hooks: beforeValidate fills what is missing, afterPublish and afterDelete are told, afterRead shapes what a reader gets", async () => {
  const published: string[] = [];
  const deleted: string[] = [];
  const s = setup({
    hooks: {
      beforeValidate: [
        ({ input, prev }) => (!prev && !input.slug && input.title ? { slug: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") } : undefined),
        ({ input }) => {
          if (input.title === "forbidden") throw new Error("That title is taken by the legal team");
          return input.title ? { title: input.title.trim() } : undefined;
        },
      ],
      afterPublish: [(doc) => void published.push(`${doc.slug}@${doc.publishedVersion}`), () => Promise.reject(new Error("mail server down"))],
      afterDelete: [(doc) => void deleted.push(doc.slug)],
      afterRead: [
        (doc, { actor, draft }) => (actor.kind === "anonymous" ? { ...doc, fields: { ...doc.fields, internalNote: undefined } } : undefined),
        (doc, { draft }) => {
          if (doc.slug === "secret" && !draft) throw new Error("Not for you");
        },
      ],
    },
  });
  const made = await s.cms.create(admin, "guide", { title: "  Hello World  ", body: "x\n", fields: { internalNote: "ask legal" } });
  assert.deepEqual([made.slug, made.title], ["hello-world", "Hello World"]);
  const err = await s.cms.create(admin, "guide", { title: "forbidden" }).catch((e) => e);
  assert.deepEqual([err.code, err.params.reason], ["hook_rejected", "That title is taken by the legal team"]);
  // An update keeps the address: the first hook only fills it for a new document.
  assert.equal((await s.cms.update(admin, "guide", "hello-world", { title: " Hello again " })).title, "Hello again");

  assert.deepEqual(published, []);
  await s.cms.publish(admin, "guide", "hello-world");
  await tick();
  assert.deepEqual(published, ["hello-world@2"]);
  assert.ok(s.errors.some((e) => e === "afterPublish: mail server down"), "a failing after-hook is reported, not thrown");
  await s.cms.update(admin, "guide", "hello-world", { body: "y\n" });
  await tick();
  assert.deepEqual(published, ["hello-world@2"], "a draft save is not a publish");
  await s.cms.update(admin, "guide", "hello-world", { body: "z\n" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "straight", title: "Straight", body: "x\n" }, { publish: true });
  // A scheduled publish is a publish too.
  await s.cms.create(admin, "guide", { slug: "later", title: "Later", body: "x\n" });
  await s.cms.schedule(admin, "guide", "later", { publishAt: new Date(s.clock.t + 60_000).toISOString() });
  s.minutes(2);
  await s.cms.cron();
  await tick();
  assert.deepEqual(published, ["hello-world@2", "hello-world@4", "straight@1", "later@1"]);

  // afterRead: a stranger does not get the note, an editor does; a hook can refuse a read.
  assert.equal((await s.cms.get(anon, "guide", "hello-world")).fields.internalNote, undefined);
  assert.equal((await s.cms.get(admin, "guide", "hello-world")).fields.internalNote, "ask legal");
  await s.cms.create(admin, "guide", { slug: "secret", title: "Secret", body: "x\n" }, { publish: true });
  assert.equal(await code(s.cms.get(anon, "guide", "secret")), "hook_rejected");
  assert.equal((await s.cms.get(admin, "guide", "secret", { draft: true })).slug, "secret");

  await s.cms.remove(admin, "guide", "later");
  await tick();
  assert.deepEqual(deleted, ["later"]);
  await s.cms.trash.restore(admin, [{ kind: "document", id: (await s.repo.findDoc("guide", "later", { trashed: true }))!.id }]);
  await tick();
  assert.deepEqual(deleted, ["later"], "restoring is not deleting");
});

/** Read frames from a stream until `n` have arrived (or time runs out). */
async function frames(res: Response, n: number, ms = 500): Promise<{ event: string; id: string; data: Record<string, unknown> }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { event: string; id: string; data: Record<string, unknown> }[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const got = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now())))]);
    if (!got || got.done) break;
    buf += dec.decode(got.value, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      if (!event) continue; // "retry:" and keep-alive lines
      out.push({ event, id: /^id: (.+)$/m.exec(block)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") });
    }
  }
  reader.releaseLock();
  return out;
}

test("events: a stranger hears what goes public, an editor hears every save, and a stream that ends stops listening", async () => {
  const s = setup();
  const abortA = new AbortController();
  const abortB = new AbortController();
  // The requests are not kept here on purpose: the stream must hold them, or
  // a collected request never passes its abort on (Node links them weakly).
  const stranger = await s.handler(new Request("http://app.test/api/cms/_events", { signal: abortA.signal }));
  assert.deepEqual([stranger.status, stranger.headers.get("content-type")], [200, "text/event-stream; charset=utf-8"]);
  s.session.user = admin;
  const editor = await s.handler(new Request("http://app.test/api/cms/_events?collections=guide", { signal: abortB.signal }));
  s.session.user = null;
  assert.deepEqual((await frames(stranger, 1)).map((f) => f.event), ["ready"]);
  assert.deepEqual((await frames(editor, 1)).map((f) => [f.event, f.data.collections]), [["ready", ["guide"]]]);

  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" });
  await s.cms.create(admin, "notes", { slug: "n", title: "N", body: "x\n" }, { publish: true });
  await s.cms.publish(admin, "guide", "a");
  await s.cms.update(admin, "guide", "a", { body: "y\n" });
  await tick();
  const heardByEditor = await frames(editor, 3);
  assert.deepEqual(heardByEditor.map((f) => [f.event, f.data.collection, f.data.slug, f.data.version]), [["doc.created", "guide", "a", 1], ["doc.published", "guide", "a", 1], ["doc.updated", "guide", "a", 2]]);
  assert.ok(!Number.isNaN(Date.parse(heardByEditor[0].id)), "the id is a time a client can send back");
  const heardByStranger = await frames(stranger, 2, 150);
  assert.deepEqual(heardByStranger.map((f) => [f.event, f.data.collection, f.data.slug]), [["doc.published", "guide", "a"]], "no drafts, and nothing from the internal collection");

  // Ending the request stops the listener.
  (globalThis as { gc?: () => void }).gc?.();
  abortA.abort();
  abortB.abort();
  (globalThis as { gc?: () => void }).gc?.();
  await tick();
  await s.cms.publish(admin, "guide", "a");
  assert.deepEqual(await frames(editor, 1, 50), []);

  // A collection the caller cannot read is refused, not silently empty.
  const refused = await s.call("/_events?collections=notes");
  assert.deepEqual([refused.status, ((await refused.json()) as { error: string }).error], [401, "unauthorized"]);
  assert.equal((await s.call("/_events?collections=nope")).status, 404);
});

test("events: a client that was away gets one resync with what was saved since, limited to what it may read", async () => {
  const s = setup();
  const t0 = new Date(s.clock.t).toISOString();
  s.minutes(1);
  await s.cms.create(admin, "guide", { slug: "pub", title: "Pub", body: "x\n" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "draft", title: "Draft", body: "x\n" });
  await s.cms.create(admin, "notes", { slug: "n", title: "N", body: "x\n" }, { publish: true });
  await s.cms.update(admin, "guide", "pub", { body: "changed, not published\n" });
  s.minutes(1);

  const forStranger = await frames(await s.call("/_events", { headers: { "last-event-id": t0 } }), 2);
  assert.deepEqual(forStranger.map((f) => f.event), ["resync", "ready"]);
  // 'pub' went public as v1 in the window; its later draft (v2) and the other documents are not for a stranger.
  assert.deepEqual((forStranger[0].data.documents as { collection: string; slug: string; version: number }[]).map((d) => `${d.collection}/${d.slug}@${d.version}`), ["guide/pub@1"]);
  s.session.user = admin;
  const forEditor = await frames(await s.call(`/_events?since=${encodeURIComponent(t0)}`), 2);
  const docs = forEditor[0].data.documents as { collection: string; slug: string; version: number }[];
  assert.deepEqual(docs.map((d) => `${d.collection}/${d.slug}@${d.version}`).sort(), ["guide/draft@1", "guide/pub@2", "notes/n@1"]);
  const later = await frames(await s.call(`/_events?since=${encodeURIComponent(new Date(s.clock.t).toISOString())}`), 2);
  assert.deepEqual(later[0].data.documents, []);
  // Not a time: no resync, just the stream.
  assert.deepEqual((await frames(await s.call("/_events?since=yesterday"), 1)).map((f) => f.event), ["ready"]);
});

test("changedSince: a reader learns about a document only when its public copy is one of the new versions", async () => {
  const s = setup();
  const t0 = new Date(s.clock.t).toISOString();
  s.minutes(1);
  await s.cms.create(admin, "guide", { slug: "pub", title: "Pub", body: "x\n" }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "draft", title: "Draft", body: "x\n" });
  assert.deepEqual((await s.cms.changedSince(anon, t0)).map((d: { slug: string; version: number }) => `${d.slug}@${d.version}`), ["pub@1"]);
  assert.deepEqual((await s.cms.changedSince(admin, t0, { collections: ["guide"] })).map((d: CmsDoc | { slug: string }) => d.slug).sort(), ["draft", "pub"]);
});
