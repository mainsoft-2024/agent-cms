// An in-memory agent-cms (the real core and REST handler) behind a fake
// fetch, plus a render helper that wraps screens in <CmsProvider>.
import * as React from "react";
import { z } from "zod";
import { render, type RenderResult } from "@testing-library/react";
import axe from "axe-core";
import { createCms, defineCollection } from "../../src/cms";
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

export function makeServer(o: { previewSecret?: string | null; media?: boolean; review?: { agents?: "required"; everyone?: "required" }; timeZone?: string; trashDays?: number; stripMetadata?: boolean } = {}) {
  /** Who the browser is signed in as (tests switch it). */
  const session = { user: admin };
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
  const notices = defineCollection({ slug: "notices", label: "Notices", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [guide, notices] as const,
    previewSecret: o.previewSecret === null ? undefined : (o.previewSecret ?? "x".repeat(40)),
    warn: () => {},
    schemaCheck: false,
    timeZone: o.timeZone,
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
  return { cms, fetch: fetchFn, requests, stores, addFile, session };
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
