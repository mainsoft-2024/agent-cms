// 0.22.0 review fixes for the form screens: drafts survive leaving (sessionStorage), edits made
// while saving stay, file fields on a server that takes no files, stable choice values and broken
// conditions, removing a field others depend on, the HTML embed, old attachments, the CSV scope,
// and the public form's upload group (focus, live region).
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsForm } from "../cms/cms-form";
import { CmsFormEditor } from "../cms/cms-forms";
import { CmsFormSubmissions } from "../cms/cms-form-submissions";
import { ko } from "../cms/cms-messages";
import type { FormStep, FormView, PublicForm } from "@mainsoft/agent-cms/client";
import { setMobile } from "./setup";
import { admin, axeViolations, makeServer, renderWith, type Server } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const STEPS: FormStep[] = [
  {
    title: "",
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "topic",
        label: "Topic",
        kind: "select",
        required: true,
        options: [
          { value: "bug", label: "Bug" },
          { value: "price", label: "Price" },
        ],
      },
      { key: "version", label: "App version", kind: "text", showIf: { field: "topic", op: "eq", value: "bug" } },
      { key: "note", label: "Note", kind: "textarea", showIf: { field: "topic", op: "filled" } },
    ],
  },
];

async function server(steps: FormStep[] = STEPS, o: { media?: boolean; enabled?: boolean } = {}) {
  const s = makeServer({ forms: true, media: o.media });
  await s.cms.forms.create(admin, { slug: "contact", title: "Contact us", enabled: o.enabled ?? false, steps });
  return s;
}

type User = ReturnType<typeof userEvent.setup>;
const panel = () => screen.getByRole("complementary", { name: "Field settings" });
const pick = async (user: User, name: RegExp) => user.click(await screen.findByRole("listitem", { name }));

test("form draft: unsaved edits stay in this tab; reopening offers to bring them back or discard them", async () => {
  const s = await server();
  const user = userEvent.setup();
  const first = renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^Name/);
  const label = within(panel()).getByLabelText("Label");
  await user.clear(label);
  await user.type(label, "Full name");
  // While edits are unsaved, a page change is refused (the router asks, Back included).
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  first.unmount();

  // Back again: the saved form shows, with the offer.
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await screen.findByText("There are unsaved changes to this form from before");
  assert.ok(screen.getByRole("listitem", { name: /^Name/ }));
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("button", { name: "Bring back" }));
  await screen.findByRole("listitem", { name: /^Full name/ });
  assert.ok(!screen.queryByText("There are unsaved changes to this form from before"));
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false);
  cleanup();

  // Discard: the kept edits go for good.
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "Discard" }));
  await screen.findByRole("listitem", { name: /^Name/ });
  cleanup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await screen.findByRole("listitem", { name: /^Name/ });
  assert.ok(!screen.queryByText("There are unsaved changes to this form from before"));
});

test("form draft: leaving through the screen's own dialog does not ask a second time, and drops the draft", async () => {
  const s = await server();
  const user = userEvent.setup();
  const asked: boolean[] = [];
  const onBack = () => {
    // What a router does before moving: ask the page.
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    asked.push(ev.defaultPrevented);
  };
  renderWith(s, <CmsFormEditor slug="contact" onBack={onBack} />);
  await pick(user, /^Name/);
  await user.type(within(panel()).getByLabelText("Label"), "!");
  await user.click(screen.getAllByRole("button", { name: "Forms" })[0]);
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Leave" }));
  assert.deepEqual(asked, [false]);
  assert.equal(window.sessionStorage.length, 0);
});

test("form tabs: switching Fields / Submissions / Settings keeps the draft and never asks", async () => {
  const s = await server();
  const user = userEvent.setup();
  function Host() {
    const [tab, setTab] = React.useState<"fields" | "submissions" | "settings">("fields");
    return <CmsFormEditor slug="contact" tab={tab} onTab={setTab} onBack={() => {}} />;
  }
  renderWith(s, <Host />);
  await pick(user, /^Name/);
  await user.type(within(panel()).getByLabelText("Label"), "!");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("tab", { name: /Submissions/ }));
  await user.click(screen.getByRole("tab", { name: "Fields" }));
  assert.ok(await screen.findByRole("listitem", { name: /^Name!/ }));
  assert.ok(!screen.queryByRole("dialog"));
});

test("form save: edits made while the save is on its way stay, and stay unsaved", async () => {
  const s = await server();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Server = {
    ...s,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "PUT") await gate;
      return s.fetch(input, init);
    }) as typeof fetch,
  };
  const user = userEvent.setup();
  renderWith(slow, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^Name/);
  const label = within(panel()).getByLabelText("Label");
  await user.clear(label);
  await user.type(label, "First");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Saving…" });
  // Typed while the request is out.
  await user.type(within(panel()).getByLabelText("Label"), " later");
  release();
  await screen.findByText("Form saved. What you changed while it was saving is not saved yet");
  assert.equal((within(panel()).getByLabelText("Label") as HTMLInputElement).value, "First later");
  assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false);
  assert.equal((await s.cms.forms.get(admin, "contact")).steps[0].fields[0].label, "First");
  // The next save goes through (it is based on the answer of the first: no conflict).
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Form saved");
  assert.equal((await s.cms.forms.get(admin, "contact")).steps[0].fields[0].label, "First later");
});

test("file fields on a server that takes no files: warned in the builder, unavailable in the preview, and turning on says why next to the switch", async () => {
  const s = await server([{ title: "", fields: [{ key: "name", label: "Name", kind: "text" }, { key: "cv", label: "CV", kind: "file", required: true }] }]);
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^CV/);
  assert.ok(within(panel()).getByText(/This server takes no files.*the form cannot be turned on/));
  assert.ok(screen.getByRole("listitem", { name: /^CV/ }).textContent?.includes("No uploads here"));
  await user.click(screen.getByRole("button", { name: "Preview" }));
  const preview = await screen.findByRole("dialog");
  assert.ok(within(preview).getByText("This form cannot take files on this site."));
  await user.keyboard("{Escape}");
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));

  await user.click(screen.getByRole("switch", { name: "Taking answers" }));
  const alert = await screen.findByText("Could not change whether it takes answers.");
  assert.match(alert.closest("[role=alert]")?.textContent ?? "", /cv/);
  assert.equal(screen.getByRole("switch", { name: "Taking answers" }).getAttribute("aria-checked"), "false");
  assert.equal((await s.cms.forms.get(admin, "contact")).enabled, false);

  // With a private store there is no warning.
  cleanup();
  const ok = await server([{ title: "", fields: [{ key: "cv", label: "CV", kind: "file" }] }], { media: true });
  renderWith(ok, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^CV/);
  assert.ok(!within(panel()).queryByText(/This server takes no files/));
});

test("choices: renaming keeps the stored value; a condition on a removed choice blocks saving with an inline error", async () => {
  const s = await server();
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^Topic/);
  const o1 = within(panel()).getByLabelText("Option 1");
  await user.clear(o1);
  await user.type(o1, "Bug report");
  await user.click(within(panel()).getByRole("button", { name: "Add option" }));
  // Conditions still match (shown with the new label).
  assert.ok(screen.getByRole("listitem", { name: /App version .*shown when Topic = Bug report/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Form saved");
  const saved = (await s.cms.forms.get(admin, "contact")).steps[0].fields[1].options;
  assert.deepEqual(saved?.map((o) => o.value), ["bug", "price", "option_3"]);
  assert.equal(saved?.[0].label, "Bug report");

  // Remove the choice the condition looks for.
  await pick(user, /^Topic/);
  await user.click(within(panel()).getByRole("button", { name: "Remove option Bug report" }));
  const row = await screen.findByRole("listitem", { name: /^App version.*a choice Topic does not have any more/ });
  await user.click(row);
  assert.ok(within(panel()).getByText("The condition looks for a choice Topic does not have any more"));
  assert.equal((within(panel()).getByLabelText("Value") as HTMLSelectElement).value, "");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Fix 1 marked fields first");
  assert.equal((await s.cms.forms.get(admin, "contact")).steps[0].fields[1].options?.length, 3);
  // Picking a value that exists fixes it.
  await user.selectOptions(within(panel()).getByLabelText("Value"), "price");
  await waitFor(() => assert.ok(!within(panel()).queryByText(/does not have any more/)));
});

test("removing a field other fields depend on lists them and asks; Cancel keeps all", async () => {
  const s = await server();
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await pick(user, /^Topic/);
  await user.click(within(panel()).getByRole("button", { name: "Remove field" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Topic?" });
  assert.ok(within(dialog).getByText(/2 fields are shown on a condition about it/));
  assert.ok(within(dialog).getByText("App version"));
  assert.ok(within(dialog).getByText("Note"));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("dialog")));
  assert.ok(screen.getByRole("listitem", { name: /^Topic/ }));
  assert.ok(screen.getByRole("listitem", { name: /App version .*shown when/ }));

  await user.click(within(panel()).getByRole("button", { name: "Remove field" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove field and conditions" }));
  await waitFor(() => assert.ok(!screen.queryByRole("listitem", { name: /^Topic/ })));
  assert.ok(!screen.queryByRole("listitem", { name: /shown when/ }));

  // A field nothing depends on goes at once.
  await pick(user, /^Name/);
  await user.click(within(panel()).getByRole("button", { name: "Remove field" }));
  await waitFor(() => assert.ok(!screen.queryByRole("listitem", { name: /^Name/ })));
  assert.ok(!screen.queryByRole("dialog"));
});

test("embed: plain HTML for a form with conditions or files says why and points to React, with nothing to copy", async () => {
  const s = await server([{ title: "", fields: [...STEPS[0].fields, { key: "cv", label: "CV", kind: "file" }] }]);
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "Embed" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("radio", { name: "HTML" }));
  assert.ok(within(dialog).getByText("This form cannot be sent with plain HTML"));
  assert.ok(within(dialog).getByText(/plain HTML form cannot upload files/));
  assert.ok(within(dialog).getByText(/fields shown on a condition/));
  assert.ok(!within(dialog).queryByLabelText("Code"));
  assert.ok(!within(dialog).queryByRole("button", { name: /Copy/ }));
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByRole("button", { name: "Use the React component" }));
  assert.match(within(dialog).getByLabelText("Code").textContent ?? "", /<CmsForm slug="contact"/);
});

test("embed: the HTML button says the screens' word for Send", async () => {
  const s = await server([{ title: "", fields: [{ key: "name", label: "Name", kind: "text" }] }]);
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />, { messages: ko });
  await user.click(await screen.findByRole("button", { name: ko.fm_embed }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("radio", { name: "HTML" }));
  assert.match(within(dialog).getByLabelText(ko.fm_embed_code).textContent ?? "", new RegExp(`<button type="submit">${ko.cf_send}</button>`));
});

test("submissions: files of a field removed since still open, under the field's key", async () => {
  const s = await server();
  const form = await s.cms.forms.get(admin, "contact");
  const item = {
    id: "sub1",
    formId: form.id,
    formVersion: 1,
    data: { name: "Kim", resume: [{ id: "f1", name: "cv.pdf", size: 2048, mime: "application/pdf" }] },
    files: [{ field: "resume", id: "f1", name: "cv.pdf", size: 2048, mime: "application/pdf" }],
    status: "read",
    userAgent: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const opened: string[] = [];
  const fake: Server = {
    ...s,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/forms\/contact\/submissions\?/.test(url))
        return Response.json({ items: [item], total: 1, counts: { new: 0, read: 1, spam: 0, archived: 0 } });
      if (/\/submissions\/sub1\/files\/f1$/.test(url)) {
        opened.push(url);
        return Response.json({ url: "https://files.example.com/cv.pdf", name: "cv.pdf", expiresAt: new Date().toISOString() });
      }
      return s.fetch(input, init);
    }) as typeof fetch,
  };
  const open = window.open;
  window.open = (() => null) as typeof window.open;
  try {
    const user = userEvent.setup();
    renderWith(fake, <CmsFormSubmissions form={form as FormView} />);
    await user.click(await screen.findByRole("button", { name: /Kim/ }));
    const detail = await screen.findByRole("complementary", { name: "Submission" });
    assert.ok(within(detail).getByText("resume"));
    await user.click(within(detail).getByRole("button", { name: /cv\.pdf/ }));
    await waitFor(() => assert.equal(opened.length, 1));
  } finally {
    window.open = open;
  }
});

test("CSV: says what it takes and takes the box and search on screen", async () => {
  const s = await server(STEPS, { enabled: true });
  await s.cms.forms.submit("contact", { name: "Kim", topic: "price" }, { ip: "1.2.3.4" });
  await s.cms.forms.submit("contact", { name: "Lee", topic: "price" }, { ip: "1.2.3.5" });
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" tab="submissions" onBack={() => {}} />);
  await screen.findByText("The CSV has what is shown: Inbox, 2");
  await user.type(screen.getByRole("searchbox"), "Kim");
  await screen.findByText("The CSV has what is shown: Inbox matching “Kim”, 1");
  const created = URL.createObjectURL;
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {};
  try {
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => assert.ok(s.requests.some((r) => r.path.startsWith("/forms/contact/export.csv"))));
    const req = s.requests.find((r) => r.path.startsWith("/forms/contact/export.csv"))!;
    const q = new URL(req.path, "http://x").searchParams;
    assert.equal(q.get("status"), "new,read");
    assert.equal(q.get("q"), "Kim");
  } finally {
    HTMLAnchorElement.prototype.click = click;
    URL.createObjectURL = created;
  }
  // An empty box has nothing to download.
  await user.click(screen.getByRole("radio", { name: /Spam 0/ }));
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled, true));
});

test("public form: a required file field that cannot take a file gets focus on its group; failed uploads are announced", async () => {
  const form: PublicForm = {
    slug: "apply",
    title: "Apply",
    version: 1,
    honeypot: "_website",
    successMessage: "",
    uploads: false,
    steps: [{ title: "", fields: [{ key: "cv", label: "CV", kind: "file", required: true }] }],
  };
  const user = userEvent.setup();
  const { rerender } = render(<CmsForm slug="apply" form={form} preview />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  const group = await screen.findByRole("group", { name: /CV/ });
  await waitFor(() => assert.ok(document.activeElement === group, `focus on ${document.activeElement?.tagName}#${document.activeElement?.id}`));
  assert.equal(group.getAttribute("aria-invalid"), "true");
  assert.match(group.getAttribute("aria-describedby") ?? "", /err/);

  rerender(<CmsForm slug="apply" form={{ ...form, uploads: true, steps: [{ title: "", fields: [{ key: "cv", label: "CV", kind: "file", accept: ["application/pdf"] }] }] }} preview />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "run.exe", { type: "application/x-msdownload" })] } });
  const live = await waitFor(() => {
    const el = [...document.querySelectorAll('[aria-live="polite"]')].find((x) => /run\.exe not uploaded/.test(x.textContent ?? ""));
    assert.ok(el);
    return el;
  });
  assert.match(live.textContent ?? "", /This type is not taken/);
});

