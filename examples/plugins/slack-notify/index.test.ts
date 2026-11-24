import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestCms } from "@mainsoft/agent-cms/testing";
import slackNotify from "./index";

const HOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

/** A fetch that records what was posted and answers `status`. */
function fakeFetch(status = 200) {
  const posts: { url: string; body: { channel: string; text: string } }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("ok", { status });
  }) as typeof fetch;
  return { fn, posts };
}

test("slack-notify: without a webhook it does not start; saving one starts it", async () => {
  const t = createTestCms({ plugins: [slackNotify] });
  try {
    await t.ready(); // not `required`: the CMS goes on without it
    const before = t.cms.plugins.get("slack-notify");
    assert.equal(before?.state, "failed");
    assert.match(before?.error ?? "", /webhookUrl/);

    // Not Slack's host: start refuses it.
    await t.settings("slack-notify", { webhookUrl: "https://example.com/hook" });
    assert.equal(t.cms.plugins.get("slack-notify")?.state, "failed");
    assert.match(t.cms.plugins.get("slack-notify")?.error ?? "", /hooks\.slack\.com/);

    await t.settings("slack-notify", { webhookUrl: HOOK });
    assert.equal(t.cms.plugins.get("slack-notify")?.state, "running");

    // The admin screen gets a mask for the secret, and the default channel.
    const view = (await t.client().pluginSettings("slack-notify")).settings;
    assert.equal(view?.values.webhookUrl, "••••••••");
    assert.equal(view?.values.channel, "#general");
  } finally {
    await t.close();
  }
});

test("slack-notify: an automation posts when a document is published", async () => {
  const slack = fakeFetch();
  const t = createTestCms({ plugins: [slackNotify({ fetch: slack.fn })] });
  try {
    await t.settings("slack-notify", { webhookUrl: HOOK, channel: "#news" });
    const auto = await t.cms.automations.create(t.admin, {
      name: "Tell the team",
      trigger: { event: "doc.published", collection: "pages" },
      actions: [{ type: "slack-notify.post" }],
    });
    await t.cms.create(t.admin, "pages", { slug: "launch", title: "Launch", body: "We are live\n" }, { publish: true });
    await t.cron();

    assert.equal(slack.posts.length, 1);
    assert.equal(slack.posts[0].url, HOOK);
    assert.equal(slack.posts[0].body.channel, "#news");
    assert.match(slack.posts[0].body.text, /Tell the team: doc\.published “Launch” \(pages\/launch\)/);
    const [run] = await t.cms.automations.runs(t.admin, auto.id);
    assert.equal(run.state, "ok");
  } finally {
    await t.close();
  }
});

test("slack-notify: Slack refusing marks the run failed", async () => {
  const slack = fakeFetch(500);
  const t = createTestCms({ plugins: [slackNotify({ fetch: slack.fn })] });
  try {
    await t.settings("slack-notify", { webhookUrl: HOOK });
    const auto = await t.cms.automations.create(t.admin, { name: "Tell", trigger: { event: "doc.published", collection: null }, actions: [{ type: "slack-notify.post" }] });
    await t.cms.create(t.admin, "pages", { slug: "x", title: "X", body: "x\n" }, { publish: true });
    await t.cron();
    const [run] = await t.cms.automations.runs(t.admin, auto.id);
    assert.equal(run.state, "failed");
    assert.match(JSON.stringify(run), /Slack answered 500/);
  } finally {
    await t.close();
  }
});
