/** 0.13.0: the OpenAPI document, imports from other places, the Node adapter, and the CLI around them. */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { toNodeHandler } from "./adapters/node";
import { runCli } from "./cli";
import { createCms, defineCollection } from "./cms";
import { docFromMarkdown } from "./frontmatter";
import { createCmsHandler } from "./http";
import { docsFromCsv, docsFromJson, docsFromWordpress, filesFromDocs, filesFromSource, htmlToMarkdown, parseCsv, slugify } from "./import-sources";
import { API_ROUTES, openApiDocument } from "./openapi";
import { MemoryRepo } from "./repo";
import { MemoryStorage } from "./storage";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };

function setup(o: { bare?: boolean } = {}) {
  const store = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  const blog = defineCollection({ slug: "blog", label: "Blog", visibility: "public", categories: ["News", "Notes"], fields: z.object({ tags: z.array(z.string()).default([]), rating: z.number().int().min(1).max(5).optional(), cover: z.string().optional() }) });
  const notes = defineCollection({ slug: "team-notes", label: "Team notes", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [blog, notes],
    warn: () => {},
    ...(o.bare ? {} : { cronSecret: "c".repeat(32), secretsKey: "s".repeat(40), previewSecret: "p".repeat(40), media: { stores: { public: { visibility: "public" as const, adapter: store } } } }),
  });
  const session = { user: admin as Extract<Actor, { kind: "user" }> | null };
  const handler = createCmsHandler({ cms, resolveUser: async () => session.user });
  return { cms, handler, session, store };
}

test("openapi: every documented route is answered by the handler, and the handler knows no route that is not documented", async () => {
  const { cms, handler } = setup();
  await cms.create(admin, "blog", { slug: "a", title: "A", category: "News", body: "x\n" }, { publish: true });
  const fill: Record<string, string> = { collection: "blog", slug: "a", id: "x", n: "1", store: "public", name: "f.png", userId: "u9", documentId: "d1" };
  const missing: string[] = [];
  for (const r of API_ROUTES) {
    const path = r.path.replace(/\{(\w+)\}/g, (_m, k: string) => fill[k]);
    const hasBody = r.method !== "get" && r.method !== "delete";
    const res = await handler(
      new Request(`http://localhost/api/cms${path}${r.path === "/preview" || r.path === "/preview/comments" ? "?token=x" : ""}`, {
        method: r.method.toUpperCase(),
        headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(r.auth === "cron" ? { authorization: `Bearer ${"c".repeat(32)}` } : {}) },
        body: hasBody ? "{}" : undefined,
      })
    );
    const stream = res.headers.get("content-type")?.startsWith("text/event-stream");
    if (stream) await res.body?.cancel();
    const text = stream || res.status === 302 || res.status === 304 ? "" : await res.text();
    if (/"error":"route_not_found"/.test(text)) missing.push(`${r.method.toUpperCase()} ${r.path}`);
  }
  assert.deepEqual(missing, [], "documented but not handled");

  // The other direction: the first path segments the handler's code compares against.
  const source = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const known = new Set([...source.matchAll(/seg\[0\] === "([\w.]+)"/g)].map((m) => m[1]));
  const documented = new Set(API_ROUTES.map((r) => r.path.split("/")[1]));
  documented.add("_audit"); // an old name for /audit, kept for apps that call it
  assert.deepEqual([...known].filter((k) => !documented.has(k)).sort(), [], "handled but not documented");
  // And every operation has a unique id.
  const doc = openApiDocument(cms, { actor: admin });
  const ids = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((p) => Object.values(p).map((op) => op.operationId));
  assert.equal(new Set(ids).size, ids.length);
});

test("openapi: collections carry their own fields; what a caller cannot read or has not switched on is left out", async () => {
  const { cms, handler, session } = setup();
  const res = await handler(new Request("http://localhost:3000/api/cms/openapi.json", { headers: { host: "cms.example.com", "x-forwarded-proto": "https" } }));
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { openapi: string; info: { version: string }; servers: { url: string }[]; paths: Record<string, Record<string, Record<string, unknown>>>; components: { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> } };
  assert.deepEqual([doc.openapi, doc.servers[0].url], ["3.1.0", "https://cms.example.com/api/cms"]);
  const fields = doc.components.schemas.BlogDoc.properties.fields as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual([fields.properties.rating.type, fields.properties.rating.minimum, fields.properties.rating.maximum, (fields.properties.tags.items as { type: string }).type], ["integer", 1, 5, "string"]);
  assert.deepEqual(doc.components.schemas.BlogInput.properties.category.enum, ["News", "Notes", null]);
  assert.equal(doc.paths["/collections/blog/{slug}"].patch.operationId, "patchBlogDoc");
  assert.match(JSON.stringify(doc.paths["/collections/blog/{slug}"].get.responses), /BlogDoc/);
  assert.match(JSON.stringify(doc.paths["/collections/blog"].post.requestBody), /BlogInput/);
  assert.ok(doc.paths["/collections/team-notes"], "the signed-in admin reads the internal collection");
  assert.ok(doc.paths["/assets/uploads"] && doc.paths["/_cron"]);

  session.user = null;
  const anon = (await (await handler(new Request("http://localhost/api/cms/openapi.json"))).json()) as typeof doc;
  assert.equal(anon.paths["/collections/team-notes"], undefined, "an internal collection is not listed for a stranger");
  assert.ok(!JSON.stringify(anon).includes("team-notes"));
  const bare = openApiDocument(setup({ bare: true }).cms) as typeof doc;
  assert.deepEqual([bare.paths["/assets"], bare.paths["/_cron"], bare.paths["/collections/{collection}/{slug}/preview"]], [undefined, undefined, undefined]);
  assert.ok(bare.paths["/collections/{collection}/{slug}/publish"]);

  // What the document says is what the API takes: a body built from the schema's required keys is accepted.
  session.user = admin;
  const made = await handler(new Request("http://localhost/api/cms/collections/blog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { slug: "typed", title: "Typed", category: "News", fields: { rating: 4, tags: ["x"] } } }) }));
  assert.equal(made.status, 201);
  const bad = await handler(new Request("http://localhost/api/cms/collections/blog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { slug: "typed2", title: "T", category: "News", fields: { rating: 9 } } }) }));
  assert.equal(bad.status, 422, "the maximum in the document is the maximum the API enforces");
  void cms;
});

test("html to markdown: what a WordPress or a pasted page holds comes out as the markdown this CMS stores", () => {
  const md = htmlToMarkdown(`<!-- wp:heading --><h2 class="x">Getting  started</h2><!-- /wp:heading -->
<p>Hello <strong>bold</strong> and <em>soft</em> &amp; a <a href="https://example.com/a b">link</a>.<br>Next line</p>
<ul><li>One</li><li>Two<ul><li>Deep</li></ul></li></ul>
<ol><li>First</li><li>Second</li></ol>
<blockquote><p>Quoted <b>text</b></p><p>More</p></blockquote>
<pre><code class="language-ts">const a = 1 &lt; 2;
if (a) { run(); }</code></pre>
<figure><img src="https://cdn.example.com/a.png" alt="A [cat]"><figcaption>Caption</figcaption></figure>
<img src="http://insecure.example/x.png" alt="dropped"><img src="javascript:alert(1)">
<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>0 | none</td></tr></table>
<script>alert(1)</script><style>p{}</style><a href="javascript:alert(1)">bad link</a><hr/>`);
  assert.equal(
    md,
    [
      "## Getting started",
      "Hello **bold** and *soft* & a [link](https://example.com/a%20b).\nNext line",
      "- One\n- Two\n  - Deep",
      "1. First\n2. Second",
      "> Quoted **text**\n>\n> More",
      "```ts\nconst a = 1 < 2;\nif (a) { run(); }\n```",
      "![A cat](https://cdn.example.com/a.png)",
      "Caption",
      "| Plan | Price |\n| --- | --- |\n| Free | 0 \\| none |",
      "bad link",
      "---",
    ].join("\n\n")
  );
  // The classic editor has no <p>: blank lines are paragraphs.
  assert.equal(htmlToMarkdown("First para\nsame para\n\nSecond <b>para</b>"), "First para same para\n\nSecond **para**");
  assert.equal(htmlToMarkdown(""), "");
  assert.deepEqual([slugify("Hello, World!"), slugify("%ED%95%9C%EA%B8%80"), slugify("Crème brûlée  2"), slugify("--a--")], ["hello-world", "", "creme-brulee-2", "a"]);
});

test("import sources: JSON, CSV and a WordPress export become files the import reads", () => {
  const json = docsFromJson(JSON.stringify({ documents: [{ slug: "A One", title: "One", content: "<p>Hi <b>there</b></p>", tags: "x, y", rating: 4, status: "published" }, { title: "Two", body: "# md", keywords: ["k"], fields: { rating: 2 } }, "junk"] }));
  assert.deepEqual(json.map((d) => [d.slug, d.title, d.html, d.body, d.keywords, d.fields]), [["A One", "One", "<p>Hi <b>there</b></p>", undefined, ["x", "y"], { rating: 4 }], [undefined, "Two", undefined, "# md", ["k"], { rating: 2 }]]);
  const files = filesFromDocs([...json, { title: "One" }, { title: "한글 제목" }], { collection: "blog" });
  assert.deepEqual(files.map((f) => f.path), ["blog/a-one.md", "blog/two.md", "blog/one.md", "blog/doc-4.md"]);
  const back = docFromMarkdown(files[0].text);
  assert.deepEqual([back.slug, back.title, back.body?.trim(), back.keywords, back.fields], ["a-one", "One", "Hi **there**", ["x", "y"], { rating: 4 }]);
  assert.match(files[0].text, /status: published/);
  assert.throws(() => docsFromJson('{"a":1}'), /JSON array/);

  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, ""q""","multi\nline"\n\n1,2'), [["a", "b"], ['x, "q"', "multi\nline"], ["1", "2"]]);
  const csv = docsFromCsv('title,slug,body,keywords,rating,category\n"Hello, CSV",hello,"Line one\n\nLine two",a;b,5,News\nNo slug,,text,,,');
  assert.deepEqual(csv.map((d) => [d.title, d.slug, d.body, d.keywords, d.fields, d.category]), [["Hello, CSV", "hello", "Line one\n\nLine two", ["a", "b"], { rating: "5" }, "News"], ["No slug", undefined, "text", undefined, {}, undefined]]);
  assert.throws(() => docsFromCsv("a,b\n1,2"), /title/);

  const wxr = `<?xml version="1.0"?><rss><channel><title>Site</title>
<item><title>Hello &amp; welcome</title><wp:post_name><![CDATA[hello-welcome]]></wp:post_name><wp:post_type><![CDATA[post]]></wp:post_type><wp:status><![CDATA[publish]]></wp:status>
<wp:post_date_gmt><![CDATA[2025-03-01 10:00:00]]></wp:post_date_gmt>
<category domain="category" nicename="news"><![CDATA[News]]></category><category domain="post_tag" nicename="t"><![CDATA[Launch]]></category><category domain="category" nicename="u"><![CDATA[Uncategorized]]></category>
<excerpt:encoded><![CDATA[Short <b>text</b>]]></excerpt:encoded>
<content:encoded><![CDATA[<!-- wp:paragraph --><p>Body with <a href="https://x.example">a link</a></p><!-- /wp:paragraph -->]]></content:encoded></item>
<item><title>A page</title><wp:post_name><![CDATA[%ED%8E%98%EC%9D%B4%EC%A7%80]]></wp:post_name><wp:post_type><![CDATA[page]]></wp:post_type><wp:status><![CDATA[draft]]></wp:status><content:encoded><![CDATA[Plain]]></content:encoded></item>
<item><title>img</title><wp:post_type><![CDATA[attachment]]></wp:post_type><wp:status><![CDATA[inherit]]></wp:status></item>
<item><title>gone</title><wp:post_type><![CDATA[post]]></wp:post_type><wp:status><![CDATA[trash]]></wp:status></item>
</channel></rss>`;
  const wp = docsFromWordpress(wxr);
  assert.deepEqual(wp.map((d) => [d.title, d.slug, d.status, d.keywords, d.summary, d.updatedAt]), [["Hello & welcome", "hello-welcome", "published", ["News", "Launch"], "Short **text**", "2025-03-01T10:00:00Z"], ["A page", "%ED%8E%98%EC%9D%B4%EC%A7%80", "draft", [], undefined, undefined]]);
  assert.equal(docsFromWordpress(wxr, { types: ["page"] }).length, 1);
  const out = filesFromSource("wordpress", wxr, { collection: "blog" });
  assert.deepEqual(out.map((f) => f.path), ["blog/hello-welcome.md", "blog/a-page.md"]);
  assert.equal(docFromMarkdown(out[0].text).body?.trim(), "Body with [a link](https://x.example)");
});

test("node adapter: a plain http server answers like the web handler (headers, bodies, redirects, limits)", async () => {
  const { cms, handler } = setup();
  await cms.create(admin, "blog", { slug: "a", title: "A", category: "News", body: "x\n" }, { publish: true });
  const seen: string[] = [];
  const server = createServer(toNodeHandler((req) => (seen.push(req.url), handler(req)), { maxBodyBytes: 2000 }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cms`;
  try {
    const got = await fetch(`${base}/collections/blog/a`);
    assert.deepEqual([got.status, got.headers.get("etag"), ((await got.json()) as { doc: { title: string } }).doc.title], [200, '"v1"', "A"]);
    assert.equal((await fetch(`${base}/collections/blog/a`, { headers: { "if-none-match": '"v1"' } })).status, 304);
    const made = await fetch(`${base}/collections/blog`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: JSON.stringify({ doc: { slug: "b", title: "B", category: "Notes" } }) });
    assert.equal(made.status, 201);
    assert.equal((await cms.get(admin, "blog", "b", { draft: true })).title, "B");
    // A page elsewhere cannot write with the person's session: the Host the server saw is the app's.
    assert.equal((await fetch(`${base}/collections/blog`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status, 403);
    const big = await fetch(`${base}/collections/blog`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { slug: "big", title: "x".repeat(3000) } }) });
    assert.deepEqual([big.status, ((await big.json()) as { error: string }).error], [413, "body_too_large"]);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.ok(seen[0].startsWith("http://127.0.0.1:"));
    // Behind a proxy the address people open is used.
    await fetch(`${base}/_me`, { headers: { "x-forwarded-proto": "https" } });
    assert.ok(seen[seen.length - 1].startsWith("https://127.0.0.1:"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("node adapter: a body that fails while the socket is full ends the response instead of hanging", async () => {
  let fail: (e: Error) => void = () => {};
  const big = new Uint8Array(1 << 20).fill(97);
  const server = createServer(
    toNodeHandler(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // Far more than the socket takes at once: the adapter waits for "drain".
          for (let i = 0; i < 8; i++) c.enqueue(big);
          fail = (e) => c.error(e);
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    })
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { request } = await import("node:http");
    // The server's own socket closing shows the response was cut (a paused client may not notice).
    const ended = await new Promise<string>((done) => {
      server.once("connection", (sock) => sock.once("close", () => done("closed")));
      const req = request({ host: "127.0.0.1", port, path: "/" }, (res) => {
        // Do not read: the server's writes back up. Then the body fails.
        res.pause();
        setTimeout(() => fail(new Error("client too slow")), 200);
      });
      req.on("error", () => undefined);
      req.end();
      setTimeout(() => done("still open"), 5000);
    });
    assert.ok(["closed", "error"].includes(ended), `the response was cut, not finished (${ended})`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test("cli: openapi prints the document; import --from reads a WordPress file; export --with-files and import move the files too", async () => {
  const a = setup();
  const key = await a.cms.createKey(admin, { name: "cli", scopes: ["read", "write", "publish"] });
  const dir = mkdtempSync(join(tmpdir(), "cms-api-"));
  const lines: string[] = [];
  const io = (s: ReturnType<typeof setup>, k: string) => ({
    env: { AGENT_CMS_URL: "http://localhost/api/cms", AGENT_CMS_KEY: k },
    out: (l: string) => void lines.push(l),
    err: (l: string) => void lines.push(`ERR ${l}`),
    // The CMS, and the storage behind the addresses it hands out.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://localhost/api/cms")) {
        const res = await s.handler(new Request(url, init));
        if (res.status !== 302) return res;
        const to = res.headers.get("location")!;
        const found = s.store.objects.get(decodeURIComponent(new URL(to).pathname.replace(/^\//, "")));
        return found ? new Response(found.body as BodyInit) : new Response(null, { status: 404 });
      }
      if (init?.method === "PUT") {
        await s.store.send(url, init.body as Uint8Array);
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });

  assert.equal(await runCli(["openapi"], io(a, key.secret)), 0);
  const doc = JSON.parse(lines.join("\n")) as { openapi: string; paths: Record<string, unknown> };
  assert.deepEqual([doc.openapi, !!doc.paths["/collections/blog"]], ["3.1.0", true]);

  // WordPress: a dry run changes nothing; the real run makes drafts and publishes what was public.
  const wxr = join(dir, "wp.xml");
  writeFileSync(wxr, `<rss><channel><item><title>From WP</title><wp:post_name>from-wp</wp:post_name><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><content:encoded><![CDATA[<p>Hello <b>WP</b></p>]]></content:encoded></item><item><title>Draft</title><wp:post_name>wp-draft</wp:post_name><wp:post_type>post</wp:post_type><wp:status>draft</wp:status><content:encoded><![CDATA[<p>Later</p>]]></content:encoded></item></channel></rss>`);
  lines.length = 0;
  assert.equal(await runCli(["import", wxr, "--from", "wordpress"], io(a, key.secret)), 1, "no collection named");
  assert.match(lines.join("\n"), /--collection/);
  lines.length = 0;
  assert.equal(await runCli(["import", wxr, "--from", "wordpress", "--collection", "blog", "--dry-run"], io(a, key.secret)), 0);
  assert.match(lines.join("\n"), /blog\/from-wp\.md\s+new[\s\S]*would import 2 of 2/);
  assert.equal((await a.cms.counts(admin, "blog")).all, 0);
  assert.equal(await runCli(["import", wxr, "--from", "wordpress", "--collection", "blog", "--publish"], io(a, key.secret)), 0);
  const wp = await a.cms.get(admin, "blog", "from-wp");
  assert.deepEqual([wp.status, wp.body.trim(), (await a.cms.get(admin, "blog", "wp-draft", { draft: true })).status], ["published", "Hello **WP**", "draft"]);
  // A Notion export ("Markdown & CSV"): a deflated zip with pages, a subpage, a picture and a link between pages.
  {
    const n = setup();
    const keyN = await n.cms.createKey(admin, { name: "cli", scopes: ["read", "write", "publish"] });
    const { deflateRawSync } = await import("node:zlib");
    const { makeZip } = await import("./zip");
    const enc = new TextEncoder();
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(40).fill(7)]);
    const pages: [string, Uint8Array][] = [
      ["Launch notes 0123456789abcdef0123456789abcdef.md", enc.encode("# Launch notes\n\nStatus: Done\nTags: launch, notes\n\nWe shipped. See [the plan](Plan%20fedcba9876543210fedcba9876543210.md).\n\n![Team photo](Launch%20notes%200123456789abcdef0123456789abcdef/team.png)\n")],
      ["Launch notes 0123456789abcdef0123456789abcdef/team.png", pngBytes],
      ["Plan fedcba9876543210fedcba9876543210.md", enc.encode("# Plan\n\n- one\n- two\n")],
    ];
    // makeZip stores; rewrite as deflate by hand so the reader's inflate path runs.
    const stored = makeZip(pages.map(([name, data]) => ({ name, data })));
    const entries = (await import("./zip")).readZip(stored);
    assert.equal(entries.length, 3);
    const zipPath = join(dir, "notion.zip");
    writeFileSync(zipPath, deflatedZip(pages, deflateRawSync));
    lines.length = 0;
    assert.equal(await runCli(["import", zipPath, "--from", "notion", "--collection", "blog", "--publish"], io(n, keyN.secret)), 0, lines.join("\n"));
    assert.match(lines.join("\n"), /team\.png\s+uploaded as [a-z0-9]{12}/);
    const page = await n.cms.get(admin, "blog", "launch-notes");
    assert.equal(page.title, "Launch notes");
    assert.deepEqual(page.keywords, ["launch", "notes"]);
    assert.match(page.body, /See \[the plan\]\(\/plan\)\./);
    assert.match(page.body, /!\[Team photo\]\(asset:[a-z0-9]{12}\/team\.png\)/);
    assert.doesNotMatch(page.body, /ntn0/);
    assert.equal((await n.cms.get(admin, "blog", "plan")).body.trim(), "- one\n- two");
    // Again: nothing uploaded twice.
    lines.length = 0;
    assert.equal(await runCli(["import", zipPath, "--from", "notion", "--collection", "blog", "--on-conflict", "file-wins"], io(n, keyN.secret)), 0);
    assert.ok(!/uploaded as/.test(lines.join("\n")), lines.join("\n"));
  }

  // A document with a picture travels with its file to another CMS.
  const png = new Uint8Array(200);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]);
  const { asset, upload } = await a.cms.assets.requestUpload(admin, { name: "pic.png", size: png.length, folder: "blog", alt: "A picture" });
  if (upload.kind === "single") await a.store.send(upload.url, png);
  await a.cms.assets.completeUpload(admin, asset.id);
  await a.cms.create(admin, "blog", { slug: "with-pic", title: "With a picture", category: "News", body: `![A picture](asset:${asset.id}/pic.png)\n`, fields: { cover: `asset:${asset.id}` } }, { publish: true });
  const out = join(dir, "out");
  lines.length = 0;
  assert.equal(await runCli(["export", out, "--collection", "blog", "--with-files"], io(a, key.secret)), 0);
  assert.deepEqual(JSON.parse(lines.join("\n")), { documents: 2, files: 4, assets: 1, dir: out });
  assert.deepEqual(readdirSync(join(out, "_assets", asset.id)), ["pic.png"]);
  assert.equal(readFileSync(join(out, "_assets", asset.id, "pic.png")).length, 200);

  const b = setup();
  const keyB = await b.cms.createKey(admin, { name: "cli", scopes: ["read", "write", "publish"] });
  lines.length = 0;
  assert.equal(await runCli(["import", out, "--publish"], io(b, keyB.secret)), 0);
  assert.match(lines.join("\n"), new RegExp(`_assets/${asset.id}/pic\\.png\\s+uploaded as [a-z0-9]{12}`));
  const moved = await b.cms.get(admin, "blog", "with-pic");
  const newId = /asset:([a-z0-9]{12})\/pic\.png/.exec(moved.body)?.[1];
  assert.ok(newId && newId !== asset.id, "the document points at the new file");
  assert.equal(moved.fields.cover, `asset:${newId}`);
  const copy = await b.cms.assets.get(admin, newId!);
  assert.deepEqual([copy.name, copy.alt, copy.folder, copy.size], ["pic.png", "A picture", "blog", 200]);
  // Again: the file is there now, nothing is uploaded twice and nothing changes.
  lines.length = 0;
  mkdirSync(join(out, "blog"), { recursive: true });
  assert.equal(await runCli(["import", out], io(b, keyB.secret)), 0);
  assert.ok(!/uploaded as/.test(lines.join("\n")));
  assert.match(lines.join("\n"), /blog\/with-pic\.md\s+same/);
  assert.equal((await b.cms.assets.list(admin, {})).assets.length, 1, "the file is not uploaded twice");
  assert.ok(existsSync(join(out, "_assets", "manifest.json")));
});

/** A zip with deflated entries (what Notion and most tools write). */
function deflatedZip(files: [string, Uint8Array][], deflate: (b: Uint8Array) => Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let off = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, data] of files) {
    const n = enc.encode(name);
    const comp = deflate(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(8, 8, true);
    h.setUint32(14, crc(data), true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, 8, true);
    c.setUint32(16, crc(data), true); c.setUint32(20, comp.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), n, comp);
    dir.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + comp.length;
  }
  const dirLen = dir.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dirLen, true); e.setUint32(16, off, true);
  const all = [...parts, ...dir, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

test("cli: registry build writes the screens as a shadcn registry for another site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cms-reg-"));
  const lines: string[] = [];
  const code = await runCli(["registry", "build", "--base-url", "https://docs.example/r", "--out", "r"], { cwd: dir, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), registryDir: { dir: join(process.cwd(), "registry"), built: false } } as never);
  assert.equal(code, 0, lines.join("\n"));
  const shell = JSON.parse(readFileSync(join(dir, "r", "cms-shell.json"), "utf8")) as { registryDependencies?: string[]; files: { content?: string; target?: string }[] };
  assert.ok(shell.files.every((f) => f.content && f.target?.startsWith("@components/cms/")));
  assert.ok((shell.registryDependencies ?? []).some((d) => d.startsWith("https://docs.example/r/")));
  assert.ok(existsSync(join(dir, "r", "registry.json")));
  assert.equal(await runCli(["registry", "build"], { cwd: dir, out: () => {}, err: () => {} } as never), 1);
});
