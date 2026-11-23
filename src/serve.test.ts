import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { devCms } from "./dev";
import { startServer } from "./serve";

test("serve: health, the admin page with its settings and a strict policy, the API, the setup code, and a clean stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "serve-"));
  const admin = join(cwd, "admin");
  mkdirSync(admin);
  writeFileSync(join(admin, "index.html"), `<!doctype html><html><head><title>Admin</title><link rel="stylesheet" href="./app-abcdefgh.css"><!--settings--><script>void 0</script></head><body><div id="root"></div><script type="module" src="./app-abcdefgh.js"></script></body></html>`);
  writeFileSync(join(admin, "app-abcdefgh.js"), "export {}");
  writeFileSync(join(admin, "app-abcdefgh.css"), "body{}");
  const lines: string[] = [];
  const { cms } = await devCms(cwd, (l) => lines.push(l), { memory: true });
  const s = await startServer({ cms, port: 0, host: "127.0.0.1", adminDir: admin, appName: "Acme <CMS>", cron: false, log: (l) => lines.push(l) });
  try {
    const health = await fetch(`${s.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);

    const page = await fetch(`${s.url}/admin/posts/hello`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, "the one inline script is allowed by its hash, nothing else");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(html, /<script type="application\/json" id="agent-cms-settings">\{"basePath":"\/api\/cms","adminPath":"\/admin","appName":"Acme \\u003cCMS>"/);
    assert.match(html, /<title>Acme CMS><\/title>/);
    assert.match(html, /src="\/admin\/app-abcdefgh\.js"/, "files are found from any admin address");

    const js = await fetch(`${s.url}/admin/app-abcdefgh.js`);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${s.url}/admin/..%2f..%2fpackage.json`)).status, 200, "an odd path is the app, never a file outside");
    assert.equal((await fetch(`${s.url}/admin/missing-file.js`)).status, 404);
    assert.equal((await fetch(`${s.url}/nothing`)).status, 404);
    assert.equal((await fetch(`${s.url}/`, { redirect: "manual" })).headers.get("location"), "/admin");

    const state = (await (await fetch(`${s.url}/api/cms/auth/state`)).json()) as { setup: boolean };
    assert.equal(state.setup, true, "nobody yet: the first admin is made with the setup code");
    for (let i = 0; i < 50 && !lines.some((l) => /setup code/.test(l)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.some((l) => /setup code [A-Z0-9-]+/.test(l)), "the setup code is printed");
    assert.ok([401, 403].includes((await fetch(`${s.url}/api/cms/keys`)).status), "admin parts of the API want a sign-in");
    assert.equal((await fetch(`${s.url}/api/cms/collections/posts`)).status, 200, "public documents stay public");
  } finally {
    await s.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`${s.url}/healthz`));
});

test("serve: the admin may connect to the storage it uploads to (connect-src lists the store's origin)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "serve-"));
  const admin = join(cwd, "admin");
  mkdirSync(admin);
  writeFileSync(join(admin, "index.html"), `<!doctype html><html><head><!--settings--></head><body></body></html>`);
  const { createCms } = await import("./cms");
  const { MemoryRepo } = await import("./repo");
  const { s3Storage } = await import("./storage-s3");
  const s3 = s3Storage({ bucket: "media", endpoint: "http://127.0.0.1:9100", region: "us-east-1", accessKeyId: "a", secretAccessKey: "b" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [], media: { stores: { public: { adapter: s3, visibility: "public" } } } });
  const s = await startServer({ cms, port: 0, host: "127.0.0.1", adminDir: admin, auth: false, cron: false, log: () => {} });
  try {
    const csp = (await fetch(`${s.url}/admin`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:9100(;|$)/);
  } finally {
    await s.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("serve: Vercel Blob names its origins; a custom store without origins is not widened to https: (warning, store or server opt-in)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "serve-"));
  const admin = join(cwd, "admin");
  mkdirSync(admin);
  writeFileSync(join(admin, "index.html"), `<!doctype html><html><head><!--settings--></head><body></body></html>`);
  const { createCms } = await import("./cms");
  const { MemoryRepo } = await import("./repo");
  const { MemoryStorage } = await import("./storage");
  const { vercelBlobStorage } = await import("./storage-vercel-blob");
  const blob = vercelBlobStorage({ token: "vercel_blob_rw_AbC123_secret", access: "public", blob: {} as never });
  assert.deepEqual(blob.browserOrigins, ["https://vercel.com", "https://abc123.public.blob.vercel-storage.com"]);
  // A custom adapter that says nothing about where browsers send files.
  const custom = Object.assign(Object.create(new MemoryStorage()), { browserOrigins: undefined });
  const csp = async (stores: Record<string, unknown>, more: { connectSrc?: string[] } = {}) => {
    const lines: string[] = [];
    const cms = createCms({ repo: new MemoryRepo(), collections: [], media: { stores: stores as never } });
    const s = await startServer({ cms, port: 0, host: "127.0.0.1", adminDir: admin, auth: false, cron: false, log: (l) => lines.push(l), ...more });
    try {
      return { csp: (await fetch(`${s.url}/admin`)).headers.get("content-security-policy") ?? "", lines };
    } finally {
      await s.stop();
    }
  };
  try {
    const v = await csp({ public: { adapter: blob, visibility: "public" } });
    assert.match(v.csp, /connect-src 'self' https:\/\/vercel\.com https:\/\/abc123\.public\.blob\.vercel-storage\.com(;|$)/);
    assert.ok(!v.lines.some((l) => /warning/.test(l)));
    const c = await csp({ public: { adapter: blob, visibility: "public" }, files: { adapter: custom, visibility: "private" } });
    assert.match(c.csp, /connect-src 'self' https:\/\/vercel\.com https:\/\/abc123\.public\.blob\.vercel-storage\.com(;|$)/, "the known origins stay, no blanket https:");
    assert.ok(!/connect-src[^;]* https:( |;|$)/.test(c.csp), c.csp);
    assert.ok(c.lines.some((l) => /warning: storage "files" does not say which origins/.test(l)), c.lines.join("\n"));
    // The store's own config names them.
    const named = await csp({ files: { adapter: custom, visibility: "private", browserOrigins: ["https://files.example.com"] } });
    assert.match(named.csp, /connect-src 'self' https:\/\/files\.example\.com(;|$)/);
    assert.ok(!named.lines.some((l) => /warning/.test(l)));
    // Or the server opts in explicitly, even to every https address.
    const wide = await csp({ files: { adapter: custom, visibility: "private" } }, { connectSrc: ["https:"] });
    assert.match(wide.csp, /connect-src 'self' https:(;|$)/);
    assert.ok(!wide.lines.some((l) => /warning/.test(l)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
