import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lookupForAgent } from "./agent";
import { runCli } from "./cli";
import { createCmsClient } from "./client";
import { docFromMarkdown } from "./frontmatter";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { keyFromHeader } from "./keys";
import { anchorOf, extractToc, parseInline, parseMarkdown, plainText, splitSections } from "./markdown";
import { MemoryRepo } from "./repo";
import { callTool, toolErrorResult, toolsFor } from "./tools";
import type { Actor } from "./types";

const DIR = join(process.cwd(), "src");
const admin: Actor = { kind: "user", id: "u1", label: "관리자", isAdmin: true };

test("standalone: no file imports the host app", () => {
  const files = [...readdirSync(DIR).filter((f) => f.endsWith(".ts")), ...readdirSync(join(DIR, "messages")).map((f) => `messages/${f}`)];
  for (const f of files) {
    // Template strings (files `agent-cms init` writes into the app) may import the app.
    const src = readFileSync(join(DIR, f), "utf8").replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
    const bad = [...src.matchAll(/from\s+["'](@\/[^"']+|\.\.\/[^"']+)["']/g)].map((m) => m[1]).filter((m) => !(f.startsWith("messages/") && m === "../errors"));
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
        visibility: "public",
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
  const anonMcp = await h(new Request("http://x/api/cms/mcp", { method: "POST", body: "{}" }));
  assert.equal(anonMcp.status, 401);
});

function inProcessFetch(cms: Awaited<ReturnType<typeof seeded>>) {
  const h = createCmsHandler({ cms, resolveUser: async () => null });
  return ((input: RequestInfo | URL, init?: RequestInit) => h(new Request(String(input), init))) as typeof fetch;
}

test("tools: toolsFor + callTool follow the actor's permissions and return errors as results", async () => {
  const cms = await seeded();
  const anon: Actor = { kind: "anonymous" };
  const reader = toolsFor(cms, anon).map((t) => t.name);
  assert.ok(reader.includes("get_document") && reader.includes("search_documents"));
  assert.ok(!reader.includes("update_document"), "readers get read tools only");
  // A tool the actor does not have is not callable either.
  const hidden = (await callTool(cms, anon, "update_document", { collection: "guide", slug: "slack", doc: { summary: "x" } })) as { error: string; kind: string };
  assert.equal(hidden.error, "unknown_tool");
  assert.equal(hidden.kind, "not_found");

  const editor: Actor = { kind: "system", label: "agent" };
  const doc = (await callTool(cms, editor, "get_document", { collection: "guide", slug: "slack", draft: true })) as { version: number };
  const ok = (await callTool(cms, editor, "update_document", { collection: "guide", slug: "slack", doc: { summary: "새 요약" }, expectedVersion: doc.version })) as { version: number };
  assert.equal(ok.version, doc.version + 1);
  const stale = (await callTool(cms, editor, "update_document", { collection: "guide", slug: "slack", doc: { summary: "또" }, expectedVersion: doc.version })) as { error: string; kind: string; message: string };
  assert.equal(stale.error, "conflict_version");
  assert.equal(stale.kind, "conflict");
  assert.ok(stale.message.length > 0);
  // Bad input is a result too, and `only` narrows what may be called.
  const bad = (await callTool(cms, editor, "get_document", { collection: 3 })) as { error: string; params: { issues: string } };
  assert.equal(bad.error, "invalid_request");
  assert.match(bad.params.issues, /collection/);
  const narrowed = (await callTool(cms, editor, "delete_document", { collection: "guide", slug: "slack" }, { only: ["get_document"] })) as { error: string };
  assert.equal(narrowed.error, "unknown_tool");
  // Anything that is not a CMS error still throws.
  assert.equal(toolErrorResult(new Error("boom")), null);
});

test("tools: a remote client calls the app over MCP with a key, and its errors become results", async () => {
  const cms = await seeded();
  const { secret } = await cms.createKey(admin, { name: "agent", scopes: ["read", "write", "publish"] });
  const api = createCmsClient({ url: "http://x/api/cms", key: secret, fetch: inProcessFetch(cms) });
  const created = await api.call<{ status: string }>("create_document", { collection: "guide", doc: { slug: "notion", title: "Notion 연결", body: "## 연결\n\n노션" }, publish: true });
  assert.equal(created.status, "published");
  const hits = await api.call<{ slug: string }[]>("search_documents", { query: "노션" });
  assert.equal(hits[0].slug, "notion");
  const missing = await api.call("get_document", { collection: "guide", slug: "nope" }).catch((e) => toolErrorResult(e));
  assert.equal((missing as { error: string }).error, "not_found");
  assert.equal((missing as { kind: string }).kind, "not_found");
});

test("screen tests never hand a DOM node to assert.equal", () => {
  // When such a check fails (inside waitFor that is normal: it is tried again), Node builds the message
  // by printing the node, and a node React drew leads to the whole app. The process then eats memory
  // until it is killed: CI lost its runner twice to `assert.equal(screen.queryByText(…), null)`.
  // Write `assert.ok(screen.queryByText(…) === null)`.
  const dir = join(process.cwd(), "registry", "__tests__");
  const node = /assert\.(?:equal|strictEqual|deepEqual|notEqual)\((?:await\s+)?[^;]*?\b(?:queryBy\w+|getBy\w+|findBy\w+|querySelector|closest)\((?:[^()]|\([^()]*\))*\)\)?,\s*(?:null|undefined)\b/;
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n)))
    readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => node.test(line) && bad.push(`${f}:${i + 1}`));
  assert.deepEqual(bad, []);
  assert.ok(node.test('  await waitFor(() => assert.equal(screen.queryByText("v1 → v2"), null));'), "the pattern still catches the line that did it");
  assert.ok(node.test('  assert.equal(within(dlg).queryByRole("checkbox", { name: /Launch post/ }), null, "why");'));
});

test("commands are written with the full package name", () => {
  // `agent-cms` without the scope is another project's package on npm: outside a folder where this
  // package is installed, `npx agent-cms` downloads that one and stops with "could not determine
  // executable to run". Docs, messages and screens must say `npx @mainsoft/agent-cms`.
  const short = /\b(?:npx|bunx|pnpm dlx|yarn dlx)\s+(?:(?:--yes|-y)\s+)?agent-cms\b/;
  const root = process.cwd();
  const skip = new Set(["node_modules", "dist", ".next", ".slash", ".git", "test-results", "playwright-report", "public"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|md|mdx|json|yml|yaml|css)$/.test(e.name) && e.name !== "package-lock.json") files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 200, "the walk found the sources and the docs");
  // A copied screen's first line is a comment that names the short form. It works there (the app has
  // the package), and changing the line would leave a `.new` copy beside every screen someone edited.
  const copies = /^(registry\/cms|examples\/next\/components\/cms|apps\/docs\/components\/cms)\//;
  const bad: string[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1).split("\\").join("/");
    if (rel === "src/parts.test.ts" || rel === "scripts/pack-smoke.sh") continue; // this test, and the smoke test that runs the bin by its own name on purpose
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!short.test(line)) return;
      if (i === 0 && copies.test(rel) && line.startsWith("// agent-cms registry:")) return;
      bad.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("no model calls: nothing imports a model library, and none is a dependency", () => {
  const banned = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](ai|ai\/[^"']*|@ai-sdk\/[^"']*|openai|@anthropic-ai\/[^"']*|@google\/generative-ai|ollama)["']/g;
  const root = process.cwd();
  const skip = new Set(["node_modules", "dist", ".next", ".slash", "test-results", "playwright-report", "public"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ["src", "registry", "examples", "e2e", "scripts"]) walk(join(root, d));
  assert.ok(files.length > 50, "the walk found the sources");
  for (const f of files) {
    const bad = [...readFileSync(f, "utf8").matchAll(banned)].map((m) => m[1]);
    assert.deepEqual(bad, [], `${f.slice(root.length + 1)} imports ${bad.join(", ")}`);
  }
  const isModelLib = (n: string) => n === "ai" || n.startsWith("@ai-sdk/") || n === "openai" || n.startsWith("@anthropic-ai/") || n === "@google/generative-ai" || n === "ollama";
  for (const p of ["package.json", "examples/next/package.json"]) {
    const pkg = JSON.parse(readFileSync(join(root, p), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const bad = Object.keys(pkg[k] ?? {}).filter(isModelLib);
      assert.deepEqual(bad, [], `${p} ${k} lists ${bad.join(", ")}`);
    }
  }
  assert.ok(!("./ai" in (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, unknown> }).exports), "no ./ai entry");
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
  assert.equal(await runCli(["put", "guide", "/tmp/post.md", "--env", "/tmp/a.env"], io), 1, "existing doc needs --expected-version");
  // A person edits in between: the agent's stale version is refused.
  await cms.update(admin, "guide", "post", { summary: "사람이 고침" });
  assert.equal(await runCli(["put", "guide", "/tmp/post.md", "--expected-version", "1", "--env", "/tmp/a.env"], io), 1, "stale version → conflict");
  assert.equal(await runCli(["put", "guide", "/tmp/post.md", "--expected-version", "2", "--env", "/tmp/a.env"], io), 0);
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

test("frontmatter: # and commas inside quotes are kept", () => {
  const d = docFromMarkdown('---\ntitle: "Fix #123"  # comment\ntags: ["a, b", c]\n---\n본문');
  assert.equal(d.title, "Fix #123");
  assert.deepEqual(d.fields, { tags: ["a, b", "c"] });
});

test("korean screen text is written in 음슴체: no value ends a sentence with 요 (0.15.0)", () => {
  const root = join(import.meta.dirname, "..");
  const files: [string, string][] = [
    ["src/messages/ko.ts", ""],
    ["registry/cms/cms-messages.ts", "export const ko"],
  ];
  const bad: string[] = [];
  for (const [f, marker] of files) {
    const src = readFileSync(join(root, f), "utf8");
    const body = marker ? src.slice(src.indexOf(marker)) : src;
    for (const m of body.matchAll(/^\s+([a-zA-Z_]\w*):\s*"((?:[^"\\]|\\.)*)"/gm)) {
      // 필요 is a noun, not the polite ending.
      if (/(?<!필)요[.!?]?(\s|$)|까요\?/.test(m[2])) bad.push(`${f} ${m[1]}: ${m[2]}`);
    }
  }
  assert.deepEqual(bad, []);
});
