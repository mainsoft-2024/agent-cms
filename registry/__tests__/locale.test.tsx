// 0.22.0 languages in the admin: the language tabs of a localized collection, starting a
// translation, a translation's shared fields, an outdated translation (changes, mark as
// matching), switching with unsaved edits, and the list's language filter.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { CmsDocList } from "../cms/cms-doc-list";
import { setMobile } from "./setup";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** A source in English with a current Korean translation; Japanese not started. */
async function seeded() {
  const s = makeServer({ locales: true });
  await s.cms.create(admin, "guide", { slug: "start", title: "Getting started", body: "## Install\n\nInstall it.", category: "start", fields: { order: 3, note: "Read first" } }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "start", title: "시작하기", body: "## 설치\n\n설치함.", fields: { note: "먼저 읽을 것" } }, { locale: "ko", from: "start", publish: true });
  return s;
}

const tabs = () => within(screen.getByRole("navigation", { name: "Languages" }));

test("locale: tabs show every language with its status; a tab opens that language's document", async () => {
  const s = await seeded();
  renderWith(s, <CmsDocEditor collection="guide" slug="start" />);
  await screen.findByDisplayValue("Getting started");
  await waitFor(() => assert.ok(tabs().getByRole("button", { name: "English, Source" })));
  assert.equal(tabs().getByRole("button", { name: "English, Source" }).getAttribute("aria-current"), "page");
  assert.ok(tabs().getByRole("button", { name: "한국어, Up to date" }));
  assert.ok(tabs().getByRole("button", { name: "日本語, None" }));
  // Arrow keys move between the tabs.
  tabs().getByRole("button", { name: "English, Source" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  assert.equal(document.activeElement, tabs().getByRole("button", { name: "한국어, Up to date" }));
  assert.deepEqual(await axeViolations(), []);

  fireEvent.click(tabs().getByRole("button", { name: "한국어, Up to date" }));
  await screen.findByDisplayValue("시작하기");
  assert.equal(tabs().getByRole("button", { name: "한국어, Up to date" }).getAttribute("aria-current"), "page");
  assert.ok(screen.getByText("Matches source v1"));
  // The source is beside the translation.
  const src = await screen.findByRole("region", { name: "English source" });
  await within(src).findByText("Getting started");
  assert.deepEqual(await axeViolations(), []);
});

test("locale: with onOpenDocument the tab asks the host to open slug@locale", async () => {
  const s = await seeded();
  const opened: string[] = [];
  renderWith(s, <CmsDocEditor collection="guide" slug="start" onOpenDocument={(c, x) => opened.push(`${c}/${x}`)} />);
  await screen.findByDisplayValue("Getting started");
  fireEvent.click(await waitFor(() => tabs().getByRole("button", { name: "日本語, None" })));
  assert.deepEqual(opened, ["guide/start@ja"]);
});

test("locale: a translation shows the shared fields read only and does not send them", async () => {
  const s = await seeded();
  renderWith(s, <CmsDocEditor collection="guide" slug="start@ko" />);
  await screen.findByDisplayValue("시작하기");
  // The address and the number field follow the source.
  assert.ok((screen.getByLabelText(/Slug/) as HTMLInputElement).disabled);
  assert.ok(screen.getByText("The address follows the source"));
  const order = screen.getByLabelText(/Order/) as HTMLInputElement;
  assert.equal(order.value, "3");
  assert.ok(order.closest("fieldset")?.disabled);
  assert.ok(screen.getAllByText("Follows the source").length >= 1);
  assert.ok(await screen.findByText(/follow the English source/));
  // The translated field is editable.
  const note = screen.getByLabelText(/note/i) as HTMLInputElement;
  assert.equal(note.disabled, false);
  await userEvent.clear(note);
  await userEvent.type(note, "새 메모");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const isSave = (r: { method: string; path: string }) => r.method !== "GET" && /\/guide\/start(%40|@)ko$/.test(r.path.split("?")[0]);
  await waitFor(() => assert.ok(s.requests.some(isSave), s.requests.map((r) => `${r.method} ${r.path}`).join("\n")));
  const put = s.requests.find(isSave)!;
  const body = (put.body as { doc: { slug?: string; category?: string; fields: Record<string, unknown> } }).doc;
  assert.equal(body.slug, undefined);
  assert.equal(body.category, undefined);
  assert.equal(body.fields.order, undefined);
  assert.equal(body.fields.note, "새 메모");
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "start", { draft: true, locale: "ko" })).fields.note, "새 메모"));
  // "Open the source" goes back to the source.
  fireEvent.click(screen.getByRole("button", { name: "Open the source" }));
  await screen.findByDisplayValue("Getting started");
});

test("locale: a language not started shows why, and Start translation copies the source", async () => {
  const s = await seeded();
  renderWith(s, <CmsDocEditor collection="guide" slug="start@ja" />);
  await screen.findByText("No 日本語 translation yet");
  assert.ok(screen.getByText(/a site that falls back shows the English source/));
  assert.deepEqual(await axeViolations(), []);
  fireEvent.click(screen.getByRole("button", { name: "Start translation" }));
  await screen.findByDisplayValue("Getting started");
  assert.ok(s.requests.some((r) => r.method === "POST" && r.path.endsWith("/guide/start/_translations")));
  await waitFor(() => assert.ok(tabs().getByRole("button", { name: "日本語, Up to date" })));
  // Not published yet: readers of a site that falls back still get the source.
  assert.ok(screen.getByText(/Not published: readers in 日本語 may see the English source/));
});

test("locale: an outdated translation shows the source's changes and can be marked as matching", async () => {
  const s = await seeded();
  await s.cms.update(admin, "guide", "start", { body: "## Install\n\nInstall it.\n\n## Connect media\n\nConnect S3." }, { publish: true });
  renderWith(s, <CmsDocEditor collection="guide" slug="start@ko" />);
  await screen.findByDisplayValue("시작하기");
  await waitFor(() => assert.ok(tabs().getByRole("button", { name: "한국어, Needs update" })));
  assert.ok(screen.getByText("Source v2, this translation is based on v1"));
  // The source pane marks the new lines.
  await screen.findByText("2 changed lines are marked");
  const show = screen.getByRole("button", { name: "Show changes" });
  assert.equal(show.getAttribute("aria-expanded"), "false");
  fireEvent.click(show);
  const panel = await screen.findByRole("region", { name: "Changes in the source since v1" });
  await within(panel).findByText("## Connect media");
  assert.equal(screen.getByRole("button", { name: "Hide changes" }).getAttribute("aria-expanded"), "true");
  assert.deepEqual(await axeViolations(), []);

  fireEvent.click(screen.getByRole("button", { name: "Mark as matching v2" }));
  await screen.findByText("Matches source v2");
  assert.ok(s.requests.some((r) => r.method === "POST" && r.path.endsWith("/guide/start/_align")));
  await waitFor(() => assert.ok(tabs().getByRole("button", { name: "한국어, Up to date" })));
  assert.ok(!screen.queryByRole("button", { name: "Mark as matching v2" }));
  assert.equal((await s.cms.translations(admin, "guide", "start")).translations.find((x) => x.locale === "ko")?.status, "current");
});

test("locale: switching language with unsaved edits asks first", async () => {
  const s = await seeded();
  renderWith(s, <CmsDocEditor collection="guide" slug="start" autosaveDelay={60_000} />);
  const title = await screen.findByDisplayValue("Getting started");
  await userEvent.type(title, " now");
  fireEvent.click(await waitFor(() => tabs().getByRole("button", { name: "한국어, Up to date" })));
  const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  assert.equal((screen.getByDisplayValue("Getting started now") as HTMLInputElement).value, "Getting started now");

  fireEvent.click(tabs().getByRole("button", { name: "한국어, Up to date" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save and switch" }));
  await screen.findByDisplayValue("시작하기");
  assert.equal((await s.cms.get(admin, "guide", "start", { draft: true })).title, "Getting started now");
});

test("locale: the list shows each row's translations and filters by language", async () => {
  const s = await seeded();
  await s.cms.create(admin, "guide", { slug: "faq", title: "FAQ", body: "x" });
  const opened: string[] = [];
  renderWith(s, <CmsDocList collection="guide" onOpenDocument={(_c, x) => opened.push(x)} />);
  await screen.findByText("Getting started");
  const row = screen.getByText("Getting started").closest("tr")!;
  const marks = await within(row).findByRole("list", { name: "Translations" });
  assert.ok(within(marks).getByText("한국어, Up to date"));
  assert.ok(within(marks).getByText("日本語, None"));
  const faq = screen.getByText("FAQ").closest("tr")!;
  assert.ok(within(faq).getByText("한국어, None"));
  assert.deepEqual(await axeViolations(), []);

  const lang = screen.getByRole("combobox", { name: "Language" });
  assert.match(lang.textContent ?? "", /English \(source\)/);
  fireEvent.click(lang);
  fireEvent.keyDown(lang, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "한국어" }));
  await screen.findByText("시작하기");
  assert.ok(s.requests.some((r) => r.method === "GET" && r.path.includes("locale=ko")));
  assert.ok(!screen.queryByText("FAQ"));
  const ko = screen.getByText("시작하기").closest("tr")!;
  assert.ok(within(ko).getByText("Up to date"));
  fireEvent.click(within(ko).getByRole("button", { name: "시작하기" }));
  assert.deepEqual(opened, ["start@ko"]);
});
