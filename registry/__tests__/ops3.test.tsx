// 0.14.0 on the keys screen: a key's own limits, and rotation with a grace time.
import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CmsKeys } from "../cms/cms-keys";
import { ko } from "../cms/cms-messages";
import { admin, axeViolations, makeServer, renderWith } from "./server";

afterEach(() => cleanup());

test("keys: a key with its own limit and addresses; rotating shows the new secret and the old one works for an hour", async () => {
  const s = makeServer();
  const user = userEvent.setup();
  renderWith(s, <CmsKeys />);
  await user.click(await screen.findByRole("button", { name: "New key" }));
  const dialog = await screen.findByRole("dialog", { name: "New key" });
  await user.type(within(dialog).getByLabelText("Name"), "deploy");
  await user.type(within(dialog).getByLabelText("Requests per minute"), "60");
  await user.type(within(dialog).getByLabelText("Allowed addresses"), "203.0.113.0/24, 2001:db8::/32");
  assert.deepEqual(await axeViolations(), []);
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  // The secret is masked until Show is pressed.
  await user.click(within(await screen.findByRole("dialog", { name: "deploy" })).getAllByRole("button", { name: "Show" })[0]);
  const first = within(await screen.findByRole("dialog", { name: "deploy" })).getAllByText(/^sgk_[^•]+$/)[0].textContent ?? "";
  await user.click(within(screen.getByRole("dialog", { name: "deploy" })).getAllByRole("button", { name: "Close" })[0]);
  await screen.findByText("60 per minute · 203.0.113.0/24 · 2001:db8::/32");
  const made = (await s.cms.listKeys(admin))[0];
  assert.deepEqual([made.rateLimit, made.allowedIps], [60, ["203.0.113.0/24", "2001:db8::/32"]]);

  // An address that is not one is refused with the reason, and the form stays.
  await user.click(screen.getByRole("button", { name: "New key" }));
  const again = await screen.findByRole("dialog", { name: "New key" });
  await user.type(within(again).getByLabelText("Name"), "bad");
  await user.type(within(again).getByLabelText("Allowed addresses"), "the-office");
  await user.click(within(again).getByRole("button", { name: "Create" }));
  await within(again).findByText("Not an address or range: the-office");
  await user.click(within(again).getByRole("button", { name: "Cancel" }));

  await user.click(screen.getByRole("button", { name: "Rotate: deploy" }));
  const confirm = await screen.findByRole("dialog", { name: "Make a new secret for “deploy”?" });
  assert.match(confirm.textContent ?? "", /keeps working for one hour/);
  await user.click(within(confirm).getByRole("button", { name: "Rotate" }));
  await user.click(within(await screen.findByRole("dialog", { name: "deploy" })).getAllByRole("button", { name: "Show" })[0]);
  const second = within(await screen.findByRole("dialog", { name: "deploy" })).getAllByText(/^sgk_[^•]+$/)[0].textContent ?? "";
  assert.ok(second.startsWith("sgk_") && second !== first);
  await user.click(within(screen.getByRole("dialog", { name: "deploy" })).getAllByRole("button", { name: "Close" })[0]);

  // Two rows now: the new key can be rotated again, the old one says until when it works.
  await waitFor(() => assert.equal(screen.getAllByText("deploy").length, 2));
  assert.equal(screen.getAllByRole("button", { name: "Rotate: deploy" }).length, 1);
  await screen.findByText(/^Works until /);
  assert.equal(screen.getAllByText("60 per minute · 203.0.113.0/24 · 2001:db8::/32").length, 2, "the limits came along");
  assert.ok((await s.cms.authenticateKey(first)) && (await s.cms.authenticateKey(second)), "both secrets work during the grace time");
  assert.deepEqual(await axeViolations(), []);

  // Revoking the old one now ends the grace time; the badge says it was replaced.
  const oldRow = screen.getByText(/^Works until /).closest("tr")!;
  await user.click(within(oldRow).getByRole("button", { name: "Revoke: deploy" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke" }));
  await screen.findByText("Replaced");
  assert.equal(await s.cms.authenticateKey(first), null);
});

test("keys: Korean strings for limits and rotation", async () => {
  const s = makeServer();
  await s.cms.createKey(admin, { name: "배포", scopes: ["read"], rateLimit: 30 });
  renderWith(s, <CmsKeys />, { messages: ko });
  await screen.findByText("분당 30회");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "교체: 배포" }));
  const confirm = await screen.findByRole("dialog", { name: "“배포”의 새 시크릿을 만들지 확인" });
  assert.match(confirm.textContent ?? "", /1시간 동안 계속 동작/);
});

test("field form: a field this person cannot change shows its value as text with a lock, and no control", async () => {
  const { CmsFieldForm } = await import("../cms/cms-field-form");
  const s = makeServer();
  const schema = {
    slug: "products",
    label: "Products",
    fields: { type: "object", properties: { price: { type: "number" }, note: { type: "string" } } },
    categories: [],
    fieldRules: { hidden: ["secret"], readOnly: ["price"] },
  } as never;
  renderWith(s, <CmsFieldForm schema={schema} value={{ title: "Mug", slug: "mug", summary: "", body: "", category: null, keywords: [], fields: { price: 12, note: "" } } as never} onChange={() => {}} />);
  const group = await screen.findByRole("group", { name: "price" });
  assert.ok(within(group).getByText("12"));
  assert.ok(within(group).getByText("Read-only for you"));
  assert.ok(group.querySelector("input") === null, "no input for a read-only field");
  assert.ok(screen.getByLabelText("note"), "other fields stay editable");
});
