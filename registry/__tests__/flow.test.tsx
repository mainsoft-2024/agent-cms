import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsDocEditor } from "../cms/cms-doc-editor";
import { CmsDocList } from "../cms/cms-doc-list";
import { offsetOf, placeOf, sectionAt } from "../cms/cms-flow";
import { createT, ko } from "../cms/cms-messages";
import { CmsRelease, CmsReleases } from "../cms/cms-releases";
import { CmsShell } from "../cms/cms-shell";
import { CmsTrash, daysLeft } from "../cms/cms-trash";
import { CmsVersions } from "../cms/cms-versions";
import { zonedParts, zonedToIso } from "../cms/use-cms";
import { setMobile } from "./setup";
import { admin, agent, axeViolations, editor2, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

const BODY = ["## Connect", "1. Open settings.", "2. Press Add.", "", "## Disconnect", "Press remove."].join("\n");
const body = () => screen.getByLabelText("Markdown") as HTMLTextAreaElement;

test("flow: Korean particles follow the word, clock times follow the zone, places follow the text", () => {
  const t = createT(ko);
  assert.equal(t("review_requested_by", { who: "김지수", version: 2 }), "김지수가 v2 검토를 요청했어요");
  assert.equal(t("review_requested_by", { who: "docs-bot", version: 3 }), "docs-bot이 v3 검토를 요청했어요");
  assert.equal(t("sched_done", { version: 3, time: "11월 24일 오전 9:00" }), "v3을 11월 24일 오전 9:00에 게시하도록 예약했어요");
  assert.equal(t("release_refresh_item", { version: 7 }), "v7로 바꾸기");
  assert.equal(t("release_refresh_item", { version: 6 }), "v6으로 바꾸기");
  assert.equal(t("release_delete_title", { name: "0.7 출시" }), "릴리스 0.7 출시를 삭제할까요?");

  assert.equal(zonedToIso("2026-11-24", "09:00", "Asia/Seoul"), "2026-11-24T00:00:00.000Z");
  assert.equal(zonedToIso("2026-07-01", "09:00", "America/New_York"), "2026-07-01T13:00:00.000Z");
  assert.equal(zonedToIso("2026-12-01", "09:00", "America/New_York"), "2026-12-01T14:00:00.000Z");
  assert.equal(zonedToIso("", "09:00", "UTC"), null);
  assert.deepEqual(zonedParts("2026-11-24T00:00:00.000Z", "Asia/Seoul"), { date: "2026-11-24", time: "09:00" });
  assert.equal(daysLeft("2026-12-01T00:00:00Z", Date.parse("2026-11-04T12:00:00Z")), 27);

  assert.equal(sectionAt(BODY, BODY.indexOf("Press Add")), "connect");
  assert.equal(sectionAt(BODY, BODY.indexOf("Press remove")), "disconnect");
  assert.deepEqual(placeOf(BODY, { anchor: "connect", quote: "2. Press Add." }), { start: BODY.indexOf("2. Press"), end: BODY.indexOf("2. Press") + 13, kind: "quote" });
  assert.equal(placeOf(BODY, { anchor: "disconnect", quote: "gone text" })?.kind, "section");
  assert.equal(placeOf(BODY, { anchor: "removed-section", quote: "gone text" }), null);
  assert.equal(offsetOf(BODY, 3, 3), BODY.indexOf("Press Add"));
});

test("flow: schedule a document from the publish button, see it in the list, cancel it", async () => {
  const s = makeServer({ timeZone: "Asia/Seoul" });
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Publish options" }));
  const panel = screen.getByRole("dialog", { name: "Schedule publishing" });
  assert.ok(within(panel).getByText("Asia/Seoul"));
  assert.equal((within(panel).getByLabelText("Publish at: Time") as HTMLInputElement).value, "09:00");
  assert.deepEqual(await axeViolations(), []);
  // A time that has passed is refused before anything is sent.
  fireEvent.change(within(panel).getByLabelText("Publish at: Date"), { target: { value: "2020-01-01" } });
  await user.click(within(panel).getByRole("button", { name: "Schedule" }));
  assert.ok(within(panel).getByText("Pick a time later than now"));
  fireEvent.change(within(panel).getByLabelText("Publish at: Date"), { target: { value: "2099-11-24" } });
  await user.click(within(panel).getByRole("button", { name: "Schedule" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Schedule publishing" }), null));
  const doc = (await s.cms.get(admin, "guide", "slack", { draft: true }))!;
  assert.equal(doc.schedule?.publishAt, "2099-11-24T00:00:00.000Z");
  assert.equal(doc.schedule?.version, 1);
  assert.ok(await screen.findByText(/v1 goes out/));
  assert.ok(screen.getByText("Scheduled"));

  // An edit after scheduling does not go out: the strip says so and offers the new version.
  fireEvent.change(body(), { target: { value: `${BODY}\nMore.` } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Edited after scheduling. The edits will not go out.");
  await user.click(screen.getByRole("button", { name: "Schedule the latest version" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.schedule?.version, 2));
  cleanup();

  renderWith(s, <CmsDocList collection="guide" presenceMs={0} />);
  await screen.findByRole("radio", { name: "Scheduled 1" });
  assert.ok(within(await screen.findByRole("row", { name: /Connect Slack/ })).getByText("Scheduled"));
  cleanup();

  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  await user.click(await screen.findByRole("button", { name: "Cancel schedule" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.schedule, null));
});

test("flow: an agent asks for a review; a person sends it back, then approves and publishes", async () => {
  const s = makeServer({ review: { agents: "required" } });
  await s.cms.create(agent, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  await s.cms.requestReview(agent, "guide", "slack", { note: "Please check the steps" });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  const user = userEvent.setup();
  await screen.findByText("docs-agent asked for a review of v1");
  assert.ok(screen.getByText("Please check the steps"));
  assert.ok(screen.getByText("In review"));
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("button", { name: "Send back" }));
  await user.type(await screen.findByLabelText("Note"), "Step 2 is wrong");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send back" }));
  await screen.findByText("Admin sent v1 back");
  assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.review?.state, "changes_requested");
  assert.ok(screen.getByText("Changes requested"));

  await s.cms.requestReview(agent, "guide", "slack");
  cleanup();
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  await user.click(await screen.findByRole("button", { name: "Approve and publish" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.publishedVersion, 1));
  assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.review, null);
});

test("flow: where everyone needs a review, the author asks and someone else approves", async () => {
  const s = makeServer({ review: { everyone: "required" } });
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Request review" }));
  await screen.findByText("Admin asked for a review of v1");
  assert.equal(screen.queryByRole("button", { name: "Publish" }), null);
  assert.equal(screen.queryByRole("button", { name: "Approve and publish" }), null, "the one who asked cannot approve");
  cleanup();

  s.session.user = editor2;
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  await user.click(await screen.findByRole("button", { name: "Approve and publish" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.publishedVersion, 1));
  cleanup();
  renderWith(s, <CmsVersions collection="guide" slug="slack" />);
  await screen.findAllByText("Approved by Park");
});

test("flow: comments sit on quoted text, take replies, get resolved, and lose their place when the text goes", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  await s.cms.addComment(agent, "guide", "slack", { body: "Is this still the button name?", anchor: "connect", quote: "2. Press Add." });
  await s.cms.addComment(editor2, "guide", "slack", { body: "Old remark", anchor: "billing", quote: "text that is gone" });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Comments 2" }));
  const panel = screen.getByRole("complementary", { name: "Comments" });
  assert.ok(within(panel).getByText("Is this still the button name?"));
  assert.ok(within(panel).getByText("Lost their place"));
  assert.equal(document.querySelector("[data-cms-backdrop] mark")?.textContent, "2. Press Add.");
  assert.deepEqual(await axeViolations(), []);

  // The quote takes you to the text.
  await user.click(within(panel).getByRole("button", { name: "2. Press Add." }));
  await waitFor(() => assert.equal(body().value.slice(body().selectionStart, body().selectionEnd), "2. Press Add."));

  // A new comment hangs on what is selected.
  body().setSelectionRange(BODY.indexOf("Press remove."), BODY.indexOf("Press remove.") + 13);
  fireEvent.select(body());
  await user.click(within(panel).getByLabelText("Write a comment"));
  await user.type(within(panel).getByLabelText("Write a comment"), "Say which menu");
  await user.click(within(panel).getByRole("button", { name: "Comment" }));
  await waitFor(async () => assert.equal((await s.cms.comments(admin, "guide", "slack")).length, 3));
  const mine = (await s.cms.comments(admin, "guide", "slack")).find((c) => c.body === "Say which menu")!;
  assert.equal(mine.quote, "Press remove.");
  assert.equal(mine.anchor, "disconnect");

  await user.type(within(panel).getByLabelText("Reply: docs-agent"), "Yes, it is{Enter}");
  await within(panel).findByText("Yes, it is");
  const first = within(panel).getByText("Is this still the button name?").closest("li")!;
  await user.click(within(first).getByRole("button", { name: "Resolve" }));
  await within(panel).findByRole("radio", { name: "Resolved 1" });
  assert.equal(within(panel).queryByText("Is this still the button name?"), null);
  await user.click(within(panel).getByRole("radio", { name: "Resolved 1" }));
  assert.ok(await within(panel).findByRole("button", { name: "Reopen" }));
});

test("flow: who else is here, and their save merges into unsaved edits that do not overlap", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  await s.cms.presence.touch(editor2, "guide", "slack", { cursor: { line: 3, ch: 3 } });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={40} autosaveDelay={100000} />);
  await screen.findByRole("img", { name: "Here now: Park" });
  await waitFor(() => assert.equal(document.querySelector("[data-cms-cursor]")?.getAttribute("data-cms-cursor"), "Park"));

  fireEvent.change(body(), { target: { value: BODY.replace("Press remove.", "Press remove, then confirm.") } });
  await s.cms.update(editor2, "guide", "slack", { body: BODY.replace("1. Open settings.", "1. Open the settings page.") }, { expectedVersion: 1 });
  await waitFor(() => assert.ok(body().value.includes("Open the settings page.") && body().value.includes("then confirm.")), { timeout: 3000 });
  await screen.findByText("Park saved v2. It was merged with your edits.");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () => assert.equal((await s.cms.get(admin, "guide", "slack", { draft: true }))!.version, 3));
  const saved = (await s.cms.get(admin, "guide", "slack", { draft: true }))!.body;
  assert.ok(saved.includes("Open the settings page.") && saved.includes("then confirm."));
  cleanup();

  await s.cms.presence.touch(editor2, "guide", "slack", {});
  renderWith(s, <CmsDocList collection="guide" presenceMs={40} />);
  await screen.findByRole("img", { name: "Here now: Park" });
});

test("flow: the trash lists deleted documents, restores them, and deletes them forever", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "old-pricing", title: "Old pricing", body: BODY }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "beta", title: "Beta notes", body: BODY });
  await s.cms.remove(admin, "guide", "old-pricing");
  await s.cms.remove(admin, "guide", "beta");
  renderWith(s, <CmsShell activeHref="/admin/trash"><CmsTrash /></CmsShell>);
  const user = userEvent.setup();
  await screen.findByRole("row", { name: /Old pricing/ });
  assert.ok(await within(screen.getAllByRole("navigation", { name: "Admin navigation" })[0]).findByRole("link", { name: /Trash\s*2/ }));
  assert.ok(within(screen.getByRole("row", { name: /Old pricing/ })).getByText("30 days"));
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("checkbox", { name: "Select Old pricing" }));
  await user.click(screen.getByRole("button", { name: "Restore" }));
  const dlg = await screen.findByRole("dialog");
  assert.ok(within(dlg).getByText("Restore 1 documents?"));
  assert.ok(within(dlg).getByText("Documents that were published go public again."));
  await user.click(within(dlg).getByRole("button", { name: "Restore" }));
  await screen.findByText("Restored 1");
  assert.equal((await s.cms.get(admin, "guide", "old-pricing"))?.title, "Old pricing", "published again");

  await user.click(await screen.findByRole("checkbox", { name: "Select Beta notes" }));
  await user.click(screen.getByRole("button", { name: "Delete forever" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete forever" }));
  await screen.findByText("The trash is empty");
  assert.equal((await s.cms.trash.list(admin)).items.length, 0);

  // The list's delete confirm says where things go.
  cleanup();
  renderWith(s, <CmsDocList collection="guide" presenceMs={0} />);
  await user.click(await screen.findByRole("checkbox", { name: "Select Old pricing" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  assert.ok(await screen.findByText("They stay in the trash for 30 days, then they are deleted for good."));
});

test("flow: a release is made, filled, shows what changes, and publishes all of it or nothing", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "launch", title: "Launch post", body: BODY });
  await s.cms.create(admin, "guide", { slug: "old", title: "Old pricing", body: BODY }, { publish: true });
  let opened = "";
  renderWith(s, <CmsReleases onOpenRelease={(id) => (opened = id)} />);
  const user = userEvent.setup();
  await screen.findByText("No releases yet");
  await user.click(screen.getByRole("button", { name: "New release" }));
  await user.type(await screen.findByLabelText("Name"), "0.10 launch");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "New release" }));
  await waitFor(() => assert.ok(opened));
  await screen.findByRole("row", { name: /0\.10 launch/ });
  assert.ok(within(screen.getByRole("row", { name: /0\.10 launch/ })).getByText("In progress"));
  assert.deepEqual(await axeViolations(), []);
  cleanup();

  renderWith(s, <CmsRelease id={opened} />);
  await screen.findByText("No documents in this release");
  await user.click(screen.getByRole("button", { name: "Add documents" }));
  let dlg = await screen.findByRole("dialog");
  await user.click(await within(dlg).findByRole("checkbox", { name: /Launch post/ }));
  await user.click(within(dlg).getByRole("button", { name: "Add documents" }));
  await screen.findByRole("row", { name: /Launch post/ });
  await user.click(screen.getByRole("button", { name: "Add documents" }));
  dlg = await screen.findByRole("dialog");
  await user.click(within(dlg).getByRole("radio", { name: "Unpublish" }));
  assert.equal(within(dlg).queryByRole("checkbox", { name: /Launch post/ }), null, "already inside, and not public");
  await user.click(await within(dlg).findByRole("checkbox", { name: /Old pricing/ }));
  await user.click(within(dlg).getByRole("button", { name: "Add documents" }));
  const oldRow = await screen.findByRole("row", { name: /Old pricing/ });
  assert.ok(within(oldRow).getByText("Unpublish"));
  assert.ok(within(screen.getByRole("row", { name: /Launch post/ })).getByText(/New publish/));
  assert.ok(screen.getByText("2 documents"));
  assert.deepEqual(await axeViolations(), []);

  // The document moved on: the row shows both versions and can switch.
  await s.cms.update(admin, "guide", "launch", { body: `${BODY}\nMore.` }, { expectedVersion: 1 });
  cleanup();
  renderWith(s, <CmsRelease id={opened} />);
  await screen.findByText("v1 → v2");
  await user.click(screen.getByRole("button", { name: "Launch post: Switch to v2" }));
  await waitFor(() => assert.equal(screen.queryByText("v1 → v2"), null));

  await user.click(screen.getByRole("button", { name: "Publish" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }));
  await screen.findByText("Published the release");
  assert.equal((await s.cms.get(admin, "guide", "launch", { draft: true }))!.publishedVersion, 2);
  assert.equal((await s.cms.get(admin, "guide", "old", { draft: true }))!.publishedVersion, null);
  assert.equal(screen.queryByRole("button", { name: "Add documents" }), null, "a published release is a record");
});

test("flow: saved filters keep a tab and a search; versions take a name and a pin", async () => {
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY }, { publish: true });
  await s.cms.create(admin, "guide", { slug: "draft", title: "A draft", body: BODY });
  renderWith(s, <CmsDocList collection="guide" presenceMs={0} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("radio", { name: "Draft 1" }));
  await user.click(screen.getByRole("button", { name: "Saved filters" }));
  await user.click(await screen.findByRole("menuitem", { name: "Save filter" }));
  await user.type(await screen.findByLabelText("Name"), "My drafts");
  await user.click(screen.getByRole("checkbox", { name: "Show to everyone" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save filter" }));
  await waitFor(async () => assert.deepEqual((await s.cms.filters.list(admin, "guide")).map((f) => [f.name, f.query, f.shared]), [["My drafts", { state: "draft" }, true]]));
  await user.click(screen.getByRole("radio", { name: "All 2" }));
  await user.click(screen.getByRole("button", { name: "Saved filters" }));
  await user.click(await screen.findByRole("menuitem", { name: /My drafts/ }));
  await waitFor(() => assert.equal(screen.getByRole("radio", { name: "Draft 1" }).getAttribute("aria-checked"), "true"));
  cleanup();

  renderWith(s, <CmsVersions collection="guide" slug="slack" />);
  await user.click(await screen.findByRole("button", { name: "Name this version" }));
  await user.type(await screen.findByLabelText("Version name"), "Launch copy");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
  await screen.findByText("Launch copy");
  await user.click(screen.getByRole("button", { name: "Pin" }));
  await screen.findByRole("button", { name: "Unpin" });
  const v = (await s.cms.versions(admin, "guide", "slack"))[0];
  assert.equal(v.label, "Launch copy");
  assert.equal(v.pinned, true);
  assert.deepEqual(await axeViolations(), []);
});

test("flow: on a phone the comments are a tab and the schedule panel opens upwards", async () => {
  setMobile(true);
  const s = makeServer();
  await s.cms.create(admin, "guide", { slug: "slack", title: "Connect Slack", body: BODY });
  await s.cms.addComment(agent, "guide", "slack", { body: "Check this", anchor: "connect" });
  renderWith(s, <CmsDocEditor collection="guide" slug="slack" presenceMs={0} onBack={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Comments 1" }));
  await screen.findByText("Check this");
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("button", { name: "Publish options" }));
  assert.ok(screen.getByRole("dialog", { name: "Schedule publishing" }).className.includes("bottom-full"));
});
