/**
 * slack-notify: an automation action that posts to a Slack channel.
 *
 *   import slackNotify from "./plugins/slack-notify";
 *   createCms({ ..., secretsKey: process.env.CMS_SECRETS_KEY, plugins: [slackNotify()] });
 *
 * The webhook address is a setting: an admin pastes it on the Plugins screen, it is sealed with
 * `secretsKey` and never sent back. Then an automation (Automations screen) runs the action
 * "Post to Slack" (`slack-notify.post`) on the events it picks, e.g. `doc.published`.
 *
 * `start` checks the settings: without a webhook, or with one that is not Slack's, the plugin
 * shows as failed with the reason, and saving the settings starts it again.
 */
import { definePlugin } from "@mainsoft/agent-cms";
import { z } from "zod";

const settings = z.object({
  webhookUrl: z.string().url().describe("secret: Slack webhook URL"),
  channel: z.string().regex(/^#?[\w-]{1,80}$/).default("#general").describe("Channel"),
});
type Settings = z.infer<typeof settings>;

export default definePlugin({
  name: "slack-notify",
  version: "1.0.0",
  engine: ">=0.24",
  options: z.object({
    /** Hosts a webhook may point at. Default: Slack's. */
    hosts: z.array(z.string()).default(["hooks.slack.com"]),
    /** The fetch to post with (tests give their own). */
    fetch: z.custom<typeof fetch>((v) => typeof v === "function").optional(),
  }),
  settings,
  start(ctx, options) {
    // Runs after the settings were checked against the schema (a missing webhook fails before this).
    const url = new URL(ctx.settings<Settings>().webhookUrl);
    if (url.protocol !== "https:") throw new Error("the webhook must be an https address");
    if (!options.hosts.includes(url.hostname)) throw new Error(`the webhook must be on ${options.hosts.join(" or ")}`);
  },
  setup(ctx, options) {
    ctx.automationAction("post", {
      label: "Post to Slack",
      async run({ automation, event, doc }) {
        const s = ctx.settings<Settings>();
        const what = doc ? `“${doc.title}” (${event.collection}/${event.slug})` : event.event;
        const text = `${automation.name}: ${event.event} ${what}${"url" in event && event.url ? ` ${event.url}` : ""}`;
        const res = await (options.fetch ?? fetch)(s.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: s.channel, text }),
          signal: AbortSignal.timeout(10_000),
        });
        // Throwing marks the automation run as failed, with this message.
        if (!res.ok) throw new Error(`Slack answered ${res.status}`);
        return `posted to ${s.channel}`;
      },
    });
  },
});
