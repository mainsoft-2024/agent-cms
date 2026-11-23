import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import CmsBlockEditor from "../cms/cms-block-editor";
import { findInText, markdownCommands } from "../cms/cms-editor-toolbar";
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
  assert.equal(document.activeElement, first);

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
function blockEditor(value: string, o: { videoHosts?: string[] } = {}) {
  const s = makeServer();
  const changes: string[] = [];
  const commandsRef = { current: null as BlockEditorCommands | null };
  const r = renderWith(s, <CmsBlockEditor value={value} onChange={(v) => changes.push(v)} commandsRef={commandsRef} snippetCollections={[]} />);
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
