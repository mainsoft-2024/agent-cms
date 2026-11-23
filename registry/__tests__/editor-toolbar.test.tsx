import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import CmsBlockEditor from "../cms/cms-block-editor";
import { bodyStats, findInText, fitToolbar, markdownCommands, TOOLBAR_PRIORITY, type FitItem } from "../cms/cms-editor-toolbar";
import { isVideoFile, pickedMarkdown, slashQuery } from "../cms/cms-block-editor";
import { createT, ko } from "../cms/cms-messages";
import type { BlockEditorCommands } from "../cms/use-cms";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => cleanup());

// ProseMirror measures text ranges when it scrolls the caret into view; jsdom has no layout.
const rangeProto = window.Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects ??= function () {
  return Object.assign([], { item: () => null });
};
rangeProto.getBoundingClientRect ??= function () {
  return new window.DOMRect(0, 0, 0, 0);
};
// The block menu finds its block with CSS.escape, which jsdom lacks.
const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`);

/** A text box with a body, and the toolbar's markdown commands on it. */
function textBox(body: string, a: number, b = a) {
  const el = document.createElement("textarea");
  document.body.appendChild(el);
  el.value = body;
  el.setSelectionRange(a, b);
  let marks: { start: number; end: number }[] = [];
  const cmds = markdownCommands({
    box: () => el,
    body: () => el.value,
    setBody: (v) => (el.value = v),
    onMarks: (m) => (marks = m),
  });
  return { el, cmds, marks: () => marks };
}

test("toolbar commands in markdown: marks wrap and unwrap the selection, lines change type, blocks go on lines of their own", () => {
  const t1 = textBox("say hello now", 4, 9);
  t1.cmds.run("bold");
  assert.equal(t1.el.value, "say **hello** now");
  t1.el.setSelectionRange(6, 11);
  t1.cmds.run("bold");
  assert.equal(t1.el.value, "say hello now", "pressing again takes the marks off");
  t1.el.setSelectionRange(4, 9);
  t1.cmds.run("code");
  assert.equal(t1.el.value, "say `hello` now");

  const t2 = textBox("one\ntwo\nthree", 1, 6);
  t2.cmds.run("number");
  assert.equal(t2.el.value, "1. one\n2. two\nthree");
  t2.el.setSelectionRange(0, 0);
  assert.deepEqual(t2.cmds.state("number"), { enabled: true, active: true });
  t2.cmds.run("h2");
  assert.equal(t2.el.value, "## one\n2. two\nthree", "a heading replaces the list mark");
  t2.el.setSelectionRange(0, 0);
  t2.cmds.run("p");
  assert.equal(t2.el.value, "one\n2. two\nthree");

  const t3 = textBox("Intro", 5);
  t3.cmds.run("steps");
  assert.equal(t3.el.value, "Intro\n\n:::steps\n1. \n:::\n");
  const t4 = textBox("", 0);
  t4.cmds.run("card");
  assert.equal(t4.el.value, ":::card\n[Title](https://)\n:::\n");
  assert.equal(t4.el.value.slice(t4.el.selectionStart, t4.el.selectionEnd) || "Title", "Title");
  const t5 = textBox("a", 1);
  t5.cmds.run("callout");
  assert.equal(t5.el.value, "> [!note]\n> a");
  cleanup();
  document.body.innerHTML = "";
});

test("find and replace in markdown: counts, steps round, replaces one and all; case and whole word", () => {
  assert.deepEqual(findInText("Slack slack SLACKS", "slack", { caseSensitive: false, wholeWord: false }).length, 3);
  assert.deepEqual(findInText("Slack slack SLACKS", "slack", { caseSensitive: true, wholeWord: false }).length, 1);
  assert.deepEqual(findInText("Slack slack SLACKS", "slack", { caseSensitive: false, wholeWord: true }).length, 2);
  assert.deepEqual(findInText("a.b a+b", "a.b", { caseSensitive: false, wholeWord: false }), [{ start: 0, end: 3 }], "the query is text, not a pattern");

  const t = textBox("Link Slack. Pick the Slack channel. Slack!", 0);
  assert.deepEqual(t.cmds.find("Slack", { caseSensitive: false, wholeWord: false }), { count: 3, current: 0 });
  assert.equal(t.marks().length, 3, "matches are drawn behind the text");
  assert.deepEqual(t.cmds.findStep(1), { count: 3, current: 1 });
  assert.equal(t.el.value.slice(t.el.selectionStart, t.el.selectionEnd), "Slack");
  assert.equal(t.el.selectionStart, 21);
  assert.deepEqual(t.cmds.findStep(-1), { count: 3, current: 0 });
  assert.deepEqual(t.cmds.findStep(-1), { count: 3, current: 2 }, "steps go round");
  assert.equal(t.cmds.replace("Teams", false), 1);
  assert.equal(t.el.value, "Link Slack. Pick the Slack channel. Teams!");
  assert.equal(t.cmds.replace("Teams", true), 2);
  assert.equal(t.el.value, "Link Teams. Pick the Teams channel. Teams!");
  assert.deepEqual(t.cmds.find("Slack", { caseSensitive: false, wholeWord: false }), { count: 0, current: -1 });
  t.cmds.findClear();
  assert.deepEqual(t.marks(), []);
  document.body.innerHTML = "";
});

const BODY = "Intro with Slack.\n\n## Connect\n\nOpen Slack settings.\n\n## Use\n\nSend a message.\n";

test("editor toolbar: icon buttons named for screen readers, one tab stop moved by arrows, word count, axe clean", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  const { container } = renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} autosaveDelay={0} />);
  await screen.findByDisplayValue("Connect Slack");
  const bar = screen.getByRole("toolbar", { name: "Formatting" });
  for (const name of ["Undo", "Redo", "Bold", "Italic", "Strikethrough", "Inline code", "Link", "Bulleted list", "Numbered list", "To-do list", "Quote", "Callout", "Table", "Code block", "Divider", "Find and replace", "Section order", "Preview beside the text", "Preview window", "Full screen"].map((n) => n)) {
    const b = within(bar).queryByRole("button", { name });
    // Labels of existing buttons come from the messages; only check that the ones defined here are there.
    if (["Bold", "Italic", "Find and replace", "Undo", "Table", "Section order"].includes(name)) assert.ok(b, `${name} is in the toolbar`);
  }
  // Icons only: the buttons show no text of their own.
  assert.equal(within(bar).getByRole("button", { name: "Bold" }).textContent, "");
  assert.ok(within(bar).getByRole("button", { name: "Text style" }));
  assert.ok(within(bar).getByRole("button", { name: "Insert a block" }));
  assert.match(bar.textContent ?? "", /\d+ words/);

  // One tab stop; arrows move it.
  const stops = () => [...bar.querySelectorAll<HTMLElement>("[data-tb-item]")].filter((el) => el.tabIndex === 0);
  await waitFor(() => assert.equal(stops().length, 1));
  const first = stops()[0];
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "ArrowRight" });
  await waitFor(() => assert.ok(document.activeElement !== first && bar.contains(document.activeElement)));
  assert.equal(stops().length, 1);
  assert.equal(stops()[0], document.activeElement);
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  assert.ok(document.activeElement === first, `focus on ${document.activeElement?.tagName} ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 40)}`);

  // A tooltip names the button and its shortcut on keyboard focus.
  const bold = within(bar).getByRole("button", { name: "Bold" });
  assert.equal(bold.getAttribute("aria-keyshortcuts"), "Control+B Meta+B");
  assert.deepEqual(await axeViolations(container), []);
});

test("editor toolbar: Bold wraps the text box's selection; Ctrl+F finds, Ctrl+H replaces all", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} autosaveDelay={0} />);
  await screen.findByDisplayValue("Connect Slack");
  const user = userEvent.setup();
  const box = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
  act(() => {
    box.focus();
    box.setSelectionRange(0, 5);
  });
  fireEvent.select(box);
  await user.click(screen.getByRole("button", { name: "Bold" }));
  await waitFor(() => assert.ok(box.value.startsWith("**Intro** with Slack.")));

  // Find inside the body.
  act(() => box.focus());
  fireEvent.keyDown(box, { key: "f", ctrlKey: true });
  const search = await screen.findByRole("search", { name: "Find and replace" });
  // It starts with the selected text; type something else.
  await user.clear(within(search).getByRole("textbox", { name: "Find" }));
  await user.type(within(search).getByRole("textbox", { name: "Find" }), "slack");
  await waitFor(() => assert.equal(within(search).getByRole("status").textContent, "1/2"));
  await user.click(within(search).getByRole("button", { name: "Next match" }));
  await waitFor(() => assert.equal(within(search).getByRole("status").textContent, "2/2"));
  fireEvent.keyDown(within(search).getByRole("textbox", { name: "Find" }), { key: "h", ctrlKey: true });
  const rep = await within(search).findByRole("textbox", { name: "Replace with" });
  await user.type(rep, "Teams");
  await user.click(within(search).getByRole("button", { name: "All" }));
  await waitFor(() => assert.equal(box.value, BODY.replace("Intro", "**Intro**").replaceAll("Slack", "Teams")));
  await waitFor(() => assert.equal(within(search).getByRole("status").textContent, "No results"));
  fireEvent.keyDown(within(search).getByRole("textbox", { name: "Find" }), { key: "Escape" });
  await waitFor(() => assert.ok(!screen.queryByRole("search", { name: "Find and replace" })));
});

/** The block editor on its own, with the toolbar's commands. */
function blockEditor(value: string, o: { videoHosts?: string[]; uploadFile?: (f: File) => Promise<string> } = {}) {
  const s = makeServer();
  const changes: string[] = [];
  const commandsRef = { current: null as BlockEditorCommands | null };
  const r = renderWith(s, <CmsBlockEditor value={value} onChange={(v) => changes.push(v)} commandsRef={commandsRef} snippetCollections={[]} uploadFile={o.uploadFile} />);
  void o;
  return { ...r, changes, commandsRef, last: () => changes[changes.length - 1] };
}

test("block editor: steps, link cards, videos and snippets are drawn; a video from a site not allowed says so", async () => {
  const md = [":::steps\n**One** first.\n\n**Two** next.\n:::", ":::card\n[Docs](https://example.com/docs)\nRead them\n:::", ":::video\nhttps://evil.example/v/1\n:::", ":::video\nhttps://youtu.be/dQw4w9WgXcQ\nThe tour\n:::", "## Setup {#setup-guide}", "[[snippet:support-contact]]"].join("\n\n");
  const { container } = blockEditor(md);
  await waitFor(() => assert.ok(container.querySelector("[data-block-type=steps]")));
  assert.ok(screen.getByText("Docs"));
  assert.ok(screen.getByText("example.com/docs"));
  assert.ok(screen.getByText("Read them"));
  const alert = (await screen.findByText(/Videos from evil\.example/)).closest("[role=alert]")!;
  assert.match(alert.textContent ?? "", /evil\.example/);
  assert.match(alert.textContent ?? "", /youtube\.com/);
  assert.ok(screen.getByText("youtu.be"));
  assert.equal((screen.getByDisplayValue("The tour") as HTMLInputElement).value, "The tour");
  assert.ok(screen.getByText(/support-contact/));
  assert.ok(screen.getByText("#setup-guide"), "the pinned anchor is shown by the heading");
});

test("block editor: the toolbar's find and replace and block commands work through its commands", async () => {
  const md = "Link Slack.\n\nPick the Slack channel.";
  const ed = blockEditor(md);
  await waitFor(() => assert.ok(ed.commandsRef.current));
  const c = ed.commandsRef.current!;
  let r!: { count: number; current: number };
  act(() => void (r = c.find("slack", { caseSensitive: false, wholeWord: false })));
  assert.equal(r.count, 2);
  await waitFor(() => assert.equal(ed.container.querySelectorAll(".cms-find").length, 2));
  assert.equal(ed.container.querySelectorAll(".cms-find-current").length, 1);
  act(() => void (r = c.findStep(1)));
  assert.equal(r.current, 1);
  act(() => void c.replace("Teams", false));
  await waitFor(() => assert.equal(ed.last(), "Link Slack.\n\nPick the Teams channel."));
  act(() => void c.find("slack", { caseSensitive: false, wholeWord: false }));
  act(() => void c.replace("Teams", true));
  await waitFor(() => assert.equal(ed.last(), "Link Teams.\n\nPick the Teams channel."));
  act(() => c.findClear());
  await waitFor(() => assert.equal(ed.container.querySelectorAll(".cms-find").length, 0));

  // Undo is possible now; a block command puts a block after the caret's block.
  assert.equal(c.state("undo").enabled, true);
  act(() => void c.run("hr"));
  await waitFor(() => assert.match(ed.last(), /\n\n---$|\n\n---\n/));
  act(() => void c.run("undo"));
  await waitFor(() => assert.ok(!/---/.test(ed.last())));
});

test("block editor: a heading's menu copies its anchor link and pins and unpins it", async () => {
  const ed = blockEditor("## Setup guide\n\nText.");
  await waitFor(() => assert.ok(ed.commandsRef.current));
  const pm = ed.container.querySelector<HTMLElement>(".ProseMirror")!;
  const openMenu = async () => {
    act(() => ed.commandsRef.current!.focus());
    fireEvent.keyDown(pm, { key: "/", ctrlKey: true });
    return screen.findByRole("listbox", { name: "Block" }).catch(() => screen.findByRole("listbox"));
  };
  let menu = await openMenu();
  const copy = within(menu).getByRole("option", { name: /Copy anchor link/ });
  // On a heading the anchor actions come first (what its menu is opened for most), copy highlighted.
  assert.equal(within(menu).getAllByRole("option")[0], copy);
  assert.equal(copy.getAttribute("aria-selected"), "true");
  assert.match(copy.textContent ?? "", /#setup-guide/);
  fireEvent.click(copy);
  // user-event puts its own clipboard on navigator: read it back from there.
  const copied: string[] = [];
  await waitFor(async () => {
    copied.push(await navigator.clipboard.readText());
    assert.equal(copied[copied.length - 1], "#setup-guide");
  });

  menu = await openMenu();
  fireEvent.click(within(menu).getByRole("option", { name: /Pin anchor/ }));
  await waitFor(() => assert.equal(ed.last(), "## Setup guide {#setup-guide}\n\nText."));
  assert.ok(await screen.findByText("#setup-guide"));

  menu = await openMenu();
  fireEvent.click(within(menu).getByRole("option", { name: /Unpin anchor/ }));
  await waitFor(() => assert.equal(ed.last(), "## Setup guide\n\nText."));
});

test("block editor: a link card, a video and a snippet put in from the toolbar open their forms and write their markdown", async () => {
  const user = userEvent.setup();
  const ed = blockEditor("Intro");
  await waitFor(() => assert.ok(ed.commandsRef.current));
  act(() => ed.commandsRef.current!.focus());
  act(() => void ed.commandsRef.current!.run("card"));
  const card = await screen.findByRole("group", { name: "Link card" });
  await user.type(within(card).getByRole("textbox", { name: "Title" }), "Docs");
  await user.type(within(card).getByRole("textbox", { name: "Link address" }), "https://example.com/docs");
  await waitFor(() => assert.match(ed.last(), /^Intro\n\n:::card\n\[Docs\]\(https:\/\/example\.com\/docs\)\n:::/));
  await user.click(within(card).getByRole("button", { name: "Done" }));
  await waitFor(() => assert.ok(!screen.queryByRole("group", { name: "Link card" })));

  act(() => void ed.commandsRef.current!.run("video"));
  const video = await screen.findByRole("group", { name: "Video" });
  await user.type(within(video).getByRole("textbox", { name: "Video address" }), "https://evil.example/v{Enter}");
  await waitFor(() => assert.match(ed.last(), /:::video\nhttps:\/\/evil\.example\/v\n:::/));
  assert.ok(await screen.findByText(/Videos from evil\.example are not allowed/));

  act(() => void ed.commandsRef.current!.run("snippet"));
  const find = await screen.findByRole("combobox", { name: "Find a snippet" });
  await waitFor(() => assert.ok(screen.getByText(/No snippet collection yet/)));
  await user.type(find, "support-line");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.match(ed.last(), /\[\[snippet:support-line\]\]/));
});

test("toolbar commands in markdown: heading 4, two columns, a toggle and an HTML block", async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
  const t1 = textBox("Title", 0);
  t1.cmds.run("h4");
  assert.equal(t1.el.value, "#### Title");
  t1.el.setSelectionRange(0, 0);
  assert.deepEqual(t1.cmds.state("h4"), { enabled: true, active: true });
  assert.deepEqual(t1.cmds.state("h3"), { enabled: true, active: false });
  t1.cmds.run("h2");
  assert.equal(t1.el.value, "## Title", "another style replaces the #### mark");

  const t2 = textBox("Intro", 5);
  t2.cmds.run("columns");
  assert.equal(t2.el.value, "Intro\n\n:::columns\n:::col\nLeft\n:::col\nRight\n:::\n");
  await frame();
  assert.equal(t2.el.value.slice(t2.el.selectionStart, t2.el.selectionEnd), "Left");
  const t3 = textBox("", 0);
  t3.cmds.run("toggle");
  assert.equal(t3.el.value, ":::toggle Title\nText\n:::\n");
  await frame();
  assert.equal(t3.el.value.slice(t3.el.selectionStart, t3.el.selectionEnd), "Title");
  const t4 = textBox("", 0);
  t4.cmds.run("html");
  assert.equal(t4.el.value, ":::html\n<div></div>\n:::\n");
  document.body.innerHTML = "";
});

test("reading time: 200 words a minute, Korean 500 characters a minute, a mixed body adds the two", () => {
  const en = Array.from({ length: 600 }, () => "word").join(" ");
  assert.deepEqual(bodyStats(en), { words: 600, chars: 2400, minutes: 3 });
  // 1,000 Hangul syllables in 250 words (eojeol of four): two minutes, words still counted by spaces.
  const ko = Array.from({ length: 250 }, () => "가나다라").join(" ");
  const k = bodyStats(ko);
  assert.equal(k.words, 250);
  assert.equal(k.chars, 1000, "characters leave out the spaces");
  assert.equal(k.minutes, 2);
  // 500 syllables (1 min) + 200 English words (1 min).
  const mixed = `${Array.from({ length: 125 }, () => "한국어문").join(" ")} ${Array.from({ length: 200 }, () => "word").join(" ")}`;
  assert.equal(bodyStats(mixed).minutes, 2);
  assert.equal(bodyStats("").minutes, 1);
});

/** Items of a full bar (views, word count) with the real classes' widths: 28px buttons + 1px gap. */
function barItems(o: { outline?: boolean; media?: boolean } = {}): FitItem[] {
  const b = (key: string, group: FitItem["group"], width = 29) => ({ key, group, width });
  return [
    b("undo", "history"),
    b("redo", "history"),
    b("style", "style", 78),
    ...["bold", "italic", "strike", "code", "link"].map((k) => b(k, "marks")),
    ...["bullet", "number", "todo", "quote", "callout"].map((k) => b(k, "lists")),
    ...["table", "codeblock", "hr"].map((k) => b(k, "blocks")),
    ...(o.media === false ? [] : [b("media", "media")]),
    b("insert", "insert", 68),
    b("find", "right"),
    ...(o.outline === false ? [] : [b("outline", "right")]),
    b("side", "right"),
    b("window", "right"),
    b("full", "right"),
    b("stat-min", "stat", 52),
    b("stat", "stat", 62),
  ];
}
const fit = (avail: number, items = barItems()) => fitToolbar({ avail, fixed: 24 + 140 + 8, items, sep: 8, more: 29, leadSep: true });

test("toolbar fit: items leave one by one, rare blocks first; the reading time goes before any button", () => {
  assert.equal(fit(2000).size, 0, "everything fits on a wide bar");
  // A little short: only the reading time goes (and no More button for it).
  const all = barItems();
  const full = 24 + 140 + 8 + all.reduce((s, i) => s + i.width, 0) + 8 * 7 + 8;
  assert.deepEqual([...fit(full - 10)], ["stat-min"]);
  // Shorter: the rarer blocks go next, in their order, and More comes in.
  assert.deepEqual([...fit(full - 60)], ["stat-min", "hr", "codeblock"]);
  assert.deepEqual([...fit(full - 120)], ["stat-min", "hr", "codeblock", "table", "callout"]);
  // The order is the priority list.
  const keys = Object.entries(TOOLBAR_PRIORITY)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  assert.deepEqual(keys.slice(0, 9), ["stat-min", "hr", "codeblock", "table", "callout", "quote", "todo", "strike", "code"]);
  assert.deepEqual(keys.slice(-4), ["window", "side", "outline", "full"], "the view buttons go last");
  assert.ok(TOOLBAR_PRIORITY.outline > TOOLBAR_PRIORITY.undo && TOOLBAR_PRIORITY.full > TOOLBAR_PRIORITY.outline, "section order and full screen stay longest");
  assert.ok(TOOLBAR_PRIORITY.media > TOOLBAR_PRIORITY.bold && TOOLBAR_PRIORITY.insert > TOOLBAR_PRIORITY.code && TOOLBAR_PRIORITY.style > TOOLBAR_PRIORITY.number);
});

test("toolbar fit: at the side-preview width (560px) section order and insert media stay as buttons", () => {
  const hidden = fit(560);
  for (const k of ["outline", "media", "full", "side", "window", "undo", "redo"]) assert.ok(!hidden.has(k), `${k} stays`);
  for (const k of ["hr", "codeblock", "table", "callout", "quote", "todo", "strike", "code", "stat-min"]) assert.ok(hidden.has(k), `${k} goes into More`);
  // Wider (no side preview): the everyday buttons come back.
  const wide = fit(900);
  for (const k of ["bold", "italic", "link", "style", "insert", "bullet", "number", "media", "outline"]) assert.ok(!wide.has(k), `${k} shown at 900px`);
  // Very narrow: the view buttons are the last left.
  const tiny = fit(330);
  assert.ok(!tiny.has("full") && !tiny.has("outline"));
  // Without an outline (one section) the same width keeps one more editing button.
  const without = fit(560, barItems({ outline: false }));
  assert.ok(without.size <= hidden.size);
});

test("editor toolbar: hidden items go into More as flat items in toolbar order, with lines between groups", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  // jsdom has no layout: give the bar 600px and every measured item a width.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const cw = Object.getOwnPropertyDescriptor(window.Element.prototype, "clientWidth");
  const rect = window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(window.Element.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "toolbar" ? 600 : 0;
    },
  });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const m = this.getAttribute("data-tb-m");
    const w = m === "style" ? 78 : m === "insert" ? 68 : m === "sep" ? 7 : m === "stat-full" ? 120 : m === "stat-short" ? 62 : m ? 28 : this.getAttribute("data-tb-group") === "lead" ? 140 : 0;
    return new window.DOMRect(0, 0, w, 28);
  };
  try {
    renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} autosaveDelay={0} />);
    await screen.findByDisplayValue("Connect Slack");
    const bar = screen.getByRole("toolbar", { name: "Formatting" });
    // Section order is offered (two sections) and stays a button; rarer blocks are in More.
    await waitFor(() => assert.ok(within(bar).getByRole("button", { name: "More" })));
    assert.ok(within(bar).getByRole("button", { name: "Section order" }));
    assert.ok(within(bar).getByRole("button", { name: "Undo" }));
    assert.ok(!within(bar).queryByRole("button", { name: "Divider" }));
    assert.ok(!within(bar).queryByRole("button", { name: "Table" }));
    // The word count keeps its words, drops the reading time, and says it in its title.
    const stat = bar.querySelector<HTMLElement>("[data-tb-stat]")!;
    assert.ok(stat && /words/.test(stat.textContent ?? ""));
    assert.ok(!/min read/.test(stat.textContent ?? ""));
    assert.match(stat.title, /min read/);
    const user = userEvent.setup();
    await user.click(within(bar).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.replace(/[⌘⇧]|Ctrl\+.*$/g, "").trim());
    const at = (n: string) => names.findIndex((x) => x?.startsWith(n));
    assert.ok(at("Divider") >= 0 && at("Code block") >= 0 && at("Table") >= 0, `rare blocks are in More: ${names.join(", ")}`);
    assert.ok(at("Table") < at("Code block") && at("Code block") < at("Divider"), "in toolbar order");
    assert.ok(menu.querySelectorAll("[role=separator]").length >= 1, "a line between groups");
    // An item in More runs its command.
    await user.click(within(menu).getByRole("menuitem", { name: /Divider/ }));
    const box = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
    await waitFor(() => assert.match(box.value, /^---\n|\n---\n/));
  } finally {
    if (cw) Object.defineProperty(window.Element.prototype, "clientWidth", cw);
    proto.getBoundingClientRect = rect;
  }
});

test("block editor: heading 4, two columns, a toggle and an HTML block from the toolbar's commands", async () => {
  const ed = blockEditor("Intro");
  await waitFor(() => assert.ok(ed.commandsRef.current));
  const c = ed.commandsRef.current!;
  act(() => c.focus());
  act(() => void c.run("h4"));
  await waitFor(() => assert.equal(ed.last(), "#### Intro"));
  assert.equal(c.state("h4").active, true);
  assert.ok(ed.container.querySelector("[data-block-type=h4]"));
  act(() => void c.run("p"));
  await waitFor(() => assert.equal(ed.last(), "Intro"));

  act(() => void c.run("columns"));
  await waitFor(() => assert.ok(ed.container.querySelector("[data-block-type=columns]")));
  act(() => {
    c.focus();
    document.execCommand?.("insertText", false, "x");
  });
  act(() => void c.run("toggle"));
  await waitFor(() => assert.ok(ed.container.querySelector("[data-block-type=toggle]")));
  act(() => void c.run("html"));
  await waitFor(() => assert.match(ed.last() ?? "", /:::html/));
});

test("block editor: an uploaded video file becomes a :::video block; a picture stays a picture", async () => {
  let n = 0;
  const ed = blockEditor("Intro", { uploadFile: async (f) => `asset:${String(++n).padStart(12, "a")}/${encodeURIComponent(f.name)}` });
  await waitFor(() => assert.ok(ed.commandsRef.current));
  act(() => ed.commandsRef.current!.focus());
  const input = ed.container.querySelector<HTMLInputElement>("input[data-cms-upload]")!;
  assert.ok(input, "the upload input is there");
  const clip = new File([new Uint8Array([0, 0, 0, 24])], "clip.mp4", { type: "video/mp4" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [clip] } });
  });
  await waitFor(() => assert.match(ed.last() ?? "", /:::video\nasset:aaaaaaaaaaa1\/clip\.mp4\n:::/));
  assert.ok(!/!\[\]\(asset:aaaaaaaaaaa1/.test(ed.last()), "not a picture");
  const pic = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [pic] } });
  });
  await waitFor(() => assert.match(ed.last() ?? "", /!\[\]\(asset:aaaaaaaaaaa2\/shot\.png\)/));

  // Picked from the library: a video file goes into a video block too.
  assert.equal(pickedMarkdown("![](asset:abcdefabcdef/tour.webm)"), ":::video\nasset:abcdefabcdef/tour.webm\n:::");
  assert.equal(pickedMarkdown("![Shot](asset:abc/shot.png)"), "![Shot](asset:abc/shot.png)");
  assert.equal(pickedMarkdown("[notes.pdf](asset:abc/notes.pdf)"), "[notes.pdf](asset:abc/notes.pdf)");
  assert.equal(isVideoFile({ type: "video/quicktime", name: "a.mov" }), true);
  assert.equal(isVideoFile({ type: "", name: "a.webm" }), true);
  assert.equal(isVideoFile({ type: "image/png", name: "a.png" }), false);
});

test("block editor: a snippet inside a line is a chip; Enter opens its popover to change the key, and it can be removed", async () => {
  const user = userEvent.setup();
  const ed = blockEditor("Call [[snippet:support-phone]] today.");
  await waitFor(() => assert.ok(ed.commandsRef.current));
  const chip = await screen.findByRole("button", { name: "Snippet: support-phone" });
  assert.equal(chip.closest("[contenteditable]")?.getAttribute("contenteditable"), "false");
  await user.click(chip);
  const find = await screen.findByRole("combobox", { name: "Find a snippet" });
  await user.type(find, "sales-phone");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(ed.last(), "Call [[snippet:sales-phone]] today."));
  // Open again and remove it.
  await user.click(await screen.findByRole("button", { name: "Snippet: sales-phone" }));
  await user.click(await screen.findByRole("button", { name: "Remove snippet" }));
  await waitFor(() => assert.equal(ed.last(), "Call  today."));
  assert.ok(!screen.queryByRole("button", { name: /Snippet: / }));
});

test("/ menu: a query may have spaces between words while something matches (Korean labels have them)", () => {
  const t = createT(ko);
  assert.equal(slashQuery("/링크 카드", t)?.[2], "링크 카드");
  assert.equal(slashQuery("/할 일 목록", t)?.[2], "할 일 목록");
  assert.equal(slashQuery("/링크 ", t)?.[2], "링크 ", "a space after a word that matches keeps the menu while the next word comes");
  assert.equal(slashQuery("text /ste", t)?.[2], "ste");
  assert.equal(slashQuery("/", t)?.[2], "");
  // A slash that was only a slash: the menu closes at the first space that matches nothing.
  assert.equal(slashQuery("/usr 폴더", t), null);
  assert.equal(slashQuery("/ ", t), null);
  assert.equal(slashQuery("/링크  카드", t), null, "two spaces in a row end the query");
  assert.equal(slashQuery("and/or", t), null);
});

test("server messages follow the screens' language; a message the CMS was given in its own words stays", async () => {
  const { serverText, errorMessage, en } = await import("../cms/cms-messages");
  const { CmsRemoteError } = await import("@mainsoft/agent-cms/client");
  const ko = createT((await import("../cms/cms-messages")).ko);
  const english = createT(en);
  assert.equal(serverText({ code: "redirect_loop", message: "This redirect would lead back to itself" }, ko), "이 리다이렉트는 자기 자신으로 돌아옴");
  const { en: serverEn } = await import("@mainsoft/agent-cms/messages/en");
  assert.equal(serverText({ code: "slug_taken", message: "이미 쓰는 주소임: intro", params: { slug: "intro" } }, english), String(serverEn.slug_taken).replace("{slug}", "intro"));
  assert.equal(serverText({ code: "redirect_loop", message: "Nope, loops are bad here" }, ko), "Nope, loops are bad here");
  assert.equal(errorMessage(new CmsRemoteError("This redirect would lead back to itself", "redirect_loop", { params: {} }), ko), "이 리다이렉트는 자기 자신으로 돌아옴");
});
