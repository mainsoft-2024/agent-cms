/** 0.10.2: a signed-in person's writes behind a proxy, where `req.url` is the address the server listens on. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler, sameSite } from "./http";
import { MemoryRepo } from "./repo";
import type { Actor } from "./types";

const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
let n = 0;
const req = (headers: Record<string, string>, url = "http://localhost:3000/api/cms/collections/guide") => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ doc: { slug: `a${++n}`, title: "A", body: "text" } }) });

test("same site: the address people open is read from Host and X-Forwarded-Host, not only from req.url", () => {
  // Straight to the server.
  assert.equal(sameSite(req({ origin: "http://localhost:3000" })), true);
  // `next start` opened as 127.0.0.1: req.url says localhost, Host says what the browser used.
  assert.equal(sameSite(req({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" })), true);
  // A proxy that passes the public name in X-Forwarded-Host (a list keeps the first entry).
  assert.equal(sameSite(req({ origin: "https://cms.example.com", host: "10.0.0.7:3000", "x-forwarded-host": "cms.example.com, 10.0.0.7:3000", "sec-fetch-site": "same-origin" })), true);
  // A proxy that rewrites Host to the public name.
  assert.equal(sameSite(req({ origin: "https://cms.example.com", host: "CMS.example.com" })), true);
  // No Origin (curl, a server): nothing rides along by itself.
  assert.equal(sameSite(req({})), true);

  // Another site, with and without the browser's own verdict.
  assert.equal(sameSite(req({ origin: "https://evil.example", host: "cms.example.com" })), false);
  assert.equal(sameSite(req({ origin: "https://cms.example.com", host: "cms.example.com", "sec-fetch-site": "cross-site" })), false);
  // A sibling name is another site unless the app lists it.
  assert.equal(sameSite(req({ origin: "https://admin.example.com", host: "cms.example.com", "sec-fetch-site": "same-site" })), false);
  assert.equal(sameSite(req({ origin: "https://admin.example.com", host: "cms.example.com", "sec-fetch-site": "cross-site" }), ["https://admin.example.com"]), true);
  assert.equal(sameSite(req({ origin: "https://admin.example.com", host: "cms.example.com" }), ["admin.example.com"]), true);
  // A sandboxed frame says "null".
  assert.equal(sameSite(req({ origin: "null", host: "cms.example.com" })), false);
  // The port is part of the address.
  assert.equal(sameSite(req({ origin: "http://localhost:4000", host: "localhost:3000" })), false);
});

test("rest: a write through a proxy is accepted, one from another site is refused, a listed origin is let in", async () => {
  const make = (trustedOrigins?: string[]) => createCmsHandler({ cms: createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public" })] }), resolveUser: async () => admin, trustedOrigins });
  const proxied = { origin: "https://3000-preview.example.app", host: "3000-preview.example.app", "x-forwarded-host": "3000-preview.example.app", "sec-fetch-site": "same-origin" };
  assert.equal((await make()(req(proxied))).status, 201);
  const cross = await make()(req({ origin: "https://evil.example", host: "3000-preview.example.app", "sec-fetch-site": "cross-site" }));
  assert.deepEqual([cross.status, ((await cross.json()) as { error: string }).error], [403, "cross_site"]);
  assert.equal((await make(["https://studio.example.com"])(req({ origin: "https://studio.example.com", host: "cms.example.com", "sec-fetch-site": "cross-site" }))).status, 201);
});
