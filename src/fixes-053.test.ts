/** Regression tests for the 0.5.3 fixes (TODO.md section 7). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { remoteCmsToolsFor } from "./ai";
import { createCms, dayIn, defineCollection, type ChangeInfo } from "./cms";
import { createCmsHandler } from "./http";
import { generateKey } from "./keys";
import { toJsonSchema } from "./mcp";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "admin", isAdmin: true };
const tick = () => new Promise((r) => setImmediate(r));

test("0.5.3 #1: a draft-only save does not touch the public copy (contentChanged false)", async () => {
  const seen: ChangeInfo[] = [];
  const hooked: boolean[] = [];
  const guide = defineCollection({ slug: "guide", label: "Guide", hooks: { afterChange: [(_d, info) => void hooked.push(info.contentChanged)] } });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], searchRefreshMs: 0 });
  cms.onChange((_d, info) => seen.push(info));

  await cms.create(admin, "guide", { slug: "a", title: "A", body: "## one\n\nalpha" }); // draft only
  await cms.publish(admin, "guide", "a");
  await cms.update(admin, "guide", "a", { title: "A2" }); // new draft, public copy unchanged
  await cms.archive(admin, "guide", "a");
  await cms.unarchive(admin, "guide", "a");
  await cms.unarchive(admin, "guide", "a"); // no-op
  await cms.remove(admin, "guide", "a");
  await tick();
  assert.deepEqual(
    seen.map((s) => s.contentChanged),
    [false, true, false, true, true, false, true]
  );
  assert.deepEqual(hooked, [false, true, false, true, true, false, true]);
});

test("0.5.3 #1: search still follows a draft save that does not change the index", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "g", label: "g" })], searchRefreshMs: 1e9 });
  await cms.create(admin, "g", { slug: "a", title: "Alpha", body: "## s\n\nzebra" }, { publish: true });
  assert.equal((await cms.search(admin, ["g"], "zebra")).empty, false);
  await cms.update(admin, "g", "a", { body: "## s\n\nyak" }); // draft only
  assert.equal((await cms.search(admin, ["g"], "zebra")).empty, false, "public copy still says zebra");
  await cms.publish(admin, "g", "a");
  assert.equal((await cms.search(admin, ["g"], "zebra")).empty, true);
  assert.equal((await cms.search(admin, ["g"], "yak")).empty, false);
});

test("0.5.3 #2: usage hits count by the configured time zone's calendar day", async () => {
  // 2026-11-19 08:30 in Seoul is still 2026-11-18 in UTC.
  const at = new Date("2026-11-18T23:30:00Z");
  assert.equal(dayIn("Asia/Seoul", at), "2026-11-19");
  assert.equal(dayIn("UTC", at), "2026-11-18");
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [defineCollection({ slug: "g", label: "g" })], now: () => at, timeZone: "Asia/Seoul" });
  const d = await cms.create(admin, "g", { slug: "a", title: "A" });
  await cms.recordHits([d.id]);
  assert.deepEqual([...repo.hits.keys()], [`${d.id}|2026-11-19`]);
  assert.equal((await cms.hitCounts(admin, "g", 1)).get(d.id), 1);
  assert.throws(() => createCms({ repo, collections: [], timeZone: "Mars/Olympus" }), RangeError);
});

test("0.5.3 #3: hitCounts only counts documents of the asked collection", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "a", label: "a" }), defineCollection({ slug: "b", label: "b" })] });
  const x = await cms.create(admin, "a", { slug: "x", title: "x" });
  const y = await cms.create(admin, "b", { slug: "y", title: "y" });
  await cms.recordHits([x.id, y.id]);
  const counts = await cms.hitCounts(admin, "a");
  assert.equal(counts.get(x.id), 1);
  assert.equal(counts.has(y.id), false);
});

test("0.5.3 #4: toJsonSchema keeps lengths, ranges, defaults and enums", () => {
  const s = toJsonSchema(
    z.object({
      name: z.string().min(2).max(10).describe("Name"),
      n: z.number().int().min(1).max(5).default(3),
      tags: z.array(z.string()).min(1).max(3).optional(),
      kind: z.enum(["a", "b"]).default("a"),
      maybe: z.string().nullable().optional(),
    })
  ) as { properties: Record<string, Record<string, unknown>>; required: string[] };
  assert.deepEqual(s.properties.name, { type: "string", minLength: 2, maxLength: 10, description: "Name" });
  assert.deepEqual(s.properties.n, { type: "integer", minimum: 1, maximum: 5, default: 3 });
  assert.deepEqual(s.properties.tags, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 });
  assert.deepEqual(s.properties.kind, { type: "string", enum: ["a", "b"], default: "a" });
  assert.deepEqual(s.properties.maybe, { anyOf: [{ type: "string" }, { type: "null" }] });
  assert.deepEqual(s.required, ["name"]);
});

test("0.5.3 #5: key generation drops biased bytes instead of folding them", () => {
  // 248..255 would map onto 0..7 under `% 62`; they must be skipped.
  let calls = 0;
  const random = (n: number) => {
    calls++;
    return calls === 1 ? new Uint8Array(n).fill(250) : new Uint8Array(n).fill(61);
  };
  const k = generateKey(random);
  assert.equal(k, "sgk_" + "z".repeat(40));
  assert.equal(calls, 2);
  assert.match(generateKey(), /^sgk_[0-9A-Za-z]{40}$/);
});

test("0.5.3 #6: remoteCmsToolsFor offers only the tools the key can use", async () => {
  const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "g", label: "g" })] });
  const { secret } = await cms.createKey(admin, { name: "reader", scopes: ["read"] });
  const h = createCmsHandler({ cms, resolveUser: async () => null });
  const f = ((input: RequestInfo | URL, init?: RequestInit) => h(new Request(String(input), init))) as typeof fetch;
  const tools = await remoteCmsToolsFor({ url: "http://x/api/cms", key: secret, fetch: f });
  assert.ok("get_document" in tools && "search_documents" in tools);
  assert.ok(!("update_document" in tools) && !("publish_document" in tools));
  const only = await remoteCmsToolsFor({ url: "http://x/api/cms", key: secret, fetch: f }, { only: ["get_document", "update_document"] });
  assert.deepEqual(Object.keys(only), ["get_document"]);
});
