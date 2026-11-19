import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { ANONYMOUS_READ_TOOLS } from "./mcp";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Admin", isAdmin: true };

async function site() {
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [
      defineCollection({ slug: "docs", label: "Docs", visibility: "public" }),
      defineCollection({ slug: "notes", label: "Notes", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } }),
    ],
  });
  await cms.create(admin, "docs", { slug: "install", title: "Install", body: "Run npm i to install the package." }, { publish: true });
  await cms.create(admin, "docs", { slug: "secret-draft", title: "Draft page", body: "Not ready to install yet." });
  await cms.create(admin, "notes", { slug: "roadmap", title: "Roadmap", body: "Install plans for next quarter." }, { publish: true });
  return cms;
}

const rpc = (method: string, params?: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

type ToolsList = { result: { tools: { name: string }[] } };
type CallResult = { result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> } };

test("mcp: keyless requests stay 401 unless anonymous read is on", async () => {
  const cms = await site();
  const off = createCmsHandler({ cms, resolveUser: async () => null });
  assert.equal((await off(new Request("http://x/api/cms/mcp", rpc("tools/list")))).status, 401);
  const explicitOff = createCmsHandler({ cms, resolveUser: async () => null, mcp: { anonymous: false } });
  assert.equal((await explicitOff(new Request("http://x/api/cms/mcp", rpc("tools/list")))).status, 401);
});

test("mcp anonymous read: read tools only, published public documents only", async () => {
  const cms = await site();
  const h = createCmsHandler({ cms, resolveUser: async () => null, mcp: { anonymous: "read" } });

  const list = (await (await h(new Request("http://x/api/cms/mcp", rpc("tools/list")))).json()) as ToolsList;
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...ANONYMOUS_READ_TOOLS].sort());

  const call = async (name: string, args: Record<string, unknown>) => (await (await h(new Request("http://x/api/cms/mcp", rpc("tools/call", { name, arguments: args })))).json()) as CallResult;

  const write = await call("update_document", { collection: "docs", slug: "install", doc: { title: "Hacked" } });
  assert.equal(write.result.isError, true);
  assert.match(write.result.content[0].text, /^unknown_tool/);
  assert.equal((await cms.get(admin, "docs", "install")).title, "Install");

  const found = await call("search_documents", { query: "install" });
  const text = found.result.content[0].text;
  assert.ok(text.includes("install"), text);
  assert.ok(!text.includes("secret-draft"), "drafts must not show");
  assert.ok(!text.includes("roadmap"), "internal collections must not show");

  const draft = await call("get_document", { collection: "docs", slug: "secret-draft", draft: true });
  assert.equal(draft.result.isError, true);
  const internal = await call("get_document", { collection: "notes", slug: "roadmap" });
  assert.equal(internal.result.isError, true);

  const cols = await call("list_collections", {});
  assert.ok(!cols.result.content[0].text.includes("notes"));

  const resources = (await (await h(new Request("http://x/api/cms/mcp", rpc("resources/list")))).json()) as { result: { resources: { uri: string }[] } };
  assert.deepEqual(resources.result.resources.map((r) => r.uri), ["cms://docs/install"]);
});

test("mcp anonymous read: a key still gets its own tools", async () => {
  const cms = await site();
  const h = createCmsHandler({ cms, resolveUser: async () => null, mcp: { anonymous: "read" } });
  const { secret } = await cms.createKey(admin, { name: "bot", scopes: ["write"] });
  const req = rpc("tools/list");
  const res = (await (await h(new Request("http://x/api/cms/mcp", { ...req, headers: { ...req.headers, authorization: `Bearer ${secret}` } }))).json()) as ToolsList;
  assert.ok(res.result.tools.some((t) => t.name === "update_document"));
});
