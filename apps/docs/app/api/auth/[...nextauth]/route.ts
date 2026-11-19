import { handlers } from "@/lib/auth";

// Plain Request in and out: next-auth may resolve another copy of `next` in this workspace.
export const GET = (req: Request) => handlers.GET(req as never);
export const POST = (req: Request) => handlers.POST(req as never);
