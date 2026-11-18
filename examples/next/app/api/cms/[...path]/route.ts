import { createCmsHandler } from "@mainsoft-2024/agent-cms/http";
import { cms, demoAdmin, seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

const inner = createCmsHandler({
  cms,
  // The example has no login. Return your session user (or null) here.
  resolveUser: async () => demoAdmin,
});

async function handler(req: Request) {
  await seed();
  return inner(req);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
