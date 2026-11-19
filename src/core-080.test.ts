/** 0.8.0: an agent acting for a person (`actor.agent`), recorded and reviewed like any agent. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupForAgent } from "./agent";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import { callTool } from "./tools";
import { isCmsError, type Actor } from "./types";

const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
const staff = defineCollection({ slug: "staff", label: "Staff", visibility: "internal", access: { read: ({ actor }) => actor.kind === "user", write: ({ actor }) => actor.kind === "user" && actor.isAdmin } });

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const adminViaBot: Actor = { ...admin, agent: { label: "docs-bot" } };
const member: Actor = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const memberViaBot: Actor = { ...member, agent: { label: "docs-bot" } };

function setup() {
  const repo = new MemoryRepo();
  const cms = createCms({ repo, collections: [guide, staff] });
  return { repo, cms };
}

test("actor.agent: versions, the document and the audit log record the agent next to the person", async () => {
  const { repo, cms } = setup();
  await cms.create(admin, "guide", { slug: "slack", title: "Slack", body: "## Connect\n\nold line\n" });
  const d = await cms.update(adminViaBot, "guide", "slack", { body: "## Connect\n\nnew line\n" });
  assert.equal(d.updatedBy, "Kim");
  assert.equal(d.updatedByKind, "user");
  assert.equal(d.updatedByAgent, "docs-bot");
  const [v2, v1] = await cms.versions(admin, "guide", "slack");
  assert.deepEqual([v2.authorKind, v2.authorLabel, v2.authorAgent], ["user", "Kim", "docs-bot"]);
  assert.equal(v1.authorAgent, null, "the person's own version has no agent");

  // A person's later edit clears the mark on the document.
  const d3 = await cms.update(admin, "guide", "slack", { summary: "s" });
  assert.equal(d3.updatedByAgent, null);

  await cms.publish(adminViaBot, "guide", "slack");
  await new Promise((r) => setTimeout(r, 0));
  const entry = repo.audit.find((e) => e.action === "doc.publish")!;
  assert.deepEqual([entry.actorKind, entry.actorLabel, entry.actorAgent], ["user", "Kim", "docs-bot"]);
  const list = await cms.page(admin, "guide", { drafts: true });
  assert.equal(list.docs[0].updatedByAgent, "docs-bot");
});

test("actor.agent: its edits are agent changes to review; a person's are not", async () => {
  const { cms } = setup();
  await cms.create(admin, "guide", { slug: "slack", title: "Slack", body: "## Connect\n\nold line\n" });
  assert.equal((await cms.agentChanges(admin, "guide", "slack")).length, 0);
  await cms.update(admin, "guide", "slack", { body: "## Connect\n\nmine\n" });
  assert.equal((await cms.agentChanges(admin, "guide", "slack")).length, 0, "a person's edit is not an agent change");
  await cms.update(adminViaBot, "guide", "slack", { body: "## Connect\n\nfrom the agent\n" });
  const changes = await cms.agentChanges(admin, "guide", "slack");
  assert.equal(changes.length, 1);
  assert.deepEqual([changes[0].author, changes[0].authorKind, changes[0].behalf], ["docs-bot", "user", "Kim"]);
  // A key's change still has no `behalf`.
  const { secret } = await cms.createKey(admin, { name: "ci", scopes: ["read", "write"] });
  const key = (await cms.authenticateKey(secret))!;
  await cms.update(key, "guide", "slack", { body: "## Connect\n\nfrom the key\n" });
  const byKey = (await cms.agentChanges(admin, "guide", "slack")).find((c) => c.authorKind === "key")!;
  assert.deepEqual([byKey.author, byKey.behalf], ["ci", null]);
  // Answers built from the document say an agent wrote that section.
  await cms.update(adminViaBot, "guide", "slack", { body: "## Connect\n\nfrom the agent again\n" });
  await cms.publish(admin, "guide", "slack");
  const r = await lookupForAgent(cms, admin, ["guide"], "connect agent");
  assert.equal(r.sections[0]?.trust, "agent");
});

test("actor.agent: permissions are exactly the person's", async () => {
  const { cms } = setup();
  // A member may not write to staff, with or without an agent.
  for (const who of [member, memberViaBot]) {
    await assert.rejects(cms.create(who, "staff", { slug: "a", title: "A" }), (e) => isCmsError(e) && e.code === "forbidden_write");
  }
  // An admin may, and so may the agent acting for the admin.
  const d = await cms.create(adminViaBot, "staff", { slug: "a", title: "A" });
  assert.equal(d.updatedByAgent, "docs-bot");
  // The tool list is the person's too.
  const denied = (await callTool(cms, memberViaBot, "create_document", { collection: "staff", doc: { slug: "b", title: "B" } })) as { error: string };
  assert.ok(["forbidden_write", "unknown_tool"].includes(denied.error), denied.error);
  // A blank label is no agent at all.
  const blank = await cms.update({ ...admin, agent: { label: "  " } } as Actor, "staff", "a", { summary: "x" });
  assert.equal(blank.updatedByAgent, null);
});

test("actor.agent: a request can never set it (REST and MCP)", async () => {
  const { cms } = setup();
  // Even when the app's own resolveUser returns it, the handler drops it.
  const h = createCmsHandler({ cms, resolveUser: async () => adminViaBot as Extract<Actor, { kind: "user" }> });
  const res = await h(
    new Request("http://x/api/cms/collections/guide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { slug: "rest", title: "REST" }, agent: { label: "spoof" }, actor: { agent: { label: "spoof" } } }),
    })
  );
  assert.equal(res.status, 201);
  const d = await cms.get(admin, "guide", "rest", { draft: true });
  assert.equal(d.updatedByAgent, null);
  assert.equal((await cms.versions(admin, "guide", "rest"))[0].authorAgent, null);
  // A key over MCP stays a key.
  const { secret } = await cms.createKey(admin, { name: "ci", scopes: ["read", "write"] });
  const mcp = await h(
    new Request("http://x/api/cms/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_document", arguments: { collection: "guide", doc: { slug: "mcp", title: "MCP" }, agent: { label: "spoof" } } } }),
    })
  );
  const body = (await mcp.json()) as { result: { isError?: boolean } };
  // The unknown `agent` argument is either refused or ignored; either way nothing records it.
  if (!body.result.isError) {
    const viaKey = await cms.get(admin, "guide", "mcp", { draft: true });
    assert.deepEqual([viaKey.updatedByKind, viaKey.updatedByAgent], ["key", null]);
  }
});
