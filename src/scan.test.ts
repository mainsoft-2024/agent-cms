/** 0.9.0: `media.scan`, the app's own check of every file that arrives. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCms, defineCollection } from "./cms";
import type { ScanFile } from "./assets";
import { MemoryRepo } from "./repo";
import { MemoryStorage } from "./storage";
import { isCmsError, type Actor } from "./types";

const admin: Actor = { kind: "user", id: "u1", label: "Kim", isAdmin: true };
const pdf = (mark: string) => new TextEncoder().encode(`%PDF-1.7\n${mark}`);

test("scan: a refused file is deleted and never becomes usable; an accepted one goes through", async () => {
  const pub = new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" });
  const repo = new MemoryRepo();
  const seen: ScanFile[] = [];
  const cms = createCms({
    repo,
    collections: [defineCollection({ slug: "guide", label: "Guide", visibility: "public" })],
    media: {
      stores: { public: { visibility: "public", adapter: pub } },
      resolveHost: async () => ["93.184.216.34"],
      fetch: (async () => new Response(pdf("EICAR") as BodyInit, { headers: { "content-type": "application/pdf" } })) as typeof fetch,
      scan: async (f) => {
        seen.push(f);
        if (f.name.startsWith("boom")) throw new Error("scanner is down");
        // A scanner reads the file through `url`, or from `bytes` when the CMS holds them.
        const body = f.bytes ?? pub.objects.get(f.key)?.body ?? new Uint8Array();
        return new TextDecoder().decode(body).includes("EICAR") ? { ok: false, reason: "EICAR test signature" } : true;
      },
    },
  });
  const rejected = (reason: string) => (e: unknown) => isCmsError(e) && e.code === "asset_rejected" && e.status === 422 && e.params.reason === reason && cms.message(e) === "This file did not pass the check";
  const upload = async (name: string, bytes: Uint8Array) => {
    const { asset, upload: how } = await cms.assets.requestUpload(admin, { name, size: bytes.length });
    if (how.kind === "single") await pub.send(how.url, bytes);
    return cms.assets.completeUpload(admin, asset.id);
  };

  // An upload from a browser: checked when it completes, through a signed address.
  const ok = await upload("clean.pdf", pdf("fine"));
  assert.equal(ok.status, "ready");
  assert.deepEqual([seen[0].name, seen[0].size, seen[0].mime, seen[0].bytes, seen[0].url], ["clean.pdf", 13, "application/pdf", undefined, "memory://public/clean.pdf?expires=600"]);
  await assert.rejects(upload("bad.pdf", pdf("EICAR")), rejected("EICAR test signature"));
  assert.deepEqual([...pub.objects.keys()], ["clean.pdf"], "the refused file is gone from the storage");
  assert.deepEqual((await cms.assets.list(admin, {})).assets.map((a) => a.name), ["clean.pdf"]);
  assert.deepEqual(repo.audit.filter((a) => a.outcome === "denied").map((a) => [a.action, (a.detail as { reason: string }).reason]), [["asset.upload", "EICAR test signature"]]);

  // Files the server stores itself (an import by URL): checked before anything is written.
  await assert.rejects(cms.assets.import(admin, { url: "https://example.com/report.pdf" }), rejected("EICAR test signature"));
  assert.ok(seen.at(-1)?.bytes && seen.at(-1)?.url === null);
  assert.equal(pub.objects.size, 1);

  // A scanner that fails refuses the file: better no file than an unchecked one.
  await assert.rejects(upload("boom.pdf", pdf("fine")), rejected("scanner is down"));
  assert.equal(pub.objects.size, 1);

  // A file that is already in the bucket is checked when it gets a row; refused, it stays where it is.
  await pub.put("inbox/old.pdf", pdf("EICAR"), { mime: "application/pdf" });
  await assert.rejects(cms.assets.register(admin, { store: "public", key: "inbox/old.pdf" }), rejected("EICAR test signature"));
  assert.ok(pub.objects.has("inbox/old.pdf"));
  assert.equal(await repo.findAssetByKey("public", "inbox/old.pdf"), null);
});
