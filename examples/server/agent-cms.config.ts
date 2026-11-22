import { defineConfig } from "@mainsoft/agent-cms/config";

export default defineConfig({
  // `agent-cms migrate apply` makes and upgrades the tables in this database.
  db: async () => (await import("./cms")).db,
  // `agent-cms serve`: the admin, the API, MCP and the sign-in on one port.
  server: {
    cms: async () => (await import("./cms")).cms,
    appName: process.env.APP_NAME ?? "agent-cms",
    publicUrl: process.env.PUBLIC_URL,
    // Behind a proxy that terminates HTTPS (Caddy, nginx, a load balancer).
    trustProxy: process.env.TRUST_PROXY === "1",
    // Mail for invitations and password resets: auth: { sendMail: async (m) => { ... } }
  },
});
