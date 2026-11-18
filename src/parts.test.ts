import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lookupForAgent } from "./agent";
import { runCli } from "./cli";
import { cmsTools, remoteCmsTools } from "./ai";
import { docFromMarkdown } from "./frontmatter";
import { createCms, defineCollection } from "./cms";
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_document", arguments: { collection: "guide", slug: "slack", doc: { summary: "요약" } } } }),
    })
  );
  const res = (await call.json()) as { result: { isError?: boolean; structuredContent: { status: string } } };
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.status, "draft", "a write key saves a draft; publishing needs publish scope");

  const note = await h(new Request("http://x/api/cms/mcp", { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
  assert.equal(note.status, 202);
});

function inProcessFetch(cms: Awaited<ReturnType<typeof seeded>>) {
  const h = createCmsHandler({ cms, resolveUser: async () => null });
  return ((input: RequestInfo | URL, init?: RequestInit) => h(new Request(String(input), init))) as typeof fetch;
}

type Exec = (args: unknown, o: unknown) => Promise<unknown>;
const exec = (t: unknown) => (t as { execute: Exec }).execute;

test("ai: local tools follow the actor's permissions and return errors as results", async () => {
  const cms = await seeded();
  const reader = cmsTools(cms, { kind: "anonymous" });
  assert.ok("get_document" in reader && "search_documents" in reader);
  assert.ok(!("update_document" in reader), "readers get read tools only");
  const editor = cmsTools(cms, { kind: "system", label: "agent" }, { prefix: "cms_" });
  const doc = (await exec(editor.cms_get_document)({ collection: "guide", slug: "slack", draft: true }, {})) as { version: number };
  const ok = (await exec(editor.cms_update_document)({ collection: "guide", slug: "slack", doc: { summary: "새 요약" }, expectedVersion: doc.version }, {})) as { version: number };
  assert.equal(ok.version, doc.version + 1);
  const stale = (await exec(editor.cms_update_document)({ collection: "guide", slug: "slack", doc: { summary: "또" }, expectedVersion: doc.version }, {})) as { error: string };
  assert.equal(stale.error, "conflict");
});

test("ai: remote tools call the app over MCP with a key", async () => {
  const cms = await seeded();
  const { secret } = await cms.createKey(admin, { name: "agent", scopes: ["read", "write", "publish"] });
  const tools = remoteCmsTools({ url: "http://x/api/cms", key: secret, fetch: inProcessFetch(cms) });
  const created = (await exec(tools.create_document)({ collection: "guide", doc: { slug: "notion", title: "Notion 연결", body: "## 연결\n\n노션" }, publish: true }, {})) as { status: string };
  assert.equal(created.status, "published");
  const hits = (await exec(tools.search_documents)({ query: "노션" }, {})) as { slug: string }[];
  assert.equal(hits[0].slug, "notion");
  const missing = (await exec(tools.get_document)({ collection: "guide", slug: "nope" }, {})) as { error: string };
  assert.equal(missing.error, "not_found");
});

test("frontmatter: doc keys, fields and arrays", () => {
  const d = docFromMarkdown("---\ntitle: 제목\nsummary: '요약: 콜론'\nkeywords: [a, b]\ntags: [x]\npinned: true\n---\n본문\n", "file-name");
  assert.deepEqual(d, { body: "본문", slug: "file-name", title: "제목", summary: "요약: 콜론", keywords: ["a", "b"], fields: { tags: ["x"], pinned: true } });
});

test("cli: put creates, then updates with the current version; errors exit 1", async () => {
  const cms = await seeded();
  const { secret } = await cms.createKey(admin, { name: "cli", scopes: ["read", "write", "publish"] });
  const lines: string[] = [];
  const files: Record<string, string> = {
    "/tmp/a.env": `AGENT_CMS_URL=http://x/api/cms\nAGENT_CMS_KEY=${secret}\n`,
    "/tmp/post.md": "---\ntitle: 첫 글\n---\n안녕",
  };
  const io = { env: {}, fetch: inProcessFetch(cms), readFile: (p: string) => files[p], out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  assert.equal(await runCli(["put", "guide", "/tmp/post.md", "--publish", "--env", "/tmp/a.env"], io), 0);
  assert.equal((await cms.get({ kind: "anonymous" }, "guide", "post")).title, "첫 글");
  files["/tmp/post.md"] = "---\ntitle: 고친 글\n---\n안녕";
  assert.equal(await runCli(["put", "guide", "/tmp/post.md", "--env", "/tmp/a.env"], io), 0);
  assert.equal((await cms.get(admin, "guide", "post", { draft: true })).title, "고친 글");
  assert.equal((await cms.get({ kind: "anonymous" }, "guide", "post")).title, "첫 글", "update without --publish stays a draft");
  assert.equal(await runCli(["get", "guide", "nope", "--env", "/tmp/a.env"], io), 1);
  assert.equal(await runCli(["list", "guide"], { ...io, env: {} }), 1, "no url/key → exit 1");
});

test("errors are recognised across copies of the class (bundlers duplicate it)", async () => {
  const { isCmsError } = await import("./types");
  const { isCmsRemoteError } = await import("./client");
  const foreign = Object.assign(new Error("x"), { isCmsError: true, code: "not_found" });
  assert.equal(isCmsError(foreign), true);
  assert.equal(isCmsError(new Error("x")), false);
  assert.equal(isCmsRemoteError(Object.assign(new Error("x"), { isCmsRemoteError: true })), true);
});
