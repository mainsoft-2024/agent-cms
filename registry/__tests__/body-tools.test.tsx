import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseMarkdown } from "@mainsoft/agent-cms/markdown";
import { bodySections, lineAt, lineRange, moveSection } from "../cms/cms-body-tools";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { MarkdownPreview, renderBlocks } from "../cms/cms-parts";
import { setMobile } from "./setup";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

const BODY = ["Intro line.", "", "## Connect", "1. Open settings.", "2. Press Add.", "", "```", "## not a heading", "```", "", "## Use", "Send a message.", "", "## Disconnect", "Press remove.", ""].join("\n");
const body = () => screen.getByLabelText("Markdown") as HTMLTextAreaElement;
const picked = () => body().value.slice(body().selectionStart, body().selectionEnd);

test("sections: found the way the server cuts them, moved with the text before the first heading left alone", () => {
  const secs = bodySections(BODY);
  assert.deepEqual(secs.map((s) => [s.title, s.level, s.excerpt]), [["Connect", 2, "Open settings."], ["Use", 2, "Send a message."], ["Disconnect", 2, "Press remove."]]);
  assert.equal(BODY.slice(secs[0].start, secs[0].end).includes("## not a heading"), true, "a heading inside a code fence stays in its section");

  const moved = moveSection(BODY, 2, 0);
  assert.equal(moved, ["Intro line.", "", "## Disconnect", "Press remove.", "", "## Connect", "1. Open settings.", "2. Press Add.", "", "```", "## not a heading", "```", "", "## Use", "Send a message.", ""].join("\n"));
  assert.equal(moveSection(moved, 0, 2), BODY, "moving back gives the same text");
  assert.equal(moveSection(BODY, 1, 1), BODY);
  assert.equal(moveSection(BODY, 0, 9), BODY, "a place that does not exist changes nothing");
  assert.equal(moveSection("## A\none\n\n\n\n## B\ntwo", 0, 1), "## B\ntwo\n\n## A\none", "one blank line between sections, no line break added at the end");

  assert.deepEqual(lineRange("a\nbb\nccc", 2), [2, 4]);
  assert.deepEqual(lineRange("a\nbb\nccc", 2, 3), [2, 8]);
  assert.deepEqual(lineRange("a\nbb\nccc", 9), [8, 8]);
  assert.deepEqual([lineAt("a\nbb\nccc", 0), lineAt("a\nbb\nccc", 2), lineAt("a\nbb\nccc", 8)], [1, 2, 3]);
});

test("preview: blocks say their lines, a click reports them, links keep their own click, your components draw the kinds you give", async () => {
  const picks: [number, number][] = [];
  const { container } = render(<MarkdownPreview body={"## One\n\nA [link](https://example.com) here.\n\n- a\n- b\n"} onPickLines={(a, b) => picks.push([a, b])} />);
  assert.deepEqual([...container.querySelectorAll("[data-line]")].map((e) => [e.getAttribute("data-line"), e.getAttribute("data-end-line")]), [["1", "1"], ["3", "3"], ["5", "6"]]);
  fireEvent.click(screen.getByText("b"));
  fireEvent.click(screen.getByRole("heading", { name: "One" }));
  fireEvent.click(screen.getByRole("link", { name: "link" }));
  assert.deepEqual(picks, [[5, 6], [1, 1]]);
  cleanup();

  // Without the handler the markup is what it always was.
  const plain = render(<MarkdownPreview body={"## One\n\ntext"} />);
  assert.equal(plain.container.querySelector("[data-line]"), null);
  cleanup();

  const custom = render(
    <div>
      {renderBlocks(parseMarkdown("## One\n\n```ts\nconst a = 1;\n```\n\n> quoted\n>\n> ```\n> inner\n> ```"), {
        code: ({ block }) => <pre data-own={block.lang || "none"}>{block.v}</pre>,
        heading: ({ children }) => <section data-wrapped="">{children}</section>,
      })}
    </div>
  );
  assert.deepEqual([...custom.container.querySelectorAll("[data-own]")].map((e) => [e.getAttribute("data-own"), e.textContent]), [["ts", "const a = 1;"], ["none", "inner"]], "also inside a quote");
  assert.equal(custom.container.querySelector("[data-wrapped] h2")?.textContent, "One", "children is the admin's own drawing");
});

test("editor: section cards change the order, by button and from the title back to the text; a preview click selects the lines", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  const { container } = renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} autosaveDelay={0} />);
  const user = userEvent.setup();
  await screen.findByDisplayValue("Connect Slack");

  // A click on a block of the preview selects its lines in the text.
  const preview = screen.getByRole("region", { name: "Preview" });
  await user.click(within(preview).getByText("Send a message."));
  await waitFor(() => assert.equal(picked(), "Send a message."));
  await user.click(within(preview).getByText("Press Add."));
  await waitFor(() => assert.equal(picked(), "1. Open settings.\n2. Press Add."));

  const toggle = screen.getByRole("button", { name: "Section order" });
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  await user.click(toggle);
  const list = screen.getByRole("list", { name: "Section order" });
  assert.deepEqual(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace(/\s+/g, " ").trim()), ["Before the first headingIntro line.", "##ConnectOpen settings.", "##UseSend a message.", "##DisconnectPress remove."]);
  assert.equal((within(list).getByRole("button", { name: "Move “Connect” up" }) as HTMLButtonElement).disabled, true);
  assert.equal((within(list).getByRole("button", { name: "Move “Disconnect” down" }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(await axeViolations(container), []);

  await user.click(within(list).getByRole("button", { name: "Move “Disconnect” up" }));
  assert.deepEqual(bodySections(body().value).map((x) => x.title), ["Connect", "Disconnect", "Use"]);
  assert.ok(screen.getByText("Moved “Disconnect” to place 2 of 3"));
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Move “Disconnect” up", "the keyboard stays on the card that moved");
  await user.keyboard("{Enter}");
  assert.deepEqual(bodySections(body().value).map((x) => x.title), ["Disconnect", "Connect", "Use"]);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Move “Disconnect” down", "at the top the other arrow takes over");
  assert.ok(body().value.startsWith("Intro line.\n\n## Disconnect\nPress remove.\n\n## Connect\n"));

  // Dragging: the last card dropped on the top half of the first one.
  const cards = () => within(screen.getByRole("list", { name: "Section order" })).getAllByRole("listitem").slice(1);
  const data = { effectAllowed: "", setData() {} };
  fireEvent.dragStart(cards()[2], { dataTransfer: data });
  fireEvent.dragOver(cards()[0], { dataTransfer: data, clientY: -5 });
  fireEvent.drop(cards()[0], { dataTransfer: data });
  assert.deepEqual(bodySections(body().value).map((x) => x.title), ["Use", "Disconnect", "Connect"]);

  // A title goes back to the text with that heading selected.
  await user.click(within(screen.getByRole("list", { name: "Section order" })).getByRole("button", { name: "Connect" }));
  await waitFor(() => assert.equal(picked(), "## Connect"));
  assert.equal(screen.queryByRole("list", { name: "Section order" }), null);
  assert.equal(screen.getByRole("button", { name: "Section order" }).getAttribute("aria-pressed"), "false");

  // Saving keeps the new order.
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.deepEqual(bodySections((await s.cms.get(admin, "guide", "slack", { draft: true }))!.body).map((x) => x.title), ["Use", "Disconnect", "Connect"]));
});

test("editor: one section or a reader: no order button; on a phone the preview click goes to the text tab", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "one", title: "One", body: "## Only\n\ntext" });
  await s.cms.create(admin, "guide", { slug: "two", title: "Two", body: "## First\n\nalpha\n\n## Second\n\nbeta" });
  renderWith(s, <CmsDocEditor collection="guide" slug="one" presenceMs={0} />);
  await screen.findByDisplayValue("One");
  assert.equal(screen.queryByRole("button", { name: "Section order" }), null);
  cleanup();

  setMobile(true);
  renderWith(s, <CmsDocEditor collection="guide" slug="two" presenceMs={0} />);
  const user = userEvent.setup();
  await screen.findByDisplayValue("Two");
  assert.ok(screen.getByRole("button", { name: "Section order" }));
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  await user.click(await screen.findByText("beta"));
  await waitFor(() => assert.equal(screen.getByRole("tab", { name: "Edit" }).getAttribute("aria-selected"), "true"));
  await waitFor(() => assert.equal(picked(), "beta"));
});
