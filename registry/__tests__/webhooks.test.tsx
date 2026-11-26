import "./setup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { definePlugin } from "@mainsoft/agent-cms/plugin";
import { ko } from "../cms/cms-messages";
import { CmsShell } from "../cms/cms-shell";
import { CmsWebhooks } from "../cms/cms-webhooks";
import { setMobile } from "./setup";
import { admin, axeViolations, editor2, makeServer, renderWith } from "./server";

afterEach(() => {
  cleanup();
  setMobile(false);
});

test("webhooks: create shows the secret; test, a failed delivery sent again, edit, turn on, delete", async () => {
  const s = makeServer({ webhooks: true });
  const user = userEvent.setup();
  renderWith(s, <CmsWebhooks />);
  await screen.findByText("No webhooks yet.");

  // The header's button (the empty state has one too).
  await user.click(screen.getAllByRole("button", { name: "New webhook" })[0]);
  const dlg = await screen.findByRole("dialog");
  await user.type(within(dlg).getByLabelText("Name"), "Site cache");
  await user.type(within(dlg).getByLabelText("Address"), "https://intranet.example/hook");
  // "Every event" is the default; choosing events is an explicit step.
  await user.click(within(dlg).getByRole("radio", { name: "Only these" }));
  assert.equal((within(dlg).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled, true, "nothing picked yet");
  await user.click(within(dlg).getByRole("checkbox", { name: "Publish" }));
  await user.click(within(dlg).getByRole("checkbox", { name: "Guide" }));
  await user.click(within(dlg).getByRole("button", { name: "Create" }));
  await within(dlg).findByText(/This address cannot be used/);
  await user.clear(within(dlg).getByLabelText("Address"));
  await user.type(within(dlg).getByLabelText("Address"), "https://hooks.example/cms");
  await user.click(within(dlg).getByRole("button", { name: "Create" }));

  const made = await screen.findByRole("dialog", { name: "“Site cache” is ready" });
  // Masked until "Show" (someone may be looking over the shoulder).
  assert.ok(within(made).queryByText(/^whsec_[A-Za-z0-9_-]{20,}$/) === null);
  await user.click(within(made).getAllByRole("button", { name: "Show" })[0]);
  const secret = within(made).getByText(/^whsec_[A-Za-z0-9_-]{20,}$/).textContent ?? "";
  await user.click(within(made).getAllByRole("button", { name: "Close" })[0]);

  // The row and its panel.
  const row = (await screen.findByRole("button", { name: "Site cache" })).closest("tr")!;
  assert.match(row.textContent ?? "", /https:\/\/hooks\.example\/cms.*Publish.*Working/);
  const panel = screen.getByRole("complementary", { name: "Site cache" });
  await within(panel).findByText("Nothing has been sent yet.");
  assert.ok(within(panel).queryByText(/^whsec_[A-Za-z0-9_-]{20,}$/) === null, "the secret is hidden until asked for");
  await user.click(within(panel).getByRole("button", { name: "Show" }));
  // The secret asked for is shown at once, and focus moves to the button that hides it again.
  await waitFor(() => assert.equal((document.activeElement as HTMLElement | null)?.textContent, "Hide"));
  assert.equal((await within(panel).findByText(/^whsec_[A-Za-z0-9_-]{20,}$/)).textContent, secret, "the same secret as at creation");

  await user.click(within(panel).getByRole("button", { name: "Send a test" }));
  await within(panel).findByText(/The address answered in \d+ ms\./);
  assert.deepEqual(s.hooks.sent, [{ url: "https://hooks.example/cms", event: "ping" }]);

  // A publish that the address refuses, then "send again".
  s.hooks.answer = 500;
  await s.cms.create(admin, "guide", { slug: "a", title: "A", body: "x\n" }, { publish: true });
  await new Promise((r) => setTimeout(r, 10));
  await s.cms.cron();
  await user.click(within(panel).getByRole("button", { name: "Send a test" }));
  await within(panel).findByText("The test failed: 500");
  const log = within(panel).getByRole("list", { name: "Deliveries" });
  await waitFor(() => assert.equal(within(log).getAllByRole("listitem").length, 3));
  const failed = within(log).getAllByRole("listitem").find((li) => /Publish, a/.test(li.textContent ?? ""))!;
  assert.match(failed.textContent ?? "", /^Refused500Publish, a/);
  await waitFor(() => assert.match(row.textContent ?? "", /\d failed/));
  s.hooks.answer = 200;
  await user.click(within(failed).getByRole("button", { name: "Send again" }));
  await within(panel).findByText("Queued. It goes out with the next cron call.");
  await s.cms.cron();
  assert.equal(s.hooks.sent.filter((x) => x.event === "doc.published").length, 2);
  assert.deepEqual(await axeViolations(), []);

  // Edit.
  await user.click(within(panel).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("dialog", { name: "Edit webhook" });
  assert.equal((within(edit).getByRole("checkbox", { name: "Publish" }) as HTMLElement).getAttribute("aria-checked"), "true");
  await user.clear(within(edit).getByLabelText("Name"));
  await user.type(within(edit).getByLabelText("Name"), "Cache");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Cache" });

  // Switched off by the CMS: the reason and a way back.
  const [hook] = await s.cms.webhooks.list(admin);
  await s.cms.repo.updateWebhook(hook.id, { enabled: false, disabledReason: "20 failed deliveries in a row. The last one: answered 500", updatedAt: new Date().toISOString() });
  await user.click(screen.getByRole("button", { name: "Cache" }));
  await user.click(await screen.findByRole("button", { name: "Cache" }));
  const off = await screen.findByRole("complementary", { name: "Cache" });
  await within(off).findByText(/Turned off automatically: 20 failed deliveries/);
  await user.click(within(off).getByRole("button", { name: "Turn on" }));
  await within(off).findByText("Turned on.");
  await waitFor(() => assert.ok(within(off).queryByRole("button", { name: "Turn on" }) === null));

  await user.click(within(off).getByRole("button", { name: "Delete" }));
  const confirm = await screen.findByRole("dialog", { name: "Delete “Cache”?" });
  assert.match(confirm.textContent ?? "", /Its delivery history goes with it\./);
  await user.click(within(confirm).getByRole("button", { name: "Delete" }));
  await screen.findByText("No webhooks yet.");
});

test("webhooks: without secretsKey the screen says what is missing; Korean, phone", async () => {
  const bare = makeServer();
  renderWith(bare, <CmsWebhooks />);
  await screen.findByText(/Webhooks need `secretsKey` in createCms/);
  assert.equal((screen.getAllByRole("button", { name: "New webhook" })[0] as HTMLButtonElement).disabled, true);
  cleanup();

  setMobile(true);
  const s = makeServer({ webhooks: true });
  await s.cms.webhooks.create(admin, { name: "채팅 알림", url: "https://hooks.example/chat", events: ["doc.published", "review.requested"] });
  renderWith(s, <CmsWebhooks />, { messages: ko });
  const row = (await screen.findByRole("button", { name: "채팅 알림" })).closest("tr")!;
  assert.match(row.textContent ?? "", /정상/);
  await userEvent.setup().click(screen.getByRole("button", { name: "채팅 알림" }));
  const panel = await screen.findByRole("complementary", { name: "채팅 알림" });
  assert.ok(within(panel).getByRole("button", { name: "시험 전송" }));
  assert.ok(within(panel).getByText("아직 보낸 기록이 없습니다."));
  assert.deepEqual(await axeViolations(), []);
});

test("shell: the webhooks entry is for admins with a key set; plugins add their own entries", async () => {
  const stats = definePlugin({
    name: "stats",
    setup(ctx) {
      ctx.nav({ label: "Stats", href: "/admin/stats" });
      ctx.nav({ label: "Stats settings", href: "/admin/stats/settings", admin: true });
    },
  });
  const s = makeServer({ webhooks: true, plugins: [stats] });
  const view = renderWith(s, <CmsShell title="Site" activeHref="/admin/stats"><p>content</p></CmsShell>);
  const nav = await screen.findByRole("navigation", { name: "Admin navigation" });
  assert.equal((await within(nav).findByRole("link", { name: "Webhooks" })).getAttribute("href"), "/admin/webhooks");
  const added = within(nav).getByRole("list", { name: "Extensions" });
  assert.deepEqual(within(added).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]), [["Stats", "/admin/stats", "page"], ["Stats settings", "/admin/stats/settings", null]]);
  assert.deepEqual(await axeViolations(), []);
  view.unmount();

  s.session.user = { ...editor2, isAdmin: false };
  renderWith(s, <CmsShell title="Site"><p>content</p></CmsShell>);
  const nav2 = await screen.findByRole("navigation", { name: "Admin navigation" });
  await within(nav2).findByRole("link", { name: "Stats" });
  assert.ok(within(nav2).queryByRole("link", { name: "Webhooks" }) === null);
  assert.ok(within(nav2).queryByRole("link", { name: "Stats settings" }) === null);
});
