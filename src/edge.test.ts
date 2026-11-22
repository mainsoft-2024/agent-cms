/**
 * 104: the CMS core and its REST handler run on an Edge runtime (no Node built-ins). The handler
 * with a memory repo is bundled for a neutral platform (a `node:` import fails the build) and run
 * inside `edge-runtime`, the same VM Vercel Edge uses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { EdgeRuntime } from "edge-runtime";
import { hex, hmacSha256, sha256, base64url, fromBase64url } from "./crypto";

const ENTRY = `
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { MemoryRepo } from "./repo";
const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public", url: (d) => "/guide/" + d.slug })], previewSecret: "p".repeat(32), warn: () => {} });
const handler = createCmsHandler({ cms, resolveUser: async (req) => req.headers.get("x-user") ? { kind: "user", id: "u1", label: "Kim", isAdmin: true } : null, trustedOrigins: ["https://edge.test"] });
globalThis.__run = async (url, init) => {
  const res = await handler(new Request(url, init));
  return { status: res.status, text: await res.text() };
};
globalThis.__cms = cms;
`;

test("edge: the core handler bundles without Node built-ins and serves requests in the Edge runtime", async () => {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: new URL(".", import.meta.url).pathname, loader: "ts" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /require\(["']node:/, "no Node built-in is required");
  const rt = new EdgeRuntime({ initialCode: code });
  const run = (url: string, init: RequestInit = {}) => rt.evaluate<Promise<{ status: number; text: string }>>(`__run(${JSON.stringify(url)}, ${JSON.stringify(init)})`);
  const created = await run("https://edge.test/api/cms/collections/guide", { method: "POST", headers: { "x-user": "1", origin: "https://edge.test", "content-type": "application/json" }, body: JSON.stringify({ doc: { slug: "hi", title: "Hi from the edge", body: "**x**" }, publish: true }) });
  assert.equal(created.status, 201, created.text);
  const read = await run("https://edge.test/api/cms/collections/guide/hi");
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(read.text).doc.title, "Hi from the edge");
  const list = await run("https://edge.test/api/cms/collections/guide?limit=1");
  assert.equal(JSON.parse(list.text).docs.length, 1);
  // Preview links are signed with HMAC (our SHA-256 here) and checked again.
  const link = await rt.evaluate<Promise<string>>(`__cms.createPreviewLink({ kind: "user", id: "u1", label: "Kim", isAdmin: true }, "guide", "hi").then((r) => r.token)`);
  const ok = await rt.evaluate<Promise<string>>(`__cms.readPreview(${JSON.stringify(link)}).then((d) => d.doc.title)`);
  assert.equal(ok, "Hi from the edge");
  const bad = await rt.evaluate<Promise<string>>(`__cms.readPreview(${JSON.stringify(link.slice(0, -3) + (link.endsWith("AAA") ? "BBB" : "AAA"))}).then(() => "accepted", (e) => e.code)`);
  assert.equal(bad, "preview_invalid");
  // An API key made on the edge hashes the same as on Node.
  const keyMade = await run("https://edge.test/api/cms/keys", { method: "POST", headers: { "x-user": "1", origin: "https://edge.test", "content-type": "application/json" }, body: JSON.stringify({ name: "bot", scopes: ["read"] }) });
  assert.equal(keyMade.status, 201, keyMade.text);
  const secret = JSON.parse(keyMade.text).secret as string;
  const viaKey = await run("https://edge.test/api/cms/collections/guide/hi", { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(viaKey.status, 200);
});

test("crypto: the plain JavaScript SHA-256 and HMAC agree with the standard test vectors", async () => {
  // Force the JavaScript path by loading the module where getBuiltinModule is missing.
  const out = await build({ entryPoints: [new URL("./crypto.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", globalName: "C", platform: "neutral", logLevel: "silent" });
  const rt = new EdgeRuntime({ initialCode: out.outputFiles[0].text });
  const js = (expr: string) => rt.evaluate<string>(expr);
  assert.equal(js(`C.hex(C.sha256(""))`), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(js(`C.hex(C.sha256("abc"))`), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(js(`C.hex(C.sha256("a".repeat(1000)))`), hex(sha256("a".repeat(1000))));
  assert.equal(js(`C.hex(C.sha256("한글 ✓"))`), hex(sha256("한글 ✓")));
  // RFC 4231 case 2.
  assert.equal(js(`C.hex(C.hmacSha256("Jefe", "what do ya want for nothing?"))`), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(js(`C.hex(C.hmacSha256("k".repeat(100), "long key"))`), hex(hmacSha256("k".repeat(100), "long key")));
  assert.equal(js(`C.timingSafeEqual("abc", "abc") && !C.timingSafeEqual("abc", "abd") && !C.timingSafeEqual("abc", "ab")`), true as unknown as string);
  for (const s of ["", "f", "fo", "foo", "한글", "\u0000\u00ff"]) {
    assert.equal(base64url(s), Buffer.from(s).toString("base64url"));
    assert.equal(Buffer.from(fromBase64url(base64url(s))).toString(), s);
  }
  assert.deepEqual([...fromBase64url("+/8=")], [...Buffer.from("+/8=", "base64")]);
  assert.throws(() => fromBase64url("a$b"));
});
