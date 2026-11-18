import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lookupForAgent } from "./agent";
import { prNumbersFromLog, runCli } from "./cli";
import { createCms, defineCollection } from "./cms";
import { matchesAny } from "./glob";
import { createCmsHandler } from "./http";
import { keyFromHeader } from "./keys";
import { anchorOf, extractToc, parseInline, parseMarkdown, plainText, splitSections } from "./markdown";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const DIR = join(process.cwd(), "src");
const admin: Actor = { kind: "user", id: "u1", label: "관리자", isAdmin: true };

test("standalone: no file imports the host app", () => {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(DIR, f), "utf8");
    const bad = [...src.matchAll(/from\s+["'](@\/[^"']+|\.\.\/[^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(bad, [], `${f} imports ${bad.join(", ")}`);
  }
});

test("markdown: headings get stable unique anchors matching splitSections", () => {
  const body = "intro\n\n## 연결하기\n\n### 준비\n\ntext\n\n## 연결하기\n\n끝";
  const toc = extractToc(parseMarkdown(body));
  assert.deepEqual(toc.map((t) => t.id), ["연결하기", "준비", "연결하기-1"]);
  assert.deepEqual(splitSections(body).map((s) => s.anchor), ["", "연결하기", "연결하기-1"]);
  assert.equal(anchorOf("Slack 연결, 끊기!"), "slack-연결-끊기");
});

test("markdown: links, callouts, lists and unsafe hrefs", () => {
  const blocks = parseMarkdown("> [!tip]\n> 팁이에요\n\n1. 하나\n2. 둘\n\n[[link:a.b|화면]]\n\n[x](javascript:alert(1))");
  assert.equal(blocks[0].t, "quote");
  assert.equal(blocks[0].t === "quote" && blocks[0].callout, "tip");
  assert.equal(blocks[1].t === "list" && blocks[1].ordered, true);
  assert.equal(blocks[2].t, "links");
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "text", v: "x" }]);
  assert.equal(plainText("**굵게** [[link:a|화면]] `코드`"), "굵게 화면 코드");
});

test("glob: folders, ** and braces", () => {
  assert.ok(matchesAny("src/features/settings/ui/a.tsx", ["src/features/settings"]));
  assert.ok(matchesAny("src/a/b/c.ts", ["src/**/*.ts"]));
  assert.ok(matchesAny("src/x.ts", ["src/**/*.ts"]));
  assert.ok(matchesAny("src/lib/mcp/catalog.ts", ["src/lib/{mcp,slack}/**"]));
  assert.ok(!matchesAny("src/lib/mem/x.ts", ["src/lib/{mcp,slack}/**"]));
  assert.ok(!matchesAny("src/features/settingsX/a.ts", ["src/features/settings"]));
});

test("keys: header formats", () => {
  const k = "sgk_" + "a".repeat(40);
  assert.equal(keyFromHeader(`Bearer ${k}`), k);
  assert.equal(keyFromHeader(`users API-Key ${k}`), k);
  assert.equal(keyFromHeader("Bearer nope"), null);
});

async function seeded() {
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [
      defineCollection({
        slug: "guide",
        label: "가이드",
        coverage: true,
        links: { resolve: (k) => (k === "settings.integrations" ? "/settings/integrations" : null) },
        url: (d) => `/guide/${d.slug}`,
      }),
    ],
  });
  await cms.create(
    admin,
    "guide",
    {
      slug: "slack",
      title: "Slack 연결하기",
      keywords: ["슬랙"],
      covers: ["src/slack/**"],
      body: "## 연결하기\n\n[[link:settings.integrations|연동 서비스]]에서 **연결**을 눌러요.",
    },
    { publish: true }
  );
  return cms;
}

test("agent lookup: sections, resolved links, anchors", async () => {
  const cms = await seeded();
  const r = await lookupForAgent(cms, { kind: "anonymous" }, ["guide"], "슬랙 연결");
  assert.equal(r.found, true);
  assert.equal(r.sections[0].url, "/guide/slack#%EC%97%B0%EA%B2%B0%ED%95%98%EA%B8%B0");
  assert.ok(r.sections[0].text.includes("연동 서비스에서"));
  assert.ok(!r.sections[0].text.includes("[[link"));
  assert.deepEqual(r.links, [{ key: "settings.integrations", label: "연동 서비스", href: "/settings/integrations" }]);
});

test("http: REST read, key auth, MCP tools", async () => {
  const cms = await seeded();
  const h = createCmsHandler({ cms, resolveUser: async () => null });
  const get = await h(new Request("http://x/api/cms/collections/guide/slack"));
  assert.equal(get.status, 200);
  assert.equal(((await get.json()) as { doc: { title: string } }).doc.title, "Slack 연결하기");

  const denied = await h(new Request("http://x/api/cms/collections/guide", { method: "POST", body: JSON.stringify({ doc: { slug: "a", title: "a" } }) }));
  assert.equal(denied.status, 401);

  const bad = await h(new Request("http://x/api/cms/collections/guide", { headers: { authorization: "Bearer sgk_" + "z".repeat(40) } }));
  assert.equal(bad.status, 401);

  const { secret } = await cms.createKey(admin, { name: "agent", scopes: ["write"] });
  const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const list = await h(new Request("http://x/api/cms/mcp", { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(tools.includes("update_document"));
  assert.ok(!tools.includes("publish_document"), "write key must not see publish");

  const call = await h(
    new Request("http://x/api/cms/mcp", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_document", arguments: { collection: "guide", slug: "slack", doc: { summary: "요약" }, pr: 9 } } }),
    })
  );
  const res = (await call.json()) as { result: { isError?: boolean; structuredContent: { status: string } } };
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.status, "pending");

  const note = await h(new Request("http://x/api/cms/mcp", { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
  assert.equal(note.status, 202);
});

test("cli: PR numbers from merge and squash subjects", () => {
  assert.deepEqual(prNumbersFromLog("feat: x (#12)\nMerge pull request #34 from a/b\nchore: y"), [12, 34]);
});

test("cli: check-coverage fails without update, passes with skip token", async () => {
  const cms = await seeded();
  const { secret } = await cms.createKey(admin, { name: "ci", scopes: ["read"] });
  const h = createCmsHandler({ cms, resolveUser: async () => null });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => h(new Request(String(input), init))) as typeof fetch;
  const lines: string[] = [];
  const env = (log: string) => ({
    url: "http://x/api/cms",
    key: secret,
    fetch: fetchImpl,
    log: (l: string) => lines.push(l),
    git: (args: string[]) => (args[0] === "diff" ? "src/slack/a.ts\nREADME.md\n" : log),
  });
  assert.equal(await runCli(["check-coverage", "--pr", "5"], env("feat: change")), 1);
  assert.ok(lines.join("\n").includes("guide/slack"));
  assert.equal(await runCli(["check-coverage", "--pr", "5"], env("feat: change\n\nGUIDE-OK")), 0);
  assert.equal(await runCli(["check-coverage"], { log: () => {} }), 0, "no secrets → skip");
});
