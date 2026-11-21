import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsFiles } from "../cms/cms-files";
import { ko } from "../cms/cms-messages";
import { CmsShell } from "../cms/cms-shell";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const text = (s: string) => new TextEncoder().encode(s);

test("files: a bucket folder by folder, with move, share link and delete for what is selected", async () => {
  const s = makeServer({ media: true });
  // Files another program put into the bucket, and one that came through the CMS.
  await s.stores.public.put("contracts/2026/msa-acme.pdf", text("%PDF-1.7\n"), { mime: "application/pdf" });
  await s.stores.public.put("contracts/2026/brief.docx", text("PK\u0003\u0004"), { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  await s.stores.public.put("contracts/2026/signed/final.pdf", text("%PDF-1.7\n"), { mime: "application/pdf" });
  const logo = await s.addFile("logo.png", { folder: "contracts/2026" });
  await s.cms.create(admin, "guide", { slug: "hello", title: "Hello, world", body: `![Logo](asset:${logo.id}/logo.png)` });
  const user = userEvent.setup();
  renderWith(s, <CmsShell title="App"><CmsFiles /></CmsShell>, { messages: ko });
  assert.equal((await screen.findByRole("link", { name: "파일" })).getAttribute("href"), "/admin/files");
  assert.ok(await screen.findByRole("heading", { name: "파일" }));
  await user.click(await screen.findByRole("button", { name: "contracts" }));
  await user.click(await screen.findByRole("button", { name: "2026" }));
  await screen.findByRole("button", { name: "msa-acme.pdf" });
  assert.deepEqual(within(screen.getByRole("navigation", { name: "경로" })).getAllByText(/./).map((e) => e.textContent), ["공개", "contracts", "2026"]);
  assert.deepEqual(screen.getAllByRole("columnheader").slice(1).map((h) => h.textContent), ["이름", "종류", "크기", "마지막 수정"]);
  const kinds = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").slice(1, 3).map((c) => c.textContent));
  assert.deepEqual(kinds, [["signed", "폴더"], ["brief.docx", "Word 문서"], ["logo.png", "PNG 이미지"], ["msa-acme.pdf", "PDF"]]);
  assert.ok(screen.getByText("폴더 1개, 파일 3개"));
  assert.deepEqual(await axeViolations(), []);

  // Select two files: the action row appears.
  await user.click(screen.getByRole("checkbox", { name: /msa-acme\.pdf/ }));
  await user.click(screen.getByRole("checkbox", { name: /logo\.png/ }));
  const bar = screen.getByRole("toolbar");
  assert.equal(within(bar).getByRole("status").textContent, "2개 선택됨");
  assert.deepEqual(within(bar).getAllByRole("button").map((b) => b.textContent), ["이동", "내려받기", "링크 만들기", "삭제", "선택 해제"]);
  assert.deepEqual(await axeViolations(), []);

  // A link per file; a file the CMS did not know is registered on the way.
  await user.click(within(bar).getByRole("button", { name: "링크 만들기" }));
  let dialog = await screen.findByRole("dialog", { name: "링크 만들기" });
  await within(dialog).findByText("https://cdn.example.com/contracts/2026/msa-acme.pdf");
  assert.ok(within(dialog).getByText("https://cdn.example.com/contracts/2026/logo.png"));
  assert.ok(within(dialog).queryByRole("radiogroup") === null, "public files have no expiry to choose");
  assert.ok((await s.cms.assets.browse(admin, { store: "public", prefix: "contracts/2026" })).files.every((f) => f.name === "brief.docx" || f.asset));
  await user.click(within(dialog).getByRole("button", { name: "닫기" }));

  // Delete: the documents that use any of the files are shown first.
  await user.click(within(bar).getByRole("button", { name: "삭제" }));
  dialog = await screen.findByRole("dialog", { name: "파일 2개를 삭제할지 확인" });
  assert.ok(await within(dialog).findByText("이 파일을 쓰는 문서 1개"));
  assert.ok(within(dialog).getByRole("link", { name: "Hello, world" }));
  await user.click(within(dialog).getByRole("button", { name: "취소" }));

  // Move the folder's Word file into "signed".
  await user.click(within(bar).getByRole("button", { name: "선택 해제" }));
  await user.click(screen.getByRole("checkbox", { name: /brief\.docx/ }));
  await user.click(screen.getByRole("button", { name: "이동" }));
  dialog = await screen.findByRole("dialog", { name: "이동" });
  const to = within(dialog).getByLabelText("폴더") as HTMLInputElement;
  assert.equal(to.value, "contracts/2026");
  await user.type(to, "/signed");
  await user.click(within(dialog).getByRole("button", { name: "이동" }));
  await waitFor(() => assert.ok(screen.queryByRole("button", { name: "brief.docx" }) === null));
  assert.ok(s.stores.public.objects.has("contracts/2026/signed/brief.docx"));

  // Opening a file shows the media library's panel for it.
  await user.click(screen.getByRole("button", { name: "logo.png" }));
  const panel = await screen.findByRole("complementary", { name: "logo.png" });
  assert.ok(within(panel).getByRole("link", { name: "Hello, world" }));
});

test("files: a private store offers how long a link works; people who cannot look around get no menu item", async () => {
  const s = makeServer({ media: true });
  await s.addFile("contract.png", { store: "private", folder: "deals" });
  const user = userEvent.setup();
  const { unmount } = renderWith(s, <CmsFiles />);
  await user.selectOptions(await screen.findByLabelText("Store"), "private");
  await user.click(await screen.findByRole("button", { name: "deals" }));
  await user.click(await screen.findByRole("checkbox", { name: /contract\.png/ }));
  await user.click(screen.getByRole("button", { name: "Make a link" }));
  const dialog = await screen.findByRole("dialog", { name: "Make a link" });
  assert.deepEqual(within(within(dialog).getByRole("radiogroup")).getAllByRole("radio").map((r) => r.textContent), ["1 hour", "24 hours", "7 days"]);
  await within(dialog).findByText(/^memory:\/\/private\/deals\/contract\.png\?expires=86400$/);
  await user.click(within(dialog).getByRole("radio", { name: "1 hour" }));
  await within(dialog).findByText(/expires=3600$/);
  assert.equal(s.cms ? (await s.cms.audit(admin, { action: "asset.share" })).entries.length : 0, 2);
  unmount();
  renderWith(makeServer(), <CmsShell title="App"><p>x</p></CmsShell>);
  await screen.findByRole("link", { name: "Guide" });
  assert.ok(screen.queryByRole("link", { name: "Files" }) === null);
});
