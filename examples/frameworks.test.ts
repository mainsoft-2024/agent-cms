/** 27: the Hono and Express examples work as they are written (served over real HTTP). */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

async function exercise(base: string) {
  const me = await (await fetch(`${base}/api/cms/_me`)).json();
  assert.equal(me.actor.kind, "anonymous", "signed out");
  const made = await fetch(`${base}/api/cms/collections/posts`, {
    method: "POST",
    headers: { "x-demo-user": "1", "content-type": "application/json", origin: base },
    body: JSON.stringify({ doc: { slug: "hello", title: "Hello <frameworks>", body: "**hi**" }, publish: true }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  const page = await fetch(`${base}/posts/hello`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Hello &#60;frameworks&#62;<\/h1>/);
  const api = await (await fetch(`${base}/api/cms/collections/posts/hello`)).json();
  assert.equal(api.doc.title, "Hello <frameworks>");
  assert.equal((await fetch(`${base}/posts/nope`)).status, 404);
}

test("example: Hono", async () => {
  const { serve } = await import("@hono/node-server");
  const { createApp } = await import("./hono/app");
  const { app } = createApp();
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  try {
    await exercise(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
});

test("example: Express", async () => {
  const { createApp } = await import("./express/app");
  const { app } = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await exercise(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
});
