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
import { CmsProvider } from "../cms/use-cms";
import type { CmsMessages } from "../cms/cms-messages";

export const BASE = "http://localhost/api/cms";
export const admin: Extract<Actor, { kind: "user" }> = { kind: "user", id: "u1", label: "Admin", isAdmin: true };
export const agent: Actor = { kind: "key", id: "k-agent", label: "docs-agent", scopes: ["read", "write"], collections: null };

export function makeServer(o: { previewSecret?: string | null } = {}) {
  const guide = defineCollection({
    slug: "guide",
    label: "Guide",
    visibility: "public",
    categories: ["start", "integrations"],
    url: (d) => `/guide/${d.slug}`,
    fields: z.object({
      plans: z.array(z.enum(["free", "pro", "team"])).optional(),
      featured: z.boolean().optional(),
      order: z.number().int().min(0).max(100).optional(),
      audience: z.enum(["everyone", "admins"]).optional(),
      tags: z.array(z.string()).optional(),
    }),
    admin: { fields: { plans: { label: "Plans", help: "Who sees this" }, order: { label: "Order", help: "0 to 100" } } },
  });
  const notices = defineCollection({ slug: "notices", label: "Notices", visibility: "internal", access: { read: ({ actor }) => actor.kind !== "anonymous" } });
  const cms = createCms({
    repo: new MemoryRepo(),
    collections: [guide, notices] as const,
    previewSecret: o.previewSecret === null ? undefined : (o.previewSecret ?? "x".repeat(40)),
    warn: () => {},
    schemaCheck: false,
  });
  const handler = createCmsHandler({ cms, resolveUser: async () => admin });
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? "GET", path: url.slice(BASE.length), body });
    return handler(new Request(url, init));
  }) as typeof fetch;
  return { cms, fetch: fetchFn, requests };
}

export type Server = ReturnType<typeof makeServer>;

export function renderWith(server: Server, ui: React.ReactElement, o: { messages?: Partial<CmsMessages> } = {}): RenderResult {
  return render(
    <CmsProvider baseUrl={BASE} fetch={server.fetch} messages={o.messages} appUrl="https://app.example.com">
      {ui}
    </CmsProvider>
  );
}

/** Run axe on the whole document (dialogs render in portals). */
export async function axeViolations(root: Element | Document = document): Promise<string[]> {
  const r = await axe.run(root as Element, { rules: { region: { enabled: false }, "color-contrast": { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}
