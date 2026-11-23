// 0.22.0 forms: the public <CmsForm> (steps, conditions, errors and focus, 429)
// and the admin screens (build a form with a condition, see a submission,
// mark it spam, export).
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsForm } from "../cms/cms-form";
import { CmsFormEditor, CmsForms } from "../cms/cms-forms";
import { CmsShell } from "../cms/cms-shell";
import type { FormStep } from "@mainsoft/agent-cms/client";
import { setMobile } from "./setup";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

import { BASE } from "./server";

const STEPS: FormStep[] = [
  {
    title: "Contact",
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "email", label: "Email", kind: "email", required: true },
    ],
  },
  {
    title: "Question",
    fields: [
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
      {
        key: "version",
        label: "App version",
        kind: "text",
        required: true,
        showIf: { field: "topic", op: "eq", value: "bug" },
      },
      { key: "message", label: "Message", kind: "textarea" },
    ],
  },
];

async function contactServer() {
  const s = makeServer({ forms: true });
  await s.cms.forms.create(admin, {
    slug: "contact",
    title: "Contact us",
    enabled: true,
    steps: STEPS,
    settings: { successMessage: "Thanks, we got it." },
  });
  return s;
}

test("public form: steps with progress; errors are announced and focused; a conditional field appears and is sent only while shown", async () => {
  const s = await contactServer();
  const user = userEvent.setup();
  render(<CmsForm slug="contact" baseUrl={BASE} fetch={s.fetch} />);
  await screen.findByRole("heading", { name: "Contact us" });
  const bar = screen.getByRole("progressbar", { name: "Progress" });
  assert.equal(bar.getAttribute("aria-valuetext"), "Step 1 of 2");

  // Next with nothing filled: errors under the fields, focus on the first.
  await user.click(screen.getByRole("button", { name: "Next" }));
  const name = screen.getByLabelText(/^Name/);
  await waitFor(() => assert.ok(document.activeElement === name, "focus"));
  assert.equal(name.getAttribute("aria-invalid"), "true");
  const err = document.getElementById(
    name.getAttribute("aria-describedby")!.split(" ").pop()!,
  );
  assert.equal(err?.textContent, "Required");

  await user.type(name, "Kim");
  await user.type(screen.getByLabelText(/^Email/), "not-an-email");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Enter an e-mail address");
  await user.clear(screen.getByLabelText(/^Email/));
  await user.type(screen.getByLabelText(/^Email/), "kim@example.com");
  await user.click(screen.getByRole("button", { name: "Next" }));

  // Step 2: its heading gets focus; the conditional field is not there yet.
  const h = await screen.findByRole("heading", { name: "Question" });
  await waitFor(() => assert.ok(document.activeElement === h, "focus"));
  assert.ok(!screen.queryByLabelText(/^App version/));
  await user.selectOptions(screen.getByLabelText(/^Topic/), "bug");
  const version = await screen.findByLabelText(/^App version/);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.ok(document.activeElement === version, "focus"));
  assert.deepEqual(await axeViolations(), []);

  // Changing the topic hides it again; the value typed there is not sent.
  await user.type(version, "1.2.3");
  await user.selectOptions(screen.getByLabelText(/^Topic/), "price");
  await waitFor(() => assert.ok(!screen.queryByLabelText(/^App version/)));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Thanks, we got it.");
  const sent = s.requests.find(
    (r) => r.method === "POST" && r.path === "/forms/contact",
  );
  assert.deepEqual(sent?.body, {
    name: "Kim",
    email: "kim@example.com",
    topic: "price",
  });
  const { items } = await s.cms.forms.submissions(admin, "contact");
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "new");
});

test("public form: the spam trap is off screen, hidden from screen readers and out of the tab order", async () => {
  const s = await contactServer();
  const { container } = render(
    <CmsForm slug="contact" baseUrl={BASE} fetch={s.fetch} />,
  );
  await screen.findByRole("heading", { name: "Contact us" });
  const trap = container.querySelector<HTMLInputElement>(
    'input[name="_website"]',
  )!;
  assert.ok(trap);
  assert.equal(trap.tabIndex, -1);
  assert.equal(trap.getAttribute("autocomplete"), "off");
  const box = trap.closest("[aria-hidden]") as HTMLElement;
  assert.equal(box.getAttribute("aria-hidden"), "true");
  assert.equal(box.style.position, "absolute");
  assert.equal(box.style.left, "-10000px");
});

test("public form: the sixth try in a minute gets the wait message (429); a closed form says so", async () => {
  const s = await contactServer();
  // Five sent already from this address (the test handler sees no IP: one bucket for all).
  for (let i = 0; i < 5; i++)
    await s.cms.forms.submit(
      "contact",
      { name: "A", email: "a@example.com", topic: "price" },
      { ip: "unknown" },
    );
  const user = userEvent.setup();
  render(<CmsForm slug="contact" baseUrl={BASE} fetch={s.fetch} />);
  await screen.findByRole("heading", { name: "Contact us" });
  await user.type(screen.getByLabelText(/^Name/), "Kim");
  await user.type(screen.getByLabelText(/^Email/), "kim@example.com");
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Question" });
  await user.selectOptions(screen.getByLabelText(/^Topic/), "price");
  await user.click(screen.getByRole("button", { name: "Send" }));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Too many tries\. Wait \d+ seconds/);
  await waitFor(() => assert.ok(document.activeElement === alert, "focus"));
  cleanup();

  await s.cms.forms.update(admin, "contact", { enabled: false });
  s.session.user = null as never;
  render(<CmsForm slug="contact" baseUrl={BASE} fetch={s.fetch} />);
  await screen.findByText("This form is not taking answers now.");
  assert.ok(!screen.queryByRole("button", { name: "Try again" }));
});

test("public form: a load that fails can be tried again", async () => {
  const s = await contactServer();
  let fail = true;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fail
      ? Promise.reject(new TypeError("offline"))
      : s.fetch(input, init)) as typeof fetch;
  render(<CmsForm slug="contact" baseUrl={BASE} fetch={f} />);
  await screen.findByText("Could not load the form.");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Contact us" });
});

test("admin: make a form, add a field shown only for one choice, save; a submission shows, is marked spam and exported", async () => {
  const s = makeServer({ forms: true });
  const user = userEvent.setup();
  let opened = "";
  const list = renderWith(
    s,
    <CmsForms onOpenForm={(slug) => (opened = slug)} />,
  );
  await screen.findByText("No forms yet");
  await user.click(screen.getAllByRole("button", { name: "New form" })[0]);
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Name"), "Contact us");
  assert.equal(
    (within(dialog).getByLabelText("Address") as HTMLInputElement).value,
    "contact-us",
  );
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.equal(opened, "contact-us"));
  list.unmount();

  renderWith(s, <CmsFormEditor slug="contact-us" onBack={() => {}} />);
  await screen.findByRole("tab", { name: "Fields", selected: true });
  // Add a choice field, then a field shown only when it is "Bug".
  await user.click(screen.getByRole("button", { name: "Add field" }));
  const panel = screen.getByRole("complementary", { name: "Field settings" });
  const label = within(panel).getByLabelText("Label");
  await user.clear(label);
  await user.type(label, "Topic");
  await user.selectOptions(within(panel).getByLabelText("Kind"), "select");
  assert.equal(
    (within(panel).getByLabelText("Key") as HTMLInputElement).value,
    "topic",
  );
  const o1 = within(panel).getByLabelText("Option 1");
  await user.clear(o1);
  await user.type(o1, "Bug");
  await user.click(screen.getByRole("button", { name: "Add field" }));
  const label2 = within(
    screen.getByRole("complementary", { name: "Field settings" }),
  ).getByLabelText("Label");
  await user.clear(label2);
  await user.type(label2, "Screenshot note");
  const p2 = screen.getByRole("complementary", { name: "Field settings" });
  await user.selectOptions(
    within(p2).getByLabelText("Field it depends on"),
    "topic",
  );
  // The condition keeps the choice's stored value (made once; renaming the label never changes it).
  assert.equal(
    (within(p2).getByLabelText("Value") as HTMLSelectElement).value,
    "option_1",
  );
  // The list row says when it shows.
  assert.ok(
    screen.getByRole("listitem", {
      name: /Screenshot note · Short text · shown when Topic = Bug/,
    }),
  );
  // Alt+↑ moves the focused row (keyboard partner of dragging).
  const row = screen.getByRole("listitem", { name: /^Screenshot note/ });
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowUp", altKey: true });
  // Above the field it depends on, the condition is a problem and saving is refused.
  await screen.findByText(
    "The condition looks at a field that is not above this one",
  );
  const moved = screen.getByRole("listitem", { name: /^Screenshot note/ });
  moved.focus();
  fireEvent.keyDown(moved, { key: "ArrowDown", altKey: true });
  await waitFor(() =>
    assert.ok(
      !screen.queryByText(
        "The condition looks at a field that is not above this one",
      ),
    ),
  );
  assert.deepEqual(await axeViolations(), []);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Form saved");
  const saved = await s.cms.forms.get(admin, "contact-us");
  const keys = saved.steps.flatMap((x) => x.fields.map((f) => f.key));
  assert.deepEqual(keys, [
    "name",
    "email",
    "message",
    "topic",
    "screenshot_note",
  ]);
  assert.deepEqual(saved.steps[0].fields[4].showIf, {
    field: "topic",
    op: "eq",
    value: "option_1",
  });

  // Turn it on and receive one.
  await user.click(screen.getByRole("switch", { name: "Taking answers" }));
  await screen.findByText("The form takes answers now");
  await s.cms.forms.submit(
    "contact-us",
    {
      name: "Kim",
      email: "kim@example.com",
      message: "Saving twice",
      topic: "option_1",
      screenshot_note: "see",
    },
    { ip: "1.2.3.4" },
  );

  await user.click(screen.getByRole("tab", { name: /Submissions/ }));
  const cell = await screen.findByRole("button", { name: /Kim/ });
  await user.click(cell);
  const detail = await screen.findByRole("complementary", {
    name: "Submission",
  });
  await within(detail).findByText("Saving twice");
  await waitFor(async () =>
    assert.equal(
      (await s.cms.forms.submissions(admin, "contact-us")).items[0].status,
      "read",
    ),
  );
  await user.click(
    within(detail).getByRole("button", { name: "Mark as spam" }),
  );
  await screen.findByText("1 marked as spam");
  assert.equal(
    (await s.cms.forms.submissions(admin, "contact-us", { status: ["spam"] }))
      .items.length,
    1,
  );
  await screen.findByText("Nothing sent yet");
  await user.click(screen.getByRole("radio", { name: /Spam 1/ }));
  await screen.findByRole("button", { name: /Kim/ });

  // CSV: the export asks the server (and the audit log notes it).
  const clicks: string[] = [];
  const created = URL.createObjectURL;
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicks.push(this.download);
  };
  try {
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => assert.equal(clicks.length, 1));
    assert.match(clicks[0], /^contact-us-.*\.csv$/);
    assert.ok(
      s.requests.some((r) => r.path.startsWith("/forms/contact-us/export.csv")),
    );
  } finally {
    HTMLAnchorElement.prototype.click = orig;
    URL.createObjectURL = created;
  }
});

test("admin: forms off on the server, or no permission: the list says so; the shell shows Forms only when allowed", async () => {
  const off = makeServer();
  renderWith(off, <CmsForms onOpenForm={() => {}} />);
  await screen.findByText("Forms are off");
  cleanup();

  const on = makeServer({ forms: true });
  renderWith(
    on,
    <CmsShell title="T" basePath="/admin">
      {null}
    </CmsShell>,
  );
  await screen.findByRole("link", { name: "Forms" });
  cleanup();
  renderWith(
    off,
    <CmsShell title="T" basePath="/admin">
      {null}
    </CmsShell>,
  );
  await screen.findByRole("link", { name: /Guide/ });
  assert.ok(!screen.queryByRole("link", { name: "Forms" }));
});

test("admin: the embed dialog gives React, HTML and REST code to copy", async () => {
  const s = makeServer({ forms: true });
  // Plain HTML only works for a form without files and conditions (see forms-review.test.tsx).
  await s.cms.forms.create(admin, {
    slug: "contact",
    title: "Contact us",
    enabled: true,
    steps: [{ title: "", fields: STEPS.flatMap((x) => x.fields).filter((f) => !f.showIf) }],
  });
  const user = userEvent.setup();
  renderWith(s, <CmsFormEditor slug="contact" onBack={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "Embed" }));
  const dialog = await screen.findByRole("dialog");
  assert.match(
    within(dialog).getByLabelText("Code").textContent ?? "",
    /npx @mainsoft\/agent-cms add cms-form[\s\S]*<CmsForm slug="contact"/,
  );
  await user.click(within(dialog).getByRole("radio", { name: "HTML" }));
  const html = within(dialog).getByLabelText("Code").textContent ?? "";
  assert.match(
    html,
    /<form method="post" action="http:\/\/localhost\/api\/cms\/forms\/contact">/,
  );
  assert.match(html, /name="_website" tabindex="-1" autocomplete="off"/);
  assert.match(html, /<button type="submit">Send<\/button>/);
  await user.click(within(dialog).getByRole("radio", { name: "REST" }));
  assert.match(
    within(dialog).getByLabelText("Code").textContent ?? "",
    /curl -X POST/,
  );
  assert.deepEqual(await axeViolations(), []);
});
