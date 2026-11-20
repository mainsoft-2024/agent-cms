/**
 * Plugins: a way for another package (or the app) to add to the CMS without changing it. A plugin
 * can listen to what happens, add routes under `/api/cms/<plugin name>/`, add agent tools, define
 * background jobs, put values into `GET /_me` and bring its own tables.
 *
 *   export const stats = definePlugin({
 *     name: "stats",
 *     setup(ctx) {
 *       ctx.on("doc.published", (e) => console.log("published", e.collection, e.slug));
 *       ctx.route("GET", "summary", async ({ actor, cms }) => Response.json({ n: (await cms.collections()).length }));
 *     },
 *   });
 *   createCms({ ..., plugins: [stats] });
 */
import type { z } from "zod";
import type { JobKind } from "./jobs";
import type { OutEvent } from "./outbox";
import type { Sealer } from "./secrets";
import type { Actor, WebhookEvent } from "./types";

export type CmsEvent = OutEvent;

export interface PluginRouteArgs<Cms = unknown> {
  req: Request;
  /** Who is calling, after the session or key check (may be anonymous: check it). */
  actor: Actor;
  /** Path segments after the plugin's name. */
  path: string[];
  url: URL;
  cms: Cms;
}

export interface PluginTool<Cms = unknown> {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  /** Scope a key needs. People need the matching permission on some collection. Default `read`. */
  scope?: "read" | "write" | "publish" | "admin";
  run(actor: Actor, input: any, cms: Cms): unknown | Promise<unknown>;
}

export interface PluginNav {
  label: string;
  href: string;
  /** Only for admins. Default false. */
  admin?: boolean;
}

export interface PluginContext<Cms = unknown> {
  /** The CMS the plugin was given to. Use it inside handlers, not during `setup`. */
  cms: Cms;
  /** Listen to an event (or `"*"` for all). Runs after the write, never blocks it; errors go to `onError`. */
  on(event: WebhookEvent | "*", fn: (e: CmsEvent) => void | Promise<void>): void;
  /** A route at `/api/cms/<plugin name>/<path>`. `path` is matched as a prefix; `""` is the plugin root. */
  route(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, handler: (a: PluginRouteArgs<Cms>) => Response | Promise<Response>): void;
  tool(tool: PluginTool<Cms>): void;
  /** A kind of background job. Its full name is `<plugin name>.<kind>`; `enqueue` takes the short one. */
  job<P = Record<string, unknown>>(kind: string, def: JobKind<P>): void;
  enqueue(kind: string, payload?: Record<string, unknown>, o?: { runAt?: Date | string }): Promise<unknown>;
  /** Values added to `GET /_me` under `plugins.<plugin name>` (what the admin screens read). */
  me(fn: (actor: Actor) => Record<string, unknown> | Promise<Record<string, unknown>>): void;
  /** A menu entry the admin shell shows (`_me.nav`). */
  nav(item: PluginNav): void;
  /** Seal and open values kept in the database. Null without `secretsKey`. */
  secrets: Sealer | null;
}

export interface CmsPlugin<Cms = any> {
  name: string;
  /** SQL the plugin's tables need, in order. Every statement must be safe to run again (`IF NOT EXISTS`). The CMS does not run it: `cms.plugins.sql` collects it for your migrations. */
  sql?: readonly string[];
  setup(ctx: PluginContext<Cms>): void;
}

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,30}$/;

export function definePlugin<Cms = any>(plugin: CmsPlugin<Cms>): CmsPlugin<Cms> {
  if (!PLUGIN_NAME.test(plugin.name)) throw new Error(`[agent-cms] plugin name "${plugin.name}" must be lowercase letters, digits and dashes (2 to 31 characters)`);
  return plugin;
}

export interface PluginRoute {
  plugin: string;
  method: string;
  path: string[];
  handler: (a: PluginRouteArgs<any>) => Response | Promise<Response>;
}
