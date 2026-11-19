import { createCmsHandler } from "@mainsoft/agent-cms/http";
import { demoAdmin, demoCms } from "@/lib/demo";

export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  const cms = await demoCms();
  return createCmsHandler({ cms, basePath: "/api/demo", resolveUser: async () => demoAdmin })(req);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
