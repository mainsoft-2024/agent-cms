/**
 * The S3 adapter against a real S3-compatible server. Runs only when
 * S3_TEST_ENDPOINT is set (CI starts one; see .github/workflows/ci.yml):
 *
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_BUCKET=media \
 *   S3_TEST_KEY=test S3_TEST_SECRET=testsecret1 npx tsx --test src/storage-s3.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { s3CorsRule, s3Storage } from "./storage-s3";

const endpoint = process.env.S3_TEST_ENDPOINT;
const opts = { skip: endpoint ? false : "S3_TEST_ENDPOINT is not set" };
const make = (prefix?: string) =>
  s3Storage({ bucket: process.env.S3_TEST_BUCKET ?? "media", endpoint, region: process.env.S3_TEST_REGION ?? "us-east-1", accessKeyId: process.env.S3_TEST_KEY ?? "test", secretAccessKey: process.env.S3_TEST_SECRET ?? "testsecret1", publicUrl: "https://cdn.example.com", prefix });
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const run = `t${Date.now().toString(36)}`;

test("s3: put, head, read the start, signed GET, copy, delete, list", opts, async () => {
  const s = make();
  const key = `${run}/블로그 글/hero image.png`;
  await s.put(key, bytes(3000), { mime: "image/png" });
  const head = await s.head(key);
  assert.deepEqual([head?.size, head?.mime], [3000, "image/png"]);
  assert.equal(await s.head(`${run}/nope.png`), null);
  assert.equal((await s.readStart(key, 16))?.length, 16);
  assert.equal(await s.readStart(`${run}/nope.png`, 16), null);
  await s.put(`${run}/empty.txt`, new Uint8Array(), { mime: "text/plain" });
  assert.equal((await s.readStart(`${run}/empty.txt`, 16))?.length, 0);

  const got = await fetch(await s.presignGet(key, { expires: 60 }));
  assert.equal(got.status, 200);
  assert.equal((await got.arrayBuffer()).byteLength, 3000);
  const dl = await fetch(await s.presignGet(key, { expires: 60, download: "표지.png" }));
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
  await dl.arrayBuffer();
  // Without a signature the bucket says no (403 on AWS and most servers, 400 on Cloudflare R2).
  const bare = await fetch((await s.presignGet(key, { expires: 60 })).split("?")[0]);
  assert.ok(bare.status >= 400 && bare.status < 500, `unsigned read: ${bare.status}`);
  await bare.arrayBuffer();

  await s.copy(key, `${run}/moved/hero.png`);
  await s.delete(key);
  assert.equal(await s.head(key), null);
  assert.equal((await s.head(`${run}/moved/hero.png`))?.size, 3000);
  await s.delete(`${run}/never-there.png`); // deleting nothing is fine

  await s.put(`${run}/a.txt`, bytes(1), { mime: "text/plain" });
  const top = await s.list({ prefix: `${run}/`, delimiter: "/" });
  assert.deepEqual(top.objects.map((o) => o.key).sort(), [`${run}/a.txt`, `${run}/empty.txt`]);
  assert.deepEqual(top.prefixes, [`${run}/moved/`]);
  const page = await s.list({ prefix: `${run}/`, limit: 1 });
  assert.equal(page.objects.length, 1);
  assert.ok(page.cursor, "more pages");
  const rest = await s.list({ prefix: `${run}/`, limit: 10, cursor: page.cursor });
  assert.equal(rest.objects.length, 2);
  assert.equal(s.publicUrl("blog/새 글.png"), "https://cdn.example.com/blog/%EC%83%88%20%EA%B8%80.png");
});

test("s3: a browser PUTs with the signed URL; the stored type and download name are the signed ones", opts, async () => {
  const s = make();
  const key = `${run}/up/보고서 2026.zip`;
  const signed = await s.presignPut(key, { mime: "application/zip", disposition: `attachment; filename="report.zip"`, expires: 60 });
  const ok = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes(2048) });
  assert.equal(ok.status, 200, await ok.text());
  const head = await s.head(key);
  assert.deepEqual([head?.size, head?.mime], [2048, "application/zip"]);
  const got = await fetch(await s.presignGet(key, { expires: 60 }));
  assert.match(got.headers.get("content-disposition") ?? "", /report\.zip/);
  await got.arrayBuffer();
  // Another content type than the signed one is refused.
  const bad = await fetch(signed.url, { method: "PUT", headers: { ...signed.headers, "content-type": "text/html" }, body: bytes(10) });
  assert.equal(bad.status, 403);
  await bad.text();
});

test("s3: multipart: parts go up with signed URLs, the server lists them and completes", opts, async () => {
  const s = make("under-prefix");
  const key = `${run}/video.mp4`;
  const id = await s.createMultipart(key, { mime: "video/mp4" });
  const sizes = [5 * 1024 * 1024, 1234];
  // Out of order, like parallel uploads.
  for (const n of [2, 1]) {
    const res = await fetch(await s.presignPart(key, id, n, 60), { method: "PUT", body: bytes(sizes[n - 1], n) });
    assert.equal(res.status, 200, await res.text());
  }
  const parts = await s.listParts(key, id);
  assert.deepEqual(parts.map((p) => [p.partNumber, p.size]), [[1, sizes[0]], [2, sizes[1]]]);
  assert.ok(parts.every((p) => p.etag));
  await s.completeMultipart(key, id, parts);
  const head = await s.head(key);
  assert.deepEqual([head?.size, head?.mime], [sizes[0] + sizes[1], "video/mp4"]);
  // The prefix is invisible to callers and real in the bucket.
  assert.deepEqual((await s.list({ prefix: `${run}/` })).objects.map((o) => o.key), [key]);
  assert.equal((await make().head(`under-prefix/${key}`))?.size, sizes[0] + sizes[1]);
  const gone = await s.createMultipart(`${run}/abandoned.mp4`, { mime: "video/mp4" });
  await s.abortMultipart(`${run}/abandoned.mp4`, gone);
  await s.abortMultipart(`${run}/abandoned.mp4`, gone); // twice is fine
  await s.delete(key);
});

test("s3: the CORS rule names the origins and lets browsers PUT", () => {
  const [rule] = s3CorsRule(["https://app.example.com"]);
  assert.deepEqual(rule.AllowedOrigins, ["https://app.example.com"]);
  assert.ok(rule.AllowedMethods.includes("PUT"));
});
