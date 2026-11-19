import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRestClient } from "@mainsoft/agent-cms/client";
import { PART_SIZE } from "@mainsoft/agent-cms/storage";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { CmsMedia } from "../cms/cms-media";
import { ko } from "../cms/cms-messages";
import { CmsShell } from "../cms/cms-shell";
import { createUploader, fileSize, type UploadItem } from "../cms/cms-upload";
import { setMobile } from "./setup";
import { admin, axeViolations, BASE, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
});

test("upload: a large file goes up in parts, a failed part is retried, and retry sends only what is missing", async () => {
  const s = makeServer({ media: true });
  const client = createRestClient({ url: BASE, fetch: s.fetch });
  const sent: string[] = [];
  let broken = true;
  let last: UploadItem[] = [];
  const done: string[] = [];
  const up = createUploader({
    client,
    retries: 1,
    retryDelayMs: 1,
    describe: async () => ({ width: 1920, height: 1080, duration: 12.5, thumb: null }),
    onChange: (items) => (last = items),
    onDone: (a) => done.push(a.name),
    send: async (url, body, o) => {
      const part = /partNumber=(\d+)/.exec(url)?.[1] ?? "single";
      sent.push(part);
      if (broken && part === "2") throw new Error("network");
      const status = await s.stores.public.send(url, new Uint8Array(await body.arrayBuffer()));
      if (status !== 200) throw new Error(`HTTP ${status}`);
      o.onProgress(body.size);
    },
  });
  // The first bytes must look like an MP4 for the server's content check.
  const head = new Uint8Array(PART_SIZE * 2 + 1000);
  head.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const file = new File([head], "talk.mp4", { type: "video/mp4" });
  up.add([file], { folder: "talks" });
  await waitFor(() => assert.equal(last[0]?.state, "failed"), { timeout: 8000 });
  assert.equal(last[0].error, null, "a dropped connection has no server message");
  assert.equal(sent.filter((p) => p === "2").length, 2, "part 2 was tried again automatically");
  assert.equal(last[0].sent, PART_SIZE + 1000, "the parts that arrived are counted");
  broken = false;
  sent.length = 0;
  up.retry(last[0].key);
  await waitFor(() => assert.equal(last[0]?.state, "done"), { timeout: 8000 });
  assert.deepEqual(sent, ["2"], "only the missing part is sent again");
  assert.deepEqual([last[0].asset?.status, last[0].asset?.duration, last[0].asset?.width, done], ["ready", 12.5, 1920, ["talk.mp4"]]);
  assert.equal(s.stores.public.objects.get("talks/talk.mp4")?.body.length, file.size);
  // A refusal from the CMS keeps its message, and there is nothing to retry.
  up.add([new File(["<html>"], "page.html", { type: "text/html" })]);
  await waitFor(() => assert.equal(last[1]?.state, "failed"));
  assert.equal(last[1].error, "This file type is not allowed");
  up.clear();
  assert.deepEqual(last.map((i) => i.name), ["page.html"]);
  assert.deepEqual([fileSize(532 * 1024 ** 2), fileSize(1.4 * 1024 ** 3), fileSize(58 * 1024), fileSize(900)], ["532MB", "1.4GB", "58KB", "900B"]);
});

test("media: folders, tiles, a file's details, alt text, tags, the extension slot and delete with its uses", async () => {
  const s = makeServer({ media: true });
  const hero = await s.addFile("launch-hero.png", { folder: "blog", alt: "Old alt", tags: ["launch"] });
  await s.addFile("logo.png", { folder: "brand" });
  await s.addFile("contract.png", { store: "private", folder: "contracts" });
  await s.cms.create(admin, "guide", { slug: "hello", title: "Hello, world", body: `![](asset:${hero.id}/launch-hero.png)` }, { publish: true });
  const user = userEvent.setup();
  renderWith(s, <CmsMedia />, { messages: ko, slots: { assetAlt: (a, { setAlt }) => <button onClick={() => setAlt(`${a.name} 설명`)}>확장 버튼</button> } });
  const folders = await screen.findByRole("navigation", { name: "폴더" });
  await within(folders).findByText("blog");
  assert.deepEqual(within(folders).getAllByRole("heading").map((h) => h.textContent), ["공개", "비공개"]);
  assert.deepEqual(within(folders).getAllByRole("button").map((b) => b.textContent), ["전체2", "blog1", "brand1", "전체1", "contracts1"]);
  await screen.findByRole("button", { name: "launch-hero.png" });
  assert.deepEqual(within(screen.getByRole("radiogroup", { name: "종류" })).getAllByRole("radio").map((r) => r.textContent), ["전체 2", "이미지 2", "영상 0", "문서 0"]);
  assert.equal(screen.getAllByText("1200×630, 200B").length, 2);
  assert.ok(screen.getByText("2개 중 2개"));
  assert.deepEqual(await axeViolations(), []);

  await user.click(within(folders).getByRole("button", { name: /contracts/ }));
  await screen.findByRole("button", { name: "contract.png, 비공개" });
  await user.click(within(folders).getByRole("button", { name: /blog/ }));
  await user.click(await screen.findByRole("button", { name: "launch-hero.png" }));
  const panel = await screen.findByRole("complementary", { name: "launch-hero.png" });
  assert.ok(within(panel).getByText("공개 / blog"));
  assert.ok(within(panel).getByText("PNG 이미지"));
  assert.ok(within(panel).getByText("200B, 1200×630"));
  const usedIn = within(panel).getByRole("link", { name: "Hello, world" });
  assert.equal(usedIn.getAttribute("href"), "/admin/guide/hello");
  assert.ok(within(panel).getByText("게시됨"));
  assert.deepEqual(await axeViolations(), []);

  // Alt text saves when the field is left; the slot fills the field without saving.
  const alt = within(panel).getByLabelText("대체 텍스트") as HTMLTextAreaElement;
  assert.equal(alt.value, "Old alt");
  await user.click(within(panel).getByRole("button", { name: "확장 버튼" }));
  assert.equal(alt.value, "launch-hero.png 설명");
  assert.equal((await s.cms.assets.get(admin, hero.id)).alt, "Old alt");
  fireEvent.blur(alt);
  await waitFor(async () => assert.equal((await s.cms.assets.get(admin, hero.id)).alt, "launch-hero.png 설명"));
  await user.type(within(panel).getByLabelText("태그 추가"), "hero{Enter}");
  await waitFor(async () => assert.deepEqual((await s.cms.assets.get(admin, hero.id)).tags, ["launch", "hero"]));
  await user.click(await within(panel).findByRole("button", { name: "launch 제거" }));
  await waitFor(async () => assert.deepEqual((await s.cms.assets.get(admin, hero.id)).tags, ["hero"]));

  // Deleting a file in use shows the documents first.
  await user.click(within(panel).getByRole("button", { name: "삭제" }));
  const dialog = await screen.findByRole("dialog", { name: "파일 1개를 삭제할까요?" });
  assert.ok(within(dialog).getByText("삭제한 파일은 되살릴 수 없어요."));
  assert.ok(within(dialog).getByText("이 파일을 쓰는 문서 1개"));
  assert.ok(within(dialog).getByRole("link", { name: "Hello, world" }));
  await user.click(within(dialog).getByRole("button", { name: "삭제" }));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "launch-hero.png" }), null));
  await assert.rejects(s.cms.assets.get(admin, hero.id));
  assert.equal(await screen.findByText("파일이 없어요."), screen.getByText("파일이 없어요."));

  // A new folder becomes the place uploads go.
  await user.click(screen.getByRole("button", { name: "새 폴더" }));
  await user.type(await screen.findByLabelText("이름"), "2026");
  await user.click(screen.getByRole("button", { name: "만들기" }));
  await within(folders).findByText("2026");
  assert.deepEqual((await s.cms.assets.folders(admin))[0].folders.map((f) => f.path), ["blog", "blog/2026", "brand"]);
});

test("media: the list view, and the menu item only when the app has a library", async () => {
  const s = makeServer({ media: true });
  await s.addFile("logo.png", { folder: "brand" });
  const user = userEvent.setup();
  const { unmount } = renderWith(s, <CmsShell title="App"><CmsMedia /></CmsShell>);
  assert.equal((await screen.findByRole("link", { name: "Media" })).getAttribute("href"), "/admin/media");
  await user.click(await screen.findByRole("radio", { name: "List" }));
  const row = (await screen.findByRole("button", { name: "logo.png" })).closest("tr")!;
  assert.deepEqual(within(row).getAllByRole("cell").slice(1, 3).map((c) => c.textContent), ["PNG Image", "200B"]);
  assert.deepEqual(screen.getAllByRole("columnheader").map((h) => h.textContent), ["Name", "Type", "Size", "Last modified"]);
  assert.deepEqual(await axeViolations(), []);
  unmount();
  renderWith(makeServer(), <CmsShell title="App"><p>x</p></CmsShell>);
  await screen.findByRole("link", { name: "Guide" });
  assert.equal(screen.queryByRole("link", { name: "Media" }), null);
});

test("editor: an image field and 'Insert media' use the picker; the preview shows the file", async () => {
  const s = makeServer({ media: true });
  const hero = await s.addFile("launch-hero.png", { folder: "blog", alt: "The launch screen" });
  await s.cms.create(admin, "guide", { slug: "hello", title: "Hello", body: "Intro" });
  const user = userEvent.setup();
  renderWith(s, <CmsDocEditor collection="guide" slug="hello" />);
  const cover = await screen.findByRole("group", { name: "Cover" });
  await user.click(within(cover).getByRole("button", { name: "Choose media" }));
  let dialog = await screen.findByRole("dialog", { name: "Choose media" });
  assert.deepEqual(within(within(dialog).queryByRole("radiogroup") ?? dialog).queryAllByRole("radio").length, 0, "an image field offers images only, so there are no type tabs");
  assert.equal((within(dialog).getByRole("button", { name: "Insert" }) as HTMLButtonElement).disabled, true);
  await user.click(await within(dialog).findByRole("button", { name: "launch-hero.png" }));
  await user.click(within(dialog).getByRole("button", { name: "Insert" }));
  await within(cover).findByText("launch-hero.png");
  assert.ok(within(cover).getByRole("button", { name: "Replace" }));
  assert.deepEqual(await axeViolations(), []);

  await user.click(screen.getByRole("button", { name: "Insert media" }));
  dialog = await screen.findByRole("dialog", { name: "Choose media" });
  await user.click(await within(dialog).findByRole("button", { name: "launch-hero.png" }));
  await user.click(within(dialog).getByRole("button", { name: "Insert" }));
  const body = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(body.value, `Intro\n\n![The launch screen](asset:${hero.id}/launch-hero.png)\n`));
  const img = await screen.findByRole("img", { name: "The launch screen" });
  assert.equal(img.getAttribute("src"), `${BASE}/files/${hero.id}/launch-hero.png`);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "hello", { draft: true })).fields.cover, hero.id));
  await user.click(within(cover).getByRole("button", { name: "Remove" }));
  assert.ok(await within(cover).findByRole("button", { name: "Choose media" }));
});
