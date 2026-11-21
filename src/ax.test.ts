/** 0.15.0: documents as files for agents, HTML blocks and documents, the html permission, suggestions, publish checks. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createCms, defineCollection } from "./cms";
import { isCmsError } from "./errors";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
import { callTool } from "./tools";
import { applyEdits, docFile, fileToInput, mergeFiles, numberLines, outline } from "./doc-files";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const editor: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Lee", isAdmin: false };
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCmsError(e) ? e.code : Promise.reject(e)));

function setup() {
  const clock = { t: Date.parse("2026-11-21T00:00:10Z") };
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    fields: z.object({ cover: z.string().optional(), level: z.enum(["basic", "advanced"]).optional() }),
    publishChecks: [(doc) => (doc.summary ? [] : [{ code: "summary", message: "Write a summary", severity: "error" as const, path: "summary" }])],
  });
  const pages = defineCollection({ slug: "pages", label: "Pages", visibility: "public", body: { formats: ["markdown", "html"] }, html: { render: "isolated" } });
  const notes = defineCollection({ slug: "notes", label: "Notes", visibility: "public", agentEdits: "suggest" });
  const repo = new MemoryRepo();
  const cms = createCms({
    repo,
    collections: [guide, pages, notes],
    now: () => new Date(clock.t),
    warn: () => {},
  });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const call = (path: string, init: RequestInit = {}) => handler(new Request(`http://app.test/api/cms${path}`, { ...init, headers: { ...(typeof init.body === "string" && init.body.startsWith("{") ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) } }));
  return { cms, repo, clock, call };
}

test("doc files: a document as one file and back", () => {
  const text = docFile({ slug: "a", title: "A", summary: "S", body: "## One\n\nText", category: null, keywords: ["k"], fields: { cover: "asset:abcdefabcdef/x.png" } });
  assert.ok(text.startsWith("---\nslug: a\ntitle: A\n"));
  assert.ok(text.includes('cover: "asset:abcdefabcdef/x.png"'));
  const back = fileToInput(text.replace('cover: "asset:abcdefabcdef/x.png"\n', ""), { cover: "x", level: "basic" });
  assert.deepEqual(back.fields, { cover: null, level: null }, "removed lines remove fields");
  assert.equal(back.body, "## One\n\nText");
  assert.equal(fileToInput("---\nslug: p\ntitle: P\nformat: html\n---\n<h1>x</h1>").format, "html");
  assert.throws(() => fileToInput("no frontmatter"), /frontmatter/);
  const n = numberLines("a\nb\nc\nd", 2, 2);
  assert.deepEqual([n.content, n.total], ["2→b\n3→c", 4]);
  assert.deepEqual(outline(text).map((o) => o.kind).slice(0, 3), ["field", "field", "field"]);
});

test("doc files: edits are exact, unique, in order and all or none", () => {
  const t = "one\ntwo\nthree\ntwo";
  const ok = applyEdits(t, [{ oldString: "one", newString: "1" }, { oldString: "three", newString: "3\n3b" }]);
  assert.ok("text" in ok);
  assert.equal(ok.text, "1\ntwo\n3\n3b\ntwo");
  assert.deepEqual(ok.changed, [{ from: 1, to: 1 }, { from: 3, to: 4 }]);
  const dup = applyEdits(t, [{ oldString: "two", newString: "2" }]);
  assert.deepEqual(dup, { code: "edit_not_unique", index: 0, count: 2, lines: [2, 4] });
  const all = applyEdits(t, [{ oldString: "two", newString: "2", replaceAll: true }]);
  assert.ok("text" in all && all.text === "one\n2\nthree\n2");
  const missing = applyEdits("The “new” dashboard", [{ oldString: 'The "new" dashboard', newString: "x" }]);
  assert.ok(!("text" in missing) && missing.code === "edit_not_found" && missing.hint === "quotes or dashes differ" && missing.similar[0].line === 1);
  const second = applyEdits(t, [{ oldString: "one", newString: "1" }, { oldString: "zzz", newString: "y" }]);
  assert.equal("code" in second && second.code, "edit_not_found");
  const merged = mergeFiles("a\nb\nc\nd\ne", "a\nB\nc\nd\ne", "a\nb\nc\nd\nE");
  assert.deepEqual([merged.text, merged.conflicts], ["a\nB\nc\nd\nE", 0]);
  const clash = mergeFiles("a\nb\nc", "a\nX\nc", "a\nY\nc");
  assert.equal(clash.conflicts, 1);
  assert.ok(clash.text.includes("<<<<<<< yours\nX\n=======\nY\n>>>>>>> cms"));
});

test("ax: read, grep, edit and write through tools, REST and a file link", async () => {
  const { cms, call } = setup();
  await cms.create(admin, "guide", { slug: "start", title: "Start", summary: "Hi", body: "## Install\n\nRun the command.\n\n## Use\n\nOpen the admin.", fields: { level: "basic" } });
  await cms.create(admin, "guide", { slug: "deploy", title: "Deploy", summary: "Go", body: "Run the build." });
  const read = (await callTool(cms, admin, "read_document", { collection: "guide", slug: "start" })) as { content: string; version: number; totalLines: number };
  assert.ok(read.content.includes("→## Install"));
  assert.equal(read.version, 1);
  const outl = (await callTool(cms, admin, "read_document", { collection: "guide", slug: "start", outline: true })) as { outline: { kind: string; text: string }[] };
  assert.deepEqual(outl.outline.filter((o) => o.kind === "h2").map((o) => o.text), ["Install", "Use"]);

  const grep = (await callTool(cms, admin, "grep_documents", { pattern: "Run the" })) as { matches: { path: string; line: number }[]; count: number };
  assert.deepEqual(grep.matches.map((m) => m.path), ["guide/deploy.md", "guide/start.md"]);
  const files = (await callTool(cms, admin, "grep_documents", { pattern: "^level: basic$", regex: true, output: "files" })) as { files: { path: string }[] };
  assert.deepEqual(files.files.map((f) => f.path), ["guide/start.md"]);
  assert.equal(((await callTool(cms, admin, "grep_documents", { pattern: "(", regex: true })) as { error: string }).error, "pattern_invalid");

  // One edit changes body text and a field together, as one version.
  const edited = (await callTool(cms, admin, "edit_document", {
    collection: "guide",
    slug: "start",
    expectedVersion: 1,
    edits: [
      { oldString: "Run the command.", newString: "Run `npx @mainsoft/agent-cms init`." },
      { oldString: "level: basic", newString: "level: advanced" },
    ],
  })) as { version: number; snippet: string; saved: boolean };
  assert.equal(edited.version, 2);
  assert.ok(edited.saved && edited.snippet.includes("npx @mainsoft/agent-cms init"));
  const doc = await cms.get(admin, "guide", "start", { draft: true });
  assert.equal(doc.fields.level, "advanced");
  const bad = (await callTool(cms, admin, "edit_document", { collection: "guide", slug: "start", edits: [{ oldString: "level: advanced", newString: "level: expert" }] })) as { error: string; params: { line: number } };
  assert.equal(bad.error, "file_invalid");
  assert.equal(bad.params.line, 5, "the line of the bad field");
  const stale = (await callTool(cms, admin, "edit_document", { collection: "guide", slug: "start", expectedVersion: 1, edits: [{ oldString: "Use", newString: "Using" }] })) as { error: string };
  assert.equal(stale.error, "conflict_version");
  const nf = (await callTool(cms, admin, "edit_document", { collection: "guide", slug: "start", edits: [{ oldString: "Open the admin panel.", newString: "x" }] })) as { error: string; message: string };
  assert.equal(nf.error, "edit_not_found");
  assert.ok(nf.message.includes("Open the admin."), nf.message);

  // write_document: replacing needs the version; a new slug creates.
  assert.equal(((await callTool(cms, admin, "write_document", { collection: "guide", slug: "start", content: "---\nslug: start\ntitle: S\n---\nx" })) as { error: string }).error, "edit_invalid");
  const made = (await callTool(cms, admin, "write_document", { collection: "guide", slug: "faq", content: "---\nslug: faq\ntitle: FAQ\nsummary: Q\n---\n## Q\n\nA" })) as { version: number; path: string };
  assert.deepEqual([made.version, made.path], [1, "guide/faq.md"]);

  // REST: file, edit, and a link that downloads and uploads.
  const file = await call("/collections/guide/faq/file");
  assert.equal(file.headers.get("etag"), '"1"');
  const text = await file.text();
  const put = await call("/collections/guide/faq/file", { method: "PUT", body: text.replace("A", "Answer"), headers: { "if-match": '"1"' } });
  assert.equal(((await put.json()) as { version: number }).version, 2);
  const link = (await (await call("/collections/guide/faq/file-link", { method: "POST", body: JSON.stringify({ method: "PUT" }) })).json()) as { url: string; version: number };
  assert.ok(link.url.startsWith("/raw/"));
  const up = await call(link.url, { method: "PUT", body: text.replace("A", "Final answer") });
  assert.equal(((await up.json()) as { version: number }).version, 3);
  assert.equal((await call(link.url, { method: "PUT", body: text })).status, 401, "a PUT link sends one file");
  const getLink = (await (await call("/collections/guide/faq/file-link", { method: "POST" })).json()) as { url: string };
  const dl = await call(getLink.url);
  assert.ok((await dl.text()).includes("Final answer"));
  assert.ok(dl.headers.get("content-disposition")?.includes("faq.md"));
  const grepRest = (await (await call("/grep", { method: "POST", body: JSON.stringify({ pattern: "Final", output: "count" }) })).json()) as { count: number };
  assert.equal(grepRest.count, 1);
});

test("html: stored as written; adding it needs the html permission; inert parts are warnings with lines", async () => {
  const { cms } = setup();
  const role = await cms.roles.create(admin, { name: "Editor", permissions: { guide: { write: true, publish: true } } });
  await cms.roles.addMember(admin, role.id, { id: "u2", label: "Lee" });
  const html = ':::html\n<button onclick="go()">Go</button>\n<script>track()</script>\n:::';
  assert.equal(await code(cms.create(editor, "guide", { slug: "h", title: "H", summary: "s", body: `Intro\n\n${html}` })), "forbidden_html");
  const doc = await cms.create(admin, "guide", { slug: "h", title: "H", summary: "s", body: `Intro\n\n${html}` });
  assert.ok(doc.body.includes("<script>track()</script>"), "never stripped");
  // An editor may change the text around the HTML, or remove it, but not change it.
  const ok = await cms.update(editor, "guide", "h", { body: `Intro, longer\n\n${html}` });
  assert.equal(ok.version, 2);
  assert.equal(await code(cms.update(editor, "guide", "h", { body: html.replace("Go", "Run") })), "forbidden_html");
  const diags = await cms.diagnose(admin, "guide", { body: `Intro\n\n${html}` }, { slug: "h" });
  const inert = diags.filter((d) => d.code === "html_inert").map((d) => [d.params?.line, d.params?.kind]);
  assert.deepEqual(inert, [[4, "tag"], [4, "event"], [5, "script"]]);
  // Keys need the "html" scope.
  const plain = (await cms.authenticateKey((await cms.createKey(admin, { name: "w", scopes: ["read", "write"] })).secret))!;
  const withHtml = (await cms.authenticateKey((await cms.createKey(admin, { name: "h", scopes: ["read", "write", "html"] })).secret))!;
  assert.equal(await code(cms.create(plain, "guide", { slug: "k1", title: "K", body: ":::html\n<b>x</b>\n:::" })), "forbidden_html");
  assert.equal(await code(cms.create(withHtml, "guide", { slug: "k1", title: "K", body: ":::html\n<b>x</b>\n:::" })), "ok");
  // HTML documents only where the collection allows them; isolated drawing needs html_scripts.
  assert.ok((await cms.diagnose(admin, "guide", { title: "x", format: "html", body: "<p>x</p>" })).some((d) => d.code === "format_not_allowed"));
  const page = await cms.create(admin, "pages", { slug: "landing", title: "Landing", format: "html", body: "<main><h1>Hi</h1><script>x()</script></main>" });
  assert.equal(page.format, "html");
  assert.equal(await code(cms.create(withHtml, "pages", { slug: "l2", title: "L", format: "html", body: "<script>x()</script>" })), "forbidden_html_scripts");
  assert.equal(await code(cms.create(withHtml, "pages", { slug: "l3", title: "L", format: "html", body: "<p>plain</p>" })), "ok");
  const f = await cms.ax.file(admin, "pages", "landing");
  assert.ok(f.text.includes("format: html") && f.path === "pages/landing.html");
});

test("suggestions: agents' edits wait for a person in collections that ask for it", async () => {
  const { cms, call } = setup();
  await cms.create(admin, "notes", { slug: "n", title: "N", body: "Hello world.\n\nSecond." });
  const bot = (await cms.authenticateKey((await cms.createKey(admin, { name: "bot", scopes: ["read", "write"] })).secret))!;
  const r = (await callTool(cms, bot, "edit_document", { collection: "notes", slug: "n", edits: [{ oldString: "Hello world.", newString: "Hello, world!" }] })) as { saved: boolean; version: number; suggestion: { id: string } };
  assert.deepEqual([r.saved, r.version], [false, 1]);
  assert.equal((await cms.get(admin, "notes", "n", { draft: true })).body, "Hello world.\n\nSecond.");
  const list = (await (await call("/collections/notes/n/suggestions")).json()) as { suggestions: { id: string; by: { label: string } }[] };
  assert.equal(list.suggestions.length, 1);
  assert.equal(list.suggestions[0].by.label, "bot");
  // A person's own edits save right away.
  await cms.update(admin, "notes", "n", { body: "Hello world.\n\nSecond, edited." });
  const applied = (await (await call(`/collections/notes/n/suggestions/${r.suggestion.id}/apply`, { method: "POST" })).json()) as { version: number };
  assert.equal(applied.version, 3);
  assert.equal((await cms.get(admin, "notes", "n", { draft: true })).body, "Hello, world!\n\nSecond, edited.");
  assert.equal((await cms.ax.suggestions(admin, "notes", "n")).length, 0);
  // A suggestion whose text changed since cannot apply.
  const s2 = (await callTool(cms, bot, "edit_document", { collection: "notes", slug: "n", edits: [{ oldString: "Second, edited.", newString: "Two." }] })) as { suggestion: { id: string } };
  await cms.update(admin, "notes", "n", { body: "Hello, world!\n\nRewritten." });
  assert.equal(await code(cms.ax.applySuggestion(admin, "notes", "n", s2.suggestion.id)), "suggestion_stale");
  await cms.ax.rejectSuggestion(admin, "notes", "n", s2.suggestion.id);
  assert.equal(await code(cms.ax.rejectSuggestion(admin, "notes", "n", s2.suggestion.id)), "suggestion_not_found");
});

test("publish checks: the collection's own checks stop publishing and show before it", async () => {
  const { cms, call } = setup();
  await cms.create(admin, "guide", { slug: "p", title: "P", body: "x" });
  const checks = (await (await call("/collections/guide/p/checks", { method: "POST" })).json()) as { checks: { code: string }[]; blocking: boolean };
  assert.deepEqual([checks.checks.map((c) => c.code), checks.blocking], [["summary"], true]);
  assert.equal(await code(cms.publish(admin, "guide", "p")), "publish_check_failed");
  await cms.update(admin, "guide", "p", { summary: "Now there is one" });
  assert.equal((await cms.publish(admin, "guide", "p")).status, "published");
});

test("cli: pull, edit with any editor, push; an edit made in the CMS meanwhile is merged or marked", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runCli } = await import("./cli");
  const { cms } = setup();
  const key = await cms.createKey(admin, { name: "cli", scopes: ["read", "write"] });
  const handler = createCmsHandler({ cms, resolveUser: async () => null });
  const dir = mkdtempSync(join(tmpdir(), "cms-pull-"));
  const lines: string[] = [];
  const io = {
    env: { AGENT_CMS_URL: "http://localhost/api/cms", AGENT_CMS_KEY: key.secret },
    cwd: dir,
    out: (l: string) => void lines.push(l),
    err: (l: string) => void lines.push(`ERR ${l}`),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch,
  };
  await cms.create(admin, "guide", { slug: "start", title: "Start", summary: "Hi", body: "One.\n\nTwo.\n\nThree.\n\nFour." });
  assert.equal(await runCli(["pull", "guide", "start"], io), 0);
  const file = join(dir, "guide/start.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("One.", "One, edited here."));
  // Someone edits another part in the CMS.
  await cms.update(admin, "guide", "start", { body: "One.\n\nTwo.\n\nThree.\n\nFour, edited in the CMS." });
  assert.equal(await runCli(["status"], io), 0);
  assert.ok(lines.some((l) => l.includes("changed here") && l.includes("changed in the CMS")), lines.join("\n"));
  assert.equal(await runCli(["push"], io), 0, lines.join("\n"));
  assert.equal((await cms.get(admin, "guide", "start", { draft: true })).body, "One, edited here.\n\nTwo.\n\nThree.\n\nFour, edited in the CMS.");
  // Both change the same line: a conflict file, nothing saved.
  writeFileSync(file, readFileSync(file, "utf8").replace("Two.", "Two (mine)."));
  await cms.update(admin, "guide", "start", { body: "One, edited here.\n\nTwo (theirs).\n\nThree.\n\nFour, edited in the CMS." });
  const before = (await cms.get(admin, "guide", "start", { draft: true })).version;
  assert.equal(await runCli(["push"], io), 1);
  assert.equal((await cms.get(admin, "guide", "start", { draft: true })).version, before);
  assert.ok(readFileSync(file, "utf8").includes("<<<<<<< yours\nTwo (mine).\n=======\nTwo (theirs).\n>>>>>>> cms"));
  assert.equal(await runCli(["push"], io), 1, "markers left: refused");
  writeFileSync(file, readFileSync(file, "utf8").replace(/<<<<<<< yours\n.*\n=======\n.*\n>>>>>>> cms/, "Two (agreed)."));
  assert.equal(await runCli(["push"], io), 0, lines.join("\n"));
  assert.ok((await cms.get(admin, "guide", "start", { draft: true })).body.includes("Two (agreed)."));
  // grep and read from the command line.
  lines.length = 0;
  assert.equal(await runCli(["grep", "agreed"], io), 0);
  assert.deepEqual(lines, ["guide/start.md:9:Two (agreed)."]);
});
