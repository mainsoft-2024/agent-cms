/** 0.24.0: plugin settings described as form fields (zod 3 and zod 4), and `_me.pluginsFailed`. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { createRestClient } from "./client";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { definePlugin } from "./plugin";
import { describeSettings } from "./plugin-fields";
import { MemoryRepo } from "./repo";

const expected = [
  { key: "url", type: "secret", label: "Slack webhook URL", optional: false },
  { key: "channel", type: "string", label: "Channel", optional: true, default: "#content" },
  { key: "when", type: "enum", label: "when", optional: true, default: "published", options: ["published", "always"], choices: ["published", "always"] },
  { key: "agents", type: "boolean", label: "agents", optional: true },
  { key: "limit", type: "number", label: "limit", optional: false },
  { key: "home", type: "url", label: "home", optional: true },
  { key: "token", type: "secret", label: "token", optional: true },
  { key: "extra", type: "json", label: "extra", optional: false },
];

test("settings fields: zod 3", () => {
  const shape = z.object({
    url: z.string().url().describe("secret: Slack webhook URL"),
    channel: z.string().default("#content").describe("Channel"),
    when: z.enum(["published", "always"]).default("published"),
    agents: z.boolean().optional(),
    limit: z.number().int(),
    home: z.string().url().nullable(),
    token: z.string().describe("secret").optional(),
    extra: z.object({ a: z.number() }),
  }).shape;
  assert.deepEqual(describeSettings(shape), expected);
});

test("settings fields: zod 4", () => {
  const shape = z4.object({
    url: z4.string().url().describe("secret: Slack webhook URL"),
    channel: z4.string().default("#content").describe("Channel"),
    when: z4.enum(["published", "always"]).default("published"),
    agents: z4.boolean().optional(),
    limit: z4.number().int(),
    home: z4.url().nullable(),
    token: z4.string().describe("secret").optional(),
    extra: z4.object({ a: z4.number() }),
  }).shape;
  assert.deepEqual(describeSettings(shape), expected);
});

test("settings view has fields; _me counts failed plugins for admins only", async () => {
  const slack = definePlugin({
    name: "slack-notify",
    settings: z.object({ url: z.string().url().describe("secret: Webhook URL"), channel: z.string().default("#content") }),
    setup() {},
  });
  const broken = definePlugin({
    name: "broken",
    setup() {},
    start() {
      throw new Error("no connection");
    },
  });
  let admin = true;
  const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public" })], plugins: [slack, broken], secretsKey: "k".repeat(32), onError: () => {} });
  const handler = createCmsHandler({ cms, resolveUser: async () => ({ kind: "user", id: admin ? "a" : "w", label: "X", isAdmin: admin }) });
  const api = createRestClient({ url: "http://t/api/cms", fetch: (async (i: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(i), init))) as typeof fetch });
  const { settings } = await api.pluginSettings("slack-notify");
  assert.deepEqual(settings?.fields, [
    { key: "url", type: "secret", label: "Webhook URL", optional: false },
    { key: "channel", type: "string", label: "channel", optional: true, default: "#content" },
  ]);
  // slack-notify fails too: its url setting is missing.
  assert.equal((await api.me()).pluginsFailed, 2);
  admin = false;
  assert.equal((await api.me()).pluginsFailed, undefined);
});

test("settings fields: a secret is a secret wherever its mark sits, and its default is never sent", async () => {
  const sentinel = "tok_SENTINEL_1234";
  const shape: Record<string, unknown> = {
    a: z.string().describe("secret").default(() => sentinel).describe("API token"),
    b: z4.string().describe("secret: Inner").pipe(z4.string().min(1)),
    n: z.union([z.literal(1), z.literal(2)]).optional(),
    l: z.literal(1),
    o: z.string().pipe(z.string().describe("secret: Out")).default(() => sentinel),
    o4: z4.string().pipe(z4.string().describe("secret")),
  };
  const fields = describeSettings(shape);
  assert.deepEqual(fields[0], { key: "a", type: "secret", label: "API token", optional: true });
  assert.deepEqual(fields[1], { key: "b", type: "secret", label: "Inner", optional: false });
  assert.deepEqual(fields[3], { key: "l", type: "enum", label: "l", optional: false, options: ["1"], choices: [1] });
  assert.equal(fields[4]?.type, "secret");
  assert.equal(fields[5]?.type, "secret");
  assert.ok(!JSON.stringify(fields).includes(sentinel));
  enum Level { Low = -1, High = 1 }
  assert.deepEqual(describeSettings({ lv: z.nativeEnum(Level), lv4: z4.enum(Level) }).map((f) => f.choices), [[-1, 1], [-1, 1]]);

  const p = definePlugin({
    name: "vault",
    settings: z.object({ token: z.string().describe("secret: Token").pipe(z.string().min(3)), when: z.string().describe("secret").default(sentinel), out: z.string().pipe(z.string().describe("secret")).optional() }),
    setup() {},
  });
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public" })], plugins: [p], secretsKey: "k".repeat(32), onError: () => {} });
  const handler = createCmsHandler({ cms, resolveUser: async () => ({ kind: "user", id: "a", label: "X", isAdmin: true }) });
  const api = createRestClient({ url: "http://t/api/cms", fetch: (async (i: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(i), init))) as typeof fetch });
  const saved = await api.savePluginSettings("vault", { token: "abc-SECRET-xyz", out: "abc-SECRET-xyz" });
  const got = await api.pluginSettings("vault");
  for (const body of [saved, got]) {
    assert.ok(!JSON.stringify(body).includes("abc-SECRET-xyz"));
    assert.ok(!JSON.stringify(body).includes(sentinel));
  }
  const rows = JSON.stringify(await repo.findRecordByKey("plugin-settings", "vault"));
  assert.ok(rows.includes("sealed"));
  assert.ok(!rows.includes("abc-SECRET-xyz"));
});

test("client.request stays under the CMS address", async () => {
  const seen: string[] = [];
  const api = createRestClient({ url: "http://t/api/cms", fetch: (async (i: RequestInfo | URL) => (seen.push(new URL(String(i)).pathname), new Response("{}", { headers: { "content-type": "application/json" } }))) as typeof fetch });
  await api.request("GET", "stats/summary", { query: { a: "x/y" } });
  await api.request("GET", "/stats/a%20b");
  assert.deepEqual(seen, ["/api/cms/stats/summary", "/api/cms/stats/a%20b"]);
  for (const bad of ["/../keys", "/stats/..", "/%2e%2e/keys", "/.%2E/keys", "/x/..%2Fkeys", "/x\\..\\keys", "/x?y=1", "/x#y", "//evil.example/x", "/./x", "/%zz"]) {
    await assert.rejects(api.request("GET", bad), TypeError, bad);
  }
  assert.equal(seen.length, 2);
});

test("plugin init refuses names the CMS uses for its routes", async () => {
  const { validPluginName } = await import("./plugin-scaffold");
  assert.equal(validPluginName("read-stats"), true);
  for (const n of ["plugins", "search", "keys", "Bad", "a"]) assert.equal(validPluginName(n), false, n);
});
