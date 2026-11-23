// An in-memory agent-cms (the real core and REST handler) behind a fake
// fetch, plus a render helper that wraps screens in <CmsProvider>.
import * as React from "react";
import { z } from "zod";
import { render, type RenderResult } from "@testing-library/react";
import axe from "axe-core";
import { createCms, defineCollection, defineSingle } from "../../src/cms";
import { relation } from "../../src/fields";
import { createCmsHandler } from "../../src/http";
import { MemoryRepo } from "../../src/repo";
import type { Actor } from "../../src/types";
import { CmsProvider, type CmsSlots } from "../cms/use-cms";
import { MemoryStorage } from "@mainsoft/agent-cms/storage";
import type { CmsMessages } from "../cms/cms-messages";

export const BASE = "http://localhost/api/cms";
export const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Admin", isAdmin: true };
export const agent: Actor = { kind: "key", id: "k-agent", label: "docs-agent", scopes: ["read", "write"], collections: null };

function tinyPng(): Uint8Array {
  const bytes = new Uint8Array(200);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 32, 0, 0, 2, 88]);
  return bytes;
}

export const editor2: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u2", label: "Park", isAdmin: true };

export function makeServer(o: { previewSecret?: string | null; media?: boolean; review?: { agents?: "required"; everyone?: "required" }; timeZone?: string; trashDays?: number; stripMetadata?: boolean; webhooks?: boolean; plugins?: Parameters<typeof createCms>[0]["plugins"]; users?: boolean; codedWrite?: boolean; model?: boolean; forms?: Parameters<typeof createCms>[0]["forms"] } = {}) {
  /** Who the browser is signed in as (tests switch it). */
  const session = { user: admin };
  /** What the outside address answers to a webhook (tests change it), and what it was sent. */
  const hooks = { answer: 200 as number, sent: [] as { url: string; event: string | null }[] };
  const stores = { public: new MemoryStorage({ name: "public", publicUrl: "https://cdn.example.com" }), private: new MemoryStorage({ name: "private" }) };
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    categories: ["start", "integrations"],
    url: (d) => `/guide/${d.slug}`,
    review: o.review,
    fields: z.object({
      plans: z.array(z.enum(["free", "pro", "team"])).optional(),
      featured: z.boolean().optional(),
      order: z.number().int().min(0).max(100).optional(),
      audience: z.enum(["everyone", "admins"]).optional(),
      tags: z.array(z.string()).optional(),
      ...(o.media ? { cover: z.string().optional() } : {}),
    }),
    admin: { fields: { plans: { label: "Plans", help: "Who sees this" }, order: { label: "Order", help: "0 to 100" }, ...(o.media ? { cover: { label: "Cover", widget: "image" as const } } : {}) } },
  });
  const notices = defineCollection({ slug: "notices", label: "Notices", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous", ...(o.codedWrite ? { write: ({ actor }: { actor: Actor }) => actor.kind === "user" && !!actor.isAdmin } : {}) } });
  // 0.21.0 content model (only with `model: true`, so other screens see the two collections they expect):
  // a tree with templates and relations, the people it points at, a single, and redirects on.
  const team = defineCollection({ slug: "team", label: "Team", visibility: "public", url: (d) => `/team/${d.slug}` });
  const docs = defineCollection({
    slug: "docs",
    label: "Docs",
    visibility: "public",
    tree: { maxDepth: 3 },
    url: (d) => `/docs/${d.slug}`,
    fields: z.object({ author: relation("team").optional() }),
    admin: { fields: { author: { label: "Author" } } },
    templates: [{ key: "howto", label: "How-to", title: "How to …", body: "## Before you start\n\n## Steps" }],
  });
  const site = defineSingle({ slug: "site", label: "Site settings", visibility: "public", fields: z.object({ name: z.string().default("My site"), footer: z.string().default("") }) });
  /** The people the app knows (for the roles screen's search). */
  const people = [{ id: "u7", label: "Park Jiwoo" }, { id: "u8", label: "Lee Minho" }];
  const notified: string[] = [];
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: o.model ? ([guide, notices, team, docs, site] as const) : ([guide, notices] as const),
    redirects: o.model ? true : undefined,
    forms: o.forms,
    previewSecret: o.previewSecret === null ? undefined : (o.previewSecret ?? "x".repeat(40)),
    warn: () => {},
    schemaCheck: false,
    timeZone: o.timeZone,
    secretsKey: o.webhooks ? "s".repeat(40) : undefined,
    plugins: o.plugins,
    cronSecret: "c".repeat(32),
    automations: { actions: { notify: (c) => void notified.push(`${c.automation.name}:${c.doc?.slug ?? "-"}`) } },
    users: o.users ? { search: (q: string) => people.filter((p) => p.label.toLowerCase().includes(q.toLowerCase())), get: (id: string) => people.find((p) => p.id === id) ?? null } : undefined,
    webhooks: {
      resolveHost: async (host: string) => (host === "intranet.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        hooks.sent.push({ url: String(input), event: new Headers(init?.headers).get("x-cms-event") });
        return new Response(null, { status: hooks.answer });
      }) as typeof fetch,
    },
    trash: o.trashDays === undefined ? undefined : { days: o.trashDays },
    media: o.media
      ? {
          stores: { public: { visibility: "public", adapter: stores.public }, private: { visibility: "private", adapter: stores.private } },
          stripMetadata: o.stripMetadata,
          // Imports from a URL: every host is "public" and answers with a small PNG.
          resolveHost: async (host: string) => (host === "intranet.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
          fetch: (async () => new Response(tinyPng() as BodyInit, { headers: { "content-type": "image/png" } })) as typeof fetch,
        }
      : undefined,
  });
  /** Put a small PNG into the library the way a browser would. */
  const addFile = async (name: string, more: { folder?: string; store?: string; alt?: string; tags?: string[] } = {}) => {
    const bytes = new Uint8Array(200);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 176, 0, 0, 2, 118]);
    const { asset, upload } = await cms.assets.requestUpload(admin, { name, size: bytes.length, ...more });
    if (upload.kind === "single") await stores[(more.store as "private") ?? "public"].send(upload.url, bytes);
    return cms.assets.completeUpload(admin, asset.id);
  };
  const handler = createCmsHandler({ cms, resolveUser: async () => session.user });
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method ?? "GET", path: url.slice(BASE.length), body });
    return handler(new Request(url, init));
  }) as typeof fetch;
  return { cms, hooks, fetch: fetchFn, requests, stores, addFile, session, notified };
}

export type Server = ReturnType<typeof makeServer>;

export function renderWith(server: Server, ui: React.ReactElement, o: { messages?: Partial<CmsMessages>; slots?: CmsSlots } = {}): RenderResult {
  return render(
    <CmsProvider baseUrl={BASE} fetch={server.fetch} messages={o.messages} slots={o.slots} appUrl="https://app.example.com">
      {ui}
    </CmsProvider>
  );
}

/** Run axe on the whole document (dialogs render in portals). */
export async function axeViolations(root: Element | Document = document): Promise<string[]> {
  const r = await axe.run(root as Element, { rules: { region: { enabled: false }, "color-contrast": { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}
