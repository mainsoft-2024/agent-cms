import { createCmsHandler } from "@mainsoft/agent-cms/http";
import { auth, cms, demoAdmin, seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

const inner = auth
  ? // The CMS's own sign-in (EXAMPLE_AUTH=own).
    createCmsHandler({ cms, auth })
  : createCmsHandler({
      cms,
      // The example has no login. Return your session user (or null) here.
      resolveUser: async () => demoAdmin,
    });

async function handler(req: Request) {
  await seed();
  return inner(req);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
