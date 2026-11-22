/**
 * Single sign-on with OpenID Connect: the authorization code flow with PKCE
 * (S256), `state` and `nonce`, the provider's discovery document and keys
 * (cached), and the ID token checked here (signature RS256 / ES256 /
 * EdDSA, issuer, audience, expiry, nonce). Works with Google, Microsoft
 * Entra, Okta, Keycloak, Auth0, Authentik and any other conforming provider.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "node:crypto";

export interface OidcOptions {
  /** e.g. "https://accounts.google.com". The discovery document is read from `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Shown on the sign-in button: "Continue with {label}". Default "SSO". */
  label?: string;
  /** Only emails of these domains may sign in. */
  allowedDomains?: string[];
  /**
   * Make an account for someone who signs in for the first time. Default:
   * true when `allowedDomains` is set (the domain is the invitation), else
   * false (only invited people).
   */
  autoCreate?: boolean;
  /** Role (name or id) given to accounts made this way. */
  defaultRole?: string;
  /** Extra scopes beside "openid email profile". */
  scopes?: string[];
  /** For tests: how to fetch. */
  fetch?: typeof fetch;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function createOidc(o: OidcOptions) {
  const http = o.fetch ?? fetch;
  let disco: { at: number; doc: Discovery } | null = null;
  let jwks: { at: number; keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] } | null = null;
  const HOUR = 3_600_000;

  async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await http(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new OidcError(`${new URL(url).host} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OidcError(`${new URL(url).host} did not answer JSON`);
    }
  }

  async function discovery(): Promise<Discovery> {
    if (disco && Date.now() - disco.at < HOUR) return disco.doc;
    const issuer = o.issuer.replace(/\/$/, "");
    const doc = await getJson<Discovery>(`${issuer}/.well-known/openid-configuration`);
    if (doc.issuer.replace(/\/$/, "") !== issuer) throw new OidcError("the discovery document names another issuer");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) if (!doc[k] || !/^https?:\/\//.test(doc[k])) throw new OidcError(`discovery has no ${k}`);
    disco = { at: Date.now(), doc };
    return doc;
  }

  async function keys(force = false) {
    if (!force && jwks && Date.now() - jwks.at < HOUR) return jwks.keys;
    const d = await discovery();
    const doc = await getJson<{ keys?: (JsonWebKey & { kid?: string })[] }>(d.jwks_uri);
    jwks = { at: Date.now(), keys: doc.keys ?? [] };
    return jwks.keys;
  }

  return {
    label: o.label ?? "SSO",
    /** The address to send the browser to, and what to keep until it comes back. */
    async start(redirectUri: string): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
      const d = await discovery();
      const { verifier, challenge } = pkcePair();
      const state = b64url(randomBytes(24));
      const nonce = b64url(randomBytes(24));
      const u = new URL(d.authorization_endpoint);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", o.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("scope", ["openid", "email", "profile", ...(o.scopes ?? [])].join(" "));
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      return { url: u.toString(), state, nonce, verifier };
    },
    /** Trades the code for tokens and checks the ID token. */
    async finish(code: string, redirectUri: string, kept: { nonce: string; verifier: string }, now = Date.now()): Promise<{ sub: string; email: string; name: string | null }> {
      const d = await discovery();
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: o.clientId, code_verifier: kept.verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      if (o.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`;
      const tok = await getJson<{ id_token?: string }>(d.token_endpoint, { method: "POST", headers, body: form.toString() });
      if (!tok.id_token) throw new OidcError("no ID token in the answer");
      const claims = await this.verifyIdToken(tok.id_token, kept.nonce, now);
      if (typeof claims.email !== "string" || !claims.email.includes("@")) throw new OidcError("the provider sent no email");
      if (claims.email_verified === false || claims.email_verified === "false") throw new OidcError("the email is not verified at the provider");
      return { sub: String(claims.sub), email: claims.email.toLowerCase(), name: typeof claims.name === "string" ? claims.name : null };
    },
    async verifyIdToken(jwt: string, nonce: string, now = Date.now()): Promise<Record<string, unknown>> {
      const parts = jwt.split(".");
      if (parts.length !== 3) throw new OidcError("the ID token is not a JWT");
      let header: { alg?: string; kid?: string };
      let claims: Record<string, unknown>;
      try {
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      } catch {
        throw new OidcError("the ID token cannot be read");
      }
      const alg = header.alg;
      if (alg !== "RS256" && alg !== "ES256" && alg !== "EdDSA") throw new OidcError(`signature ${String(alg)} is not accepted`);
      const pick = (list: (JsonWebKey & { kid?: string; use?: string })[]) => list.filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
      let candidates = pick(await keys());
      if (!candidates.length) candidates = pick(await keys(true)); // the provider rotated its keys
      const data = Buffer.from(`${parts[0]}.${parts[1]}`);
      const sig = Buffer.from(parts[2], "base64url");
      const ok = candidates.some((k) => {
        try {
          const key = createPublicKey({ key: k, format: "jwk" });
          if (alg === "ES256") return verifySig("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
          if (alg === "EdDSA") return verifySig(null, data, key, sig);
          return verifySig("sha256", data, key, sig);
        } catch {
          return false;
        }
      });
      if (!ok) throw new OidcError("the ID token signature does not match");
      const iss = String(claims.iss ?? "").replace(/\/$/, "");
      if (iss !== o.issuer.replace(/\/$/, "")) throw new OidcError("the ID token is from another issuer");
      const aud = claims.aud;
      if (!(aud === o.clientId || (Array.isArray(aud) && aud.includes(o.clientId)))) throw new OidcError("the ID token is for another app");
      if (Array.isArray(aud) && aud.length > 1 && claims.azp !== undefined && claims.azp !== o.clientId) throw new OidcError("the ID token was given to another app");
      const skew = 120;
      if (typeof claims.exp !== "number" || claims.exp + skew < now / 1000) throw new OidcError("the ID token has expired");
      if (typeof claims.iat === "number" && claims.iat - skew > now / 1000) throw new OidcError("the ID token is from the future");
      if (claims.nonce !== nonce) throw new OidcError("nonce does not match");
      return claims;
    },
  };
}

export type Oidc = ReturnType<typeof createOidc>;
