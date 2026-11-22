/**
 * Sealing values the CMS has to keep and give back (a webhook's signing secret, a plugin's
 * credentials). AES-256-GCM with a key derived from `createCms({ secretsKey })`.
 *
 * Needs Node's crypto (Node, Bun, Deno, Cloudflare Workers with `nodejs_compat`). It is loaded when
 * a value is first sealed or opened, so the rest of the CMS also runs where it is missing (Vercel
 * Edge); webhooks, which keep a sealed secret, then refuse with a clear message.
 */
type NodeCrypto = typeof import("node:crypto");
function nodeCrypto(): NodeCrypto {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const m = p?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;
  if (!m) throw new Error("[agent-cms] sealing secrets needs Node's crypto module (Node 22.3+, Bun, Deno, or Cloudflare Workers with nodejs_compat). Webhooks cannot be used on this runtime.");
  return m;
}

export interface Sealer {
  seal(text: string): string;
  /** Throws when the value was sealed with another key or was changed. */
  open(sealed: string): string;
}

export function createSealer(secretsKey: string): Sealer {
  if (typeof secretsKey !== "string" || secretsKey.length < 32) throw new Error("[agent-cms] secretsKey must be at least 32 characters (for example: openssl rand -base64 32)");
  let derived: Buffer | null = null;
  const keyOf = () => (derived ??= Buffer.from(nodeCrypto().hkdfSync("sha256", secretsKey, "agent-cms", "secrets v1", 32)));
  return {
    seal(text) {
      const { createCipheriv, randomBytes } = nodeCrypto();
      const key = keyOf();
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
    },
    open(sealed) {
      const [v, iv, tag, body] = sealed.split(".");
      if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("[agent-cms] not a sealed value");
      const { createDecipheriv } = nodeCrypto();
      const key = keyOf();
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
    },
  };
}
