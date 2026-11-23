import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRestClient } from "@mainsoft/agent-cms/client";
import { PART_SIZE } from "@mainsoft/agent-cms/storage";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { GalleryField } from "../cms/cms-fields-more";
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
  const dialog = await screen.findByRole("dialog", { name: "파일 1개를 삭제할지 확인" });
  assert.ok(within(dialog).getByText("삭제한 파일은 되살릴 수 없음."));
  assert.ok(within(dialog).getByText("이 파일을 쓰는 문서 1개"));
  assert.ok(within(dialog).getByRole("link", { name: "Hello, world" }));
  await user.click(within(dialog).getByRole("button", { name: "삭제" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "launch-hero.png" }) === null));
  await assert.rejects(s.cms.assets.get(admin, hero.id));
  await screen.findByText("파일이 없음.");

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
  assert.ok(screen.queryByRole("link", { name: "Media" }) === null);
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

test("media: import from a URL into the open folder, and rename a file in its panel", async () => {
  const s = makeServer({ media: true });
  await s.addFile("logo.png", { folder: "brand" });
  const user = userEvent.setup();
  renderWith(s, <CmsMedia />, { messages: ko });
  const folders = await screen.findByRole("navigation", { name: "폴더" });
  await user.click(await within(folders).findByRole("button", { name: /brand/ }));
  await user.click(screen.getByRole("button", { name: "URL에서 가져오기" }));
  let dialog = await screen.findByRole("dialog", { name: "URL에서 가져오기" });
  // An address inside the network is refused by the server, and the dialog says so, in the screens' language
  // (the server wrote it in English).
  await user.type(within(dialog).getByLabelText("주소"), "https://intranet.example/a.png");
  await user.click(within(dialog).getByRole("button", { name: "가져오기" }));
  assert.ok(await within(dialog).findByText("가져올 수 없는 주소임"));
  await user.clear(within(dialog).getByLabelText("주소"));
  await user.type(within(dialog).getByLabelText("주소"), "https://example.com/pics/team-photo.png");
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByRole("button", { name: "가져오기" }));
  // The new file opens in the panel, in the folder that was open.
  const panel = await screen.findByRole("complementary", { name: "team-photo.png" });
  assert.ok(within(panel).getByText("공개 / brand"));
  assert.ok(within(panel).getByText("200B, 800×600"));
  assert.ok(s.stores.public.objects.has("brand/team-photo.png"));

  await user.click(within(panel).getByRole("button", { name: "이름 바꾸기" }));
  const name = screen.getByRole("textbox", { name: "이름 바꾸기" }) as HTMLInputElement;
  assert.equal(name.value, "team-photo.png");
  await user.clear(name);
  await user.type(name, "team-2026{Enter}");
  await screen.findByRole("complementary", { name: "team-2026.png" });
  assert.ok(s.stores.public.objects.has("brand/team-2026.png") && !s.stores.public.objects.has("brand/team-photo.png"), "the extension is kept and the file really moved");
  await screen.findByRole("button", { name: "team-2026.png" });
  // Escape leaves the name as it was.
  await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
  await user.type(screen.getByRole("textbox", { name: "이름 바꾸기" }), "x{Escape}");
  assert.ok(await screen.findByRole("heading", { name: "team-2026.png" }));
});

test("upload: new content for a file, carrying on after a reload, and photos without camera data", async () => {
  const s = makeServer({ media: true, stripMetadata: true });
  const client = createRestClient({ url: BASE, fetch: s.fetch });
  const memory = new Map<string, string>();
  const store = { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => void memory.set(k, v), remove: (k: string) => void memory.delete(k) };
  /** A fresh uploader with the same browser storage: what a reload leaves. */
  const open = (broken: () => boolean) => {
    const state = { last: [] as UploadItem[], sent: [] as string[], resumed: false };
    const up = createUploader({
      client,
      memory: store,
      retries: 0,
      retryDelayMs: 1,
      stripMetadata: () => !!me.media?.stripMetadata,
      describe: async () => ({}),
      onChange: (items) => ((state.last = items), (state.resumed ||= !!items[0]?.resumed)),
      send: async (url, body, o) => {
        const part = /partNumber=(\d+)/.exec(url)?.[1] ?? "single";
        state.sent.push(part);
        if (broken() && part === "2") throw new Error("network");
        const status = await s.stores.public.send(url, new Uint8Array(await body.arrayBuffer()));
        if (status !== 200) throw new Error(`HTTP ${status}`);
        o.onProgress(body.size);
      },
    });
    return { up, state };
  };
  const me = await client.me();
  assert.equal(me.media?.stripMetadata, true);

  // Replace: the same file comes back, with the new content at its address.
  const logo = await s.addFile("logo.png", { folder: "brand", alt: "Logo" });
  const next = new Uint8Array(900);
  next.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]);
  const a = open(() => false);
  a.up.add([new File([next], "logo-v2.png", { type: "image/png" })], { replace: logo.id });
  await waitFor(() => assert.equal(a.state.last[0]?.state, "done"));
  assert.deepEqual([a.state.last[0].replaces, a.state.last[0].asset?.id, a.state.last[0].asset?.name, a.state.last[0].asset?.rev, a.state.last[0].asset?.size, a.state.last[0].asset?.alt], [logo.id, logo.id, "logo.png", 1, 900, "Logo"]);
  assert.equal(s.stores.public.objects.get("brand/logo.png")?.body.length, 900);
  assert.equal(client.fileUrl(a.state.last[0].asset!), `${BASE}/files/${logo.id}/logo.png?v=1`, "a new address for the browser's cache");
  // Another kind of file is refused with the server's reason.
  a.up.add([new File(["%PDF-1.7"], "logo.pdf", { type: "application/pdf" })], { replace: logo.id });
  await waitFor(() => assert.equal(a.state.last[1]?.state, "failed"));
  assert.equal(a.state.last[1].error, "A file can only be replaced by one of the same type (image/png)");

  // A large upload breaks, the page is reloaded, the same file is picked again: only the missing part goes up.
  const bytes = new Uint8Array(PART_SIZE * 2 + 1000);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const file = new File([bytes], "talk.mp4", { type: "video/mp4", lastModified: 1_700_000_000_000 });
  const first = open(() => true);
  first.up.add([file], { folder: "talks" });
  await waitFor(() => assert.equal(first.state.last[0]?.state, "failed"), { timeout: 8000 });
  assert.equal(memory.size, 1);
  const second = open(() => false);
  second.up.add([new File([bytes], "talk.mp4", { type: "video/mp4", lastModified: 1_700_000_000_000 })], { folder: "talks" });
  await waitFor(() => assert.equal(second.state.last[0]?.state, "done"), { timeout: 8000 });
  assert.deepEqual([second.state.sent, second.state.resumed, memory.size], [["2"], true, 0]);
  assert.equal(s.stores.public.objects.get("talks/talk.mp4")?.body.length, file.size);
  // Remembered, but the server no longer knows the upload (it was cleaned up): it simply starts over.
  const other = new File([bytes], "talk-2.mp4", { type: "video/mp4", lastModified: 5 });
  memory.set(`agent-cms:upload:talk-2.mp4|${other.size}|5|||`, JSON.stringify({ id: "gonegonegone", at: Date.now() }));
  const third = open(() => false);
  third.up.add([other]);
  await waitFor(() => assert.equal(third.state.last[0]?.state, "done"), { timeout: 8000 });
  assert.deepEqual([third.state.sent.sort(), third.state.last[0].resumed, memory.size], [["1", "2", "3"], false, 0]);

  // A photo: what the camera wrote is taken out before anything is sent; the picture's turn stays.
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, ...new TextEncoder().encode("SecretCam GPS 37.5665N 126.9780E")];
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9]);
  const photo = open(() => false);
  photo.up.add([new File([jpeg], "trip.jpg", { type: "image/jpeg" })]);
  await waitFor(() => assert.equal(photo.state.last[0]?.state, "done"));
  const stored = s.stores.public.objects.get("trip.jpg")!.body;
  assert.equal(new TextDecoder("latin1").decode(stored).includes("SecretCam"), false);
  assert.deepEqual([stored.length, photo.state.last[0].size, photo.state.last[0].asset?.size], [2 + 36 + 6 + 9, stored.length, stored.length]);
  assert.deepEqual([...stored.subarray(2, 6), stored[31]], [0xff, 0xe1, 0, 34, 6], "the orientation is kept in a block of its own");
});

test("media: the focal point by keyboard, and replacing a file asks first", async () => {
  const s = makeServer({ media: true });
  const logo = await s.addFile("logo.png", { folder: "brand" });
  await s.cms.create(admin, "guide", { slug: "about", title: "About", body: `![Logo](asset:${logo.id}/logo.png)` });
  const user = userEvent.setup();
  renderWith(s, <CmsMedia />, { messages: ko });
  await user.click(await screen.findByRole("button", { name: /logo\.png/ }));
  const panel = await screen.findByRole("complementary", { name: "logo.png" });

  // No point yet: nothing is drawn until someone sets one.
  assert.ok(within(panel).queryByRole("button", { name: /^초점:/ }) === null);
  const toggle = within(panel).getByRole("button", { name: "초점" });
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  await user.click(toggle);
  const point = within(panel).getByRole("button", { name: "초점: 왼쪽에서 50%, 위에서 50%" });
  assert.ok(within(panel).getByText(/잘라낼 때 꼭 보여야 하는 곳/));
  assert.deepEqual(await axeViolations(), []);
  point.focus();
  await user.keyboard("{ArrowRight}");
  await within(panel).findByRole("button", { name: "초점: 왼쪽에서 52%, 위에서 50%" });
  await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
  await within(panel).findByRole("button", { name: "초점: 왼쪽에서 52%, 위에서 40%" });
  // The point moves at once; it is saved once, a moment after the last key.
  await waitFor(async () => assert.deepEqual([(await s.cms.assets.get(admin, logo.id)).focalX, (await s.cms.assets.get(admin, logo.id)).focalY], [0.52, 0.4]), { timeout: 3000 });
  // Done aiming: the point stays visible, but no longer takes input.
  await user.click(toggle);
  assert.equal((within(panel).getByRole("button", { name: /^초점:/ }) as HTMLButtonElement).disabled, true);
  await user.click(toggle);
  await user.click(within(panel).getByRole("button", { name: "지우기" }));
  await waitFor(async () => assert.equal((await s.cms.assets.get(admin, logo.id)).focalX, null));

  // Replace: pick a file, see what will happen, then say yes.
  const input = panel.querySelector('input[type="file"]') as HTMLInputElement;
  assert.equal(input.accept, ".png");
  await user.upload(input, new File([new Uint8Array(1500)], "logo-2026.png", { type: "image/png" }));
  const dialog = await screen.findByRole("dialog", { name: "“logo.png”의 내용을 바꿀지 확인" });
  assert.ok(within(dialog).getByText("주소는 그대로임. 지금 내용은 되돌릴 수 없음."));
  assert.ok(within(dialog).getByText(/logo-2026\.png/));
  assert.ok(within(dialog).getByText("이 파일을 쓰는 문서 1개에 새 내용이 보임."));
  assert.deepEqual(await axeViolations(), []);
  assert.equal(s.requests.some((r) => r.path === "/assets/uploads"), false, "nothing is sent before the answer");
  await user.click(within(dialog).getByRole("button", { name: "바꾸기" }));
  await waitFor(() => assert.deepEqual(s.requests.find((r) => r.method === "POST" && r.path === "/assets/uploads")?.body, { name: "logo-2026.png", mime: "image/png", size: 1500, replace: logo.id }));
  assert.ok(screen.queryByRole("dialog", { name: /내용을 바꿀까요/ }) === null);
});

test("gallery: several files in one go, in the order picked; files already in the field and the limit are respected", async () => {
  const s = makeServer({ media: true });
  const a = await s.addFile("a.png", { alt: "A" });
  const b = await s.addFile("b.png", { alt: "B" });
  const c = await s.addFile("c.png", { alt: "C" });
  const d = await s.addFile("d.png", { alt: "D" });
  const seen: unknown[] = [];
  function Harness() {
    const [v, setV] = React.useState<unknown>([a.id]);
    seen.push(v);
    return <GalleryField id="g" label="Photos" value={v} onChange={setV} max={3} accept={["image/*"]} />;
  }
  const user = userEvent.setup();
  renderWith(s, <Harness />);
  await user.click(await screen.findByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose media" });
  await within(dialog).findByText("already added");
  assert.ok(!within(dialog).queryByRole("button", { name: "a.png" }), "a file already in the field cannot be picked again");
  within(dialog).getByText("2 more can be added");
  await user.click(await within(dialog).findByRole("button", { name: "c.png" }));
  await user.click(within(dialog).getByRole("button", { name: "b.png" }));
  assert.ok(within(dialog).getByRole("button", { name: "c.png, picked 1" }));
  assert.ok(within(dialog).getByRole("button", { name: "b.png, picked 2" }));
  // The field takes three: a fourth pick is refused with a note.
  await user.click(within(dialog).getByRole("button", { name: "d.png" }));
  within(dialog).getByText("No more room: the field takes 3");
  assert.equal(within(dialog).getByRole("button", { name: "d.png" }).getAttribute("aria-pressed"), "false");
  // Un-picking frees the place; picking again puts it last.
  await user.click(within(dialog).getByRole("button", { name: "c.png, picked 1" }));
  await user.click(within(dialog).getByRole("button", { name: "c.png" }));
  await user.click(within(dialog).getByRole("button", { name: "Insert 2" }));
  await waitFor(() => assert.deepEqual(seen.at(-1), [a.id, b.id, c.id]));
  void d;
});

test("gallery: files of a type the field does not take are shown but not pickable, and are not uploaded", async () => {
  const s = makeServer({ media: true });
  const a = await s.addFile("a.png", { alt: "A" });
  const text = new TextEncoder().encode("plain notes");
  const { asset: notes, upload } = await s.cms.assets.requestUpload(admin, { name: "notes.txt", size: text.length });
  if (upload.kind === "single") await s.stores.public.send(upload.url, text);
  await s.cms.assets.completeUpload(admin, notes.id);
  const seen: unknown[] = [];
  function Harness() {
    const [v, setV] = React.useState<unknown>([]);
    seen.push(v);
    return <GalleryField id="g" label="Files" value={v} onChange={setV} max={null} accept={["image/png", ".pdf"]} />;
  }
  const user = userEvent.setup({ applyAccept: false });
  renderWith(s, <Harness />);
  await user.click(await screen.findByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose media" });
  await within(dialog).findByText("type not allowed here");
  assert.ok(!within(dialog).queryByRole("button", { name: "notes.txt" }), "a text file cannot be picked for a PNG/PDF field");
  assert.ok(within(dialog).getByText("notes.txt"), "but it is shown");
  // An upload of a type the field refuses is not sent; an accepted one is.
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, [new File(["hello"], "readme.md", { type: "text/markdown" })]);
  await within(dialog).findByText("Not uploaded (this field does not take the type): readme.md");
  assert.equal(s.requests.some((r) => r.method === "POST" && r.path === "/assets/uploads"), false, "nothing was sent");
  await user.click(within(dialog).getByRole("button", { name: "a.png" }));
  await user.click(within(dialog).getByRole("button", { name: "Insert 1" }));
  await waitFor(() => assert.deepEqual(seen.at(-1), [a.id]));
});

test("gallery: filling the last place puts focus on the last picture; Alt+← → reorder pictures", async () => {
  const s = makeServer({ media: true });
  const a = await s.addFile("a.png", { alt: "A" });
  const b = await s.addFile("b.png", { alt: "B" });
  const c = await s.addFile("c.png", { alt: "C" });
  const seen: unknown[] = [];
  function Harness() {
    const [v, setV] = React.useState<unknown>([a.id]);
    seen.push(v);
    return <GalleryField id="g" label="Photos" value={v} onChange={setV} max={3} accept={["image/*"]} />;
  }
  const user = userEvent.setup();
  renderWith(s, <Harness />);
  await user.click(await screen.findByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole("dialog", { name: "Choose media" });
  await user.click(await within(dialog).findByRole("button", { name: "b.png" }));
  await user.click(within(dialog).getByRole("button", { name: "c.png" }));
  await user.click(within(dialog).getByRole("button", { name: "Insert 2" }));
  await waitFor(() => assert.deepEqual(seen.at(-1), [a.id, b.id, c.id]));
  // The Add tile is gone (the field is full): focus is on the last picture, not lost to the page.
  await waitFor(() => assert.equal(document.activeElement?.getAttribute("aria-label"), "Picture 3 of 3. Alt+← → to move"));
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(() => assert.deepEqual(seen.at(-1), [a.id, c.id, b.id]));
});
