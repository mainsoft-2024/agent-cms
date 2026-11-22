import { serve } from "@hono/node-server";
import { createApp } from "./app";

const { app } = createApp();
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Hono + agent-cms on http://localhost:${port}/api/cms/_me`));
