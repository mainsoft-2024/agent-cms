import { createCmsHandler } from "@mainsoft/agent-cms/http";
import type { Actor } from "@mainsoft/agent-cms";
import { auth } from "@/lib/auth";
import { getCms } from "@/lib/cms";

export const dynamic = "force-dynamic";

/** Organisation members are admins; everyone else reads published docs. Keys (`Authorization: Bearer`) are handled by the CMS. */
async function resolveUser(): Promise<Extract<Actor, { kind: "user" }> | null> {
  const session = await auth();
  if (!session?.member || !session.user) return null;
  return { kind: "user", id: session.login ?? session.user.email ?? "member", label: session.login ?? session.user.name ?? "Member", email: session.user.email ?? null, isAdmin: true };
}

let handler: ((req: Request) => Promise<Response>) | null = null;

async function handle(req: Request): Promise<Response> {
  handler ??= createCmsHandler({
    cms: await getCms(),
    resolveUser,
    // Any agent may read the public docs over MCP without a key.
    mcp: { anonymous: "read" },
  });
  return handler(req);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
