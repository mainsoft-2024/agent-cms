/**
 * The CMS's own sign-in: people, passwords, passkeys, two-step codes,
 * single sign-on, invitations, sessions. For apps without a login of their
 * own, and for the standalone server (`npx @mainsoft/agent-cms serve`).
 *
 *   import { createAuth } from "@mainsoft/agent-cms/auth";
 *   const auth = createAuth({ cms, origin: "https://cms.example.com", sendMail });
 *   export const handler = createCmsHandler({ cms, auth });
 *
 * Everything is kept in `cms_records` (no schema change): people
 * (`auth_user`), sessions (`auth_session`, only a hash of the secret),
 * passkeys (`auth_passkey`), one-time tokens (`auth_token`, hashed) and the
 * policy (`auth_policy`). Two-step secrets are sealed with `secretsKey`
 * when the CMS has one.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { coreOf, type CmsCore, type CmsLike } from "../cms";
import { CmsError, isCmsError, type CmsErrorCode, type ErrorParams } from "../errors";
import { clientIp } from "../limits";
import type { CmsRecord } from "../types";
import type { Actor } from "../types";
import { createOidc, OidcError, type OidcOptions } from "./oidc";
import { DEFAULT_HASH, hashPassword, passwordProblem, verifyPassword, type HashParams } from "./password";
import { qrSvg } from "./qr";
import { newRecoveryCodes, newTotpSecret, normalizeRecovery, otpauthUrl, verifyTotp } from "./totp";
import { b64url, loginOptions, newChallenge, PasskeyError, registrationOptions, verifyAssertion, verifyRegistration, type AssertionResponse, type RegistrationResponse, type RelyingParty } from "./webauthn";

export { hashPassword, verifyPassword, passwordProblem } from "./password";
export { totp, verifyTotp, newTotpSecret, otpauthUrl, base32Encode, base32Decode } from "./totp";
export { qrSvg, encodeQr } from "./qr";
export { cborDecode, cborEncode, coseToJwk, parseAuthData, verifyRegistration, verifyAssertion } from "./webauthn";
export { createOidc, type OidcOptions } from "./oidc";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface AuthOptions {
  cms: CmsLike;
  /**
   * The address people open the admin at, e.g. "https://cms.example.com".
   * Passkeys are bound to it and links in mails use it. Default: read from
   * each request (`Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`).
   */
  origin?: string;
  /** Shown in authenticator apps, passkey prompts and mails. Default "agent-cms". */
  appName?: string;
  /** Where the admin screens are. Default "/admin". */
  adminPath?: string;
  /** Where the CMS handler is mounted. Default "/api/cms". */
  basePath?: string;
  /** Sends invitations and password resets. Without it the screens make links to copy. */
  sendMail?: (mail: Mail) => Promise<void>;
  /** Language of the mails. Default "en". */
  locale?: "en" | "ko";
  /** Single sign-on with OpenID Connect. */
  oidc?: OidcOptions;
  /** Sign in with a password (default true). False: passkeys and SSO only. */
  passwords?: boolean;
  session?: {
    /** Idle lifetime; each use moves it forward. Default 30 days. */
    days?: number;
    /** Longest a session lives, used or not. Default 90 days. */
    maxDays?: number;
  };
  /** scrypt parameters. Default N=2^17, r=8, p=1. */
  hash?: HashParams;
  /** Where the setup code is printed. Default console.log. */
  log?: (line: string) => void;
}

interface UserData {
  email: string;
  name: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  disabledAt: string | null;
  prefs: { theme?: "light" | "dark" | "system"; locale?: string };
  lastLoginAt: string | null;
  totp: { secret: string; sealed: boolean; lastStep: number | null; at: string } | null;
  pendingTotp: { secret: string; sealed: boolean; at: string } | null;
  recovery: string[];
  oidcSub: string | null;
  invitedBy: string | null;
}

interface SessionData {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  maxAt: string;
  ip: string | null;
  userAgent: string | null;
  /** How the session started: password, passkey, sso, setup, invite, reset. */
  method: string;
  /** When the person last confirmed it is them (sign-in, password, passkey). */
  confirmedAt: string;
  /** Signed in, but the policy wants two-step sign-in set up first: only the setup routes answer. */
  mfaSetup: boolean;
}

interface PasskeyData {
  label: string;
  jwk: Record<string, unknown>;
  alg: number;
  signCount: number;
  transports: string[];
  backedUp: boolean;
  aaguid: string;
  lastUsedAt: string | null;
}

interface TokenData {
  expiresAt: string;
  [k: string]: unknown;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  password: boolean;
  totp: boolean;
  passkeys: number;
  sso: boolean;
  roles: { id: string; name: string }[];
}

export interface AuthSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  device: string;
  method: string;
}

const USER = "auth_user";
const SESSION = "auth_session";
const PASSKEY = "auth_passkey";
const TOKEN = "auth_token";
const POLICY = "auth_policy";
const FAILS = "auth_fails";

const MIN = 60_000;
const DAY = 86_400_000;
const REAUTH_MS = 10 * MIN;
const TOUCH_MS = 5 * MIN;
const LOCK_TRIES = 10;
const LOCK_MS = 15 * MIN;
const IP_TRIES = 50;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const emailRe = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

/** "Chrome on macOS" from a user agent (no library; good enough for a list of devices). */
export function deviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return new URL(req.url).protocol === "https:";
}

export function createAuth(o: AuthOptions) {
  const core: CmsCore = coreOf(o.cms);
  const repo = core.repo;
  const now = () => core.now();
  const iso = () => now().toISOString();
  const appName = o.appName ?? "agent-cms";
  const adminPath = (o.adminPath ?? "/admin").replace(/\/$/, "") || "/admin";
  const basePath = (o.basePath ?? "/api/cms").replace(/\/$/, "");
  const hashParams = o.hash ?? DEFAULT_HASH;
  const passwords = o.passwords !== false;
  const sessionDays = o.session?.days ?? 30;
  const maxDays = o.session?.maxDays ?? 90;
  const log = o.log ?? ((line: string) => console.log(line));
  const oidc = o.oidc ? createOidc(o.oidc) : null;
  const locale = o.locale ?? "en";
  const ipHits = new Map<string, { n: number; since: number }>();

  const fail = (code: CmsErrorCode, params: ErrorParams = {}, x: { status?: number } = {}) => core.fail(code, params, x);

  // ── storage ──────────────────────────────────────────────────────────────

  const userOf = (r: CmsRecord) => ({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, ...(r.data as unknown as UserData) });
  type User = ReturnType<typeof userOf>;

  async function findUser(id: string): Promise<User | null> {
    const r = await repo.findRecord(USER, id);
    return r ? userOf(r) : null;
  }
  async function userByEmail(email: string): Promise<User | null> {
    const r = await repo.findRecordByKey(USER, email.trim().toLowerCase());
    return r ? userOf(r) : null;
  }
  async function saveUser(u: User, patch: Partial<UserData>): Promise<User> {
    const { id, createdAt: _c, updatedAt: _u, ...data } = u;
    const r = await repo.updateRecord(USER, id, { data: { ...data, ...patch } as unknown as Record<string, unknown>, at: iso() });
    return userOf(r!);
  }
  async function allUsers(): Promise<User[]> {
    return (await repo.listRecords({ kind: USER, order: "asc", limit: 5000 })).map(userOf);
  }
  async function userCount(): Promise<number> {
    return (await repo.listRecords({ kind: USER, limit: 1 })).length;
  }

  async function newToken(type: string, data: Omit<TokenData, "expiresAt">, ttlMs: number, raw = token()): Promise<{ raw: string; id: string }> {
    const r = await repo.insertRecord({ kind: TOKEN, scope: type, key: sha(`${type}:${raw}`), data: { ...data, expiresAt: new Date(now().getTime() + ttlMs).toISOString() }, at: iso() });
    return { raw, id: r.id };
  }
  /** A token that is there and not expired. `use` deletes it (one use only). */
  async function readToken(type: string, raw: string, use: boolean): Promise<(TokenData & { id: string }) | null> {
    if (!raw || raw.length > 200) return null;
    const r = await repo.findRecordByKey(TOKEN, sha(`${type}:${raw}`));
    if (!r || r.scope !== type) return null;
    const d = r.data as TokenData;
    if (Date.parse(d.expiresAt) <= now().getTime()) {
      await repo.deleteRecords({ kind: TOKEN, id: r.id });
      return null;
    }
    if (use) {
      // Deleting is the claim: only the caller that removed the row goes on.
      const n = await repo.deleteRecords({ kind: TOKEN, id: r.id });
      if (n !== 1) return null;
    }
    return { ...d, id: r.id };
  }

  async function policy(): Promise<{ requireMfa: boolean }> {
    const r = await repo.findRecordByKey(POLICY, "policy");
    return { requireMfa: !!(r?.data as { requireMfa?: boolean } | undefined)?.requireMfa };
  }

  const seal = (secret: string) => (core.secrets ? { secret: core.secrets.seal(secret), sealed: true } : { secret, sealed: false });
  const unseal = (t: { secret: string; sealed: boolean }) => (t.sealed ? core.secrets!.open(t.secret) : t.secret);

  // ── sessions ─────────────────────────────────────────────────────────────

  function cookieName(req: Request) {
    return isHttps(req) ? "__Host-cms_session" : "cms_session";
  }
  function sessionCookie(req: Request, value: string, maxAgeSec: number): string {
    const secure = isHttps(req);
    return `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  }
  function trustCookie(req: Request, value: string, maxAgeSec: number): string {
    const secure = isHttps(req);
    return `${secure ? "__Host-" : ""}cms_trust=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  }
  function rawSession(req: Request): string | null {
    const c = cookies(req);
    return c["__Host-cms_session"] ?? c.cms_session ?? null;
  }

  async function startSession(req: Request, user: User, method: string, mfaSetup = false): Promise<{ cookie: string; id: string }> {
    const secret = token();
    const t = now().getTime();
    const data: SessionData = {
      userId: user.id,
      createdAt: new Date(t).toISOString(),
      lastSeenAt: new Date(t).toISOString(),
      expiresAt: new Date(Math.min(t + sessionDays * DAY, t + maxDays * DAY)).toISOString(),
      maxAt: new Date(t + maxDays * DAY).toISOString(),
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      method,
      confirmedAt: new Date(t).toISOString(),
      mfaSetup,
    };
    const r = await repo.insertRecord({ kind: SESSION, scope: user.id, key: sha(secret), data: data as unknown as Record<string, unknown>, at: iso() });
    if (!mfaSetup) await saveUser(user, { lastLoginAt: iso() });
    return { cookie: sessionCookie(req, secret, maxDays * 86400), id: r.id };
  }

  /** The session behind the cookie (expired and disabled ones are null). */
  async function sessionOf(req: Request, o: { allowSetup?: boolean } = {}): Promise<{ id: string; data: SessionData; user: User } | null> {
    const raw = rawSession(req);
    if (!raw || raw.length > 100) return null;
    const r = await repo.findRecordByKey(SESSION, sha(raw));
    if (!r) return null;
    const data = r.data as unknown as SessionData;
    const t = now().getTime();
    if (Date.parse(data.expiresAt) <= t || Date.parse(data.maxAt) <= t) {
      await repo.deleteRecords({ kind: SESSION, id: r.id });
      return null;
    }
    if (data.mfaSetup && !o.allowSetup) return null;
    const user = await findUser(data.userId);
    if (!user || user.disabledAt) return null;
    if (t - Date.parse(data.lastSeenAt) > TOUCH_MS) {
      const next: SessionData = { ...data, lastSeenAt: new Date(t).toISOString(), expiresAt: new Date(Math.min(t + sessionDays * DAY, Date.parse(data.maxAt))).toISOString() };
      await repo.updateRecord(SESSION, r.id, { data: next as unknown as Record<string, unknown>, at: iso() });
      return { id: r.id, data: next, user };
    }
    return { id: r.id, data, user };
  }

  async function endSessions(userId: string, except?: string): Promise<number> {
    const list = await repo.listRecords({ kind: SESSION, scope: userId, limit: 1000 });
    let n = 0;
    for (const s of list) if (s.id !== except) n += await repo.deleteRecords({ kind: SESSION, id: s.id });
    return n;
  }

  async function confirm(sessionId: string) {
    const r = await repo.findRecord(SESSION, sessionId);
    if (!r) return;
    await repo.updateRecord(SESSION, sessionId, { data: { ...r.data, confirmedAt: iso() }, at: iso() });
  }

  const recentlyConfirmed = (s: { data: SessionData }) => now().getTime() - Date.parse(s.data.confirmedAt) < REAUTH_MS;

  function actorOf(u: User): Extract<Actor, { kind: "user" }> {
    return { kind: "user", id: u.id, label: u.name || u.email, email: u.email, isAdmin: u.isAdmin };
  }

  // ── limits ───────────────────────────────────────────────────────────────

  function ipLimited(req: Request) {
    const ip = clientIp(req) ?? "unknown";
    const t = now().getTime();
    const h = ipHits.get(ip);
    if (!h || t - h.since > LOCK_MS) {
      ipHits.set(ip, { n: 1, since: t });
      if (ipHits.size > 10_000) for (const [k, v] of ipHits) if (t - v.since > LOCK_MS) ipHits.delete(k);
      return;
    }
    h.n++;
    if (h.n > IP_TRIES) throw fail("login_locked", { minutes: Math.ceil((LOCK_MS - (t - h.since)) / MIN), retryAfter: Math.ceil((LOCK_MS - (t - h.since)) / 1000) }, { status: 429 });
  }
  /** Ten wrong passwords for one email in 15 minutes pause password sign-in for that email (passkeys and SSO still work). */
  async function lockedFor(email: string): Promise<number> {
    const r = await repo.findRecordByKey(FAILS, email);
    if (!r) return 0;
    const d = r.data as { n: number; since: string };
    const left = LOCK_MS - (now().getTime() - Date.parse(d.since));
    if (left <= 0) return 0;
    return d.n >= LOCK_TRIES ? left : 0;
  }
  async function countFail(email: string) {
    const r = await repo.findRecordByKey(FAILS, email);
    const t = now().getTime();
    if (!r) {
      await repo.insertRecord({ kind: FAILS, key: email, data: { n: 1, since: iso() }, at: iso() }).catch(() => undefined);
      return;
    }
    const d = r.data as { n: number; since: string };
    const fresh = t - Date.parse(d.since) > LOCK_MS;
    await repo.updateRecord(FAILS, r.id, { data: fresh ? { n: 1, since: iso() } : { n: d.n + 1, since: d.since }, at: iso() });
  }
  async function clearFails(email: string) {
    const r = await repo.findRecordByKey(FAILS, email);
    if (r) await repo.deleteRecords({ kind: FAILS, id: r.id });
  }

  // ── people ───────────────────────────────────────────────────────────────

  function cleanEmail(e: string): string {
    const email = String(e ?? "").trim().toLowerCase();
    if (!emailRe.test(email) || email.length > 254) throw fail("email_invalid", { email: String(e ?? "").slice(0, 80) });
    return email;
  }
  function checkPassword(pw: string, about: { email?: string; name?: string | null }) {
    const p = passwordProblem(pw, about);
    if (p) throw fail(p.code, { min: p.min });
  }

  async function createUser(input: { email: string; name?: string | null; password?: string | null; isAdmin?: boolean; invitedBy?: string | null; oidcSub?: string | null }): Promise<User> {
    await core.ready();
    const email = cleanEmail(input.email);
    if (await userByEmail(email)) throw fail("email_taken", { email });
    const name = input.name?.trim().slice(0, 120) || null;
    if (input.password) checkPassword(input.password, { email, name });
    const data: UserData = {
      email,
      name,
      passwordHash: input.password ? await hashPassword(input.password, hashParams) : null,
      isAdmin: !!input.isAdmin,
      disabledAt: null,
      prefs: {},
      lastLoginAt: null,
      totp: null,
      pendingTotp: null,
      recovery: [],
      oidcSub: input.oidcSub ?? null,
      invitedBy: input.invitedBy ?? null,
    };
    try {
      return userOf(await repo.insertRecord({ kind: USER, key: email, data: data as unknown as Record<string, unknown>, at: iso() }));
    } catch {
      throw fail("email_taken", { email });
    }
  }

  async function passkeysOf(userId: string) {
    return (await repo.listRecords({ kind: PASSKEY, scope: userId, order: "asc", limit: 100 })).map((r) => ({ id: r.id, credentialId: r.key!, createdAt: r.createdAt, ...(r.data as unknown as PasskeyData) }));
  }

  async function publicUser(u: User): Promise<PublicUser> {
    await core.roles.load();
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: u.isAdmin,
      disabled: !!u.disabledAt,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      password: !!u.passwordHash,
      totp: !!u.totp,
      passkeys: (await passkeysOf(u.id)).length,
      sso: !!u.oidcSub,
      roles: core.rolesOf(u.id).map((r) => ({ id: r.id, name: r.name })),
    };
  }

  const hasMfa = async (u: User) => !!u.totp || (await passkeysOf(u.id)).length > 0;

  async function admins(): Promise<User[]> {
    return (await allUsers()).filter((u) => u.isAdmin && !u.disabledAt);
  }

  // The roles screen finds people here.
  core.useUsers({
    search: async (q) => {
      const s = q.toLowerCase();
      return (await allUsers()).filter((u) => !u.disabledAt && (u.email.includes(s) || (u.name ?? "").toLowerCase().includes(s))).slice(0, 20).map((u) => ({ id: u.id, label: u.name ? `${u.name} (${u.email})` : u.email }));
    },
    get: async (id) => {
      const u = await findUser(id);
      return u ? { id: u.id, label: u.name || u.email } : null;
    },
  });

  // ── links and mail ───────────────────────────────────────────────────────

  function originOf(req: Request): string {
    if (o.origin) return o.origin.replace(/\/$/, "");
    const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || new URL(req.url).host;
    return `${isHttps(req) ? "https" : "http"}://${host}`;
  }
  function rpOf(req: Request): RelyingParty {
    const origin = originOf(req);
    return { id: new URL(origin).hostname, name: appName, origins: [origin] };
  }
  const link = (req: Request, page: string, tok: string) => `${originOf(req)}${adminPath}/${page}#${tok}`;

  const MAILS = {
    en: {
      invite: (by: string, url: string) => ({ subject: `${by} invited you to ${appName}`, text: `${by} invited you to ${appName}.\n\nAccept the invitation (valid for 7 days):\n${url}\n\nIf you did not expect this, ignore this mail.` }),
      reset: (url: string) => ({ subject: `Reset your ${appName} password`, text: `Someone asked to reset the password of this account.\n\nChoose a new password (the link works once, for 1 hour):\n${url}\n\nIf it was not you, ignore this mail: nothing changes.` }),
    },
    ko: {
      invite: (by: string, url: string) => ({ subject: `${by} 님이 ${appName}에 초대함`, text: `${by} 님이 ${appName}에 초대함.\n\n초대 수락 (7일 동안 유효):\n${url}\n\n모르는 초대면 이 메일은 무시해도 됨.` }),
      reset: (url: string) => ({ subject: `${appName} 비밀번호 재설정`, text: `이 계정의 비밀번호 재설정 요청이 있었음.\n\n새 비밀번호 정하기 (한 번만, 1시간 동안 유효):\n${url}\n\n본인이 아니면 이 메일은 무시해도 됨. 아무것도 바뀌지 않음.` }),
    },
  };
  async function mail(m: Mail): Promise<boolean> {
    if (!o.sendMail) return false;
    try {
      await o.sendMail(m);
      return true;
    } catch (e) {
      core.telemetry({ type: "error", where: "auth mail", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  // ── setup code ───────────────────────────────────────────────────────────

  let printed: { code: string; until: number } | null = null;
  /** When no one can sign in yet: a code for the first admin, printed where the server logs. */
  async function setupCode(req?: Request): Promise<string | null> {
    await core.ready();
    if ((await userCount()) > 0) return null;
    const t = now().getTime();
    if (printed && printed.until > t + MIN) return printed.code;
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const raw = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    await repo.deleteRecords({ kind: TOKEN, scope: "setup" });
    await newToken("setup", { tries: 0 }, 15 * MIN, code.replace("-", ""));
    printed = { code, until: t + 15 * MIN };
    const where = req ? `${originOf(req)}${adminPath}/setup` : `${o.origin ?? ""}${adminPath}/setup`;
    log(`[agent-cms] No one can sign in yet. Open ${where} and enter the setup code ${code} (valid for 15 minutes).`);
    return code;
  }

  // ── responses ────────────────────────────────────────────────────────────

  function json(data: unknown, status = 200, setCookies: string[] = []): Response {
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    for (const c of setCookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify(data), { status, headers });
  }
  function redirect(to: string, setCookies: string[] = []): Response {
    const headers = new Headers({ location: to, "cache-control": "no-store" });
    for (const c of setCookies) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  }
  async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    const text = await req.text();
    if (text.length > 64 * 1024) throw new CmsError("body_too_large", {}, { status: 413 });
    let v: unknown = {};
    if (text.trim()) {
      try {
        v = JSON.parse(text);
      } catch {
        throw new CmsError("invalid_json");
      }
    }
    return schema.parse(v);
  }
  const audit = (actor: Actor, action: Parameters<CmsCore["writeAudit"]>[1], detail: Record<string, unknown> = {}) => core.writeAudit(actor, action, { detail });
  const nobody: Actor = { kind: "anonymous" };

  /** After a password or a passkey: two-step, or the session. */
  async function finishLogin(req: Request, user: User, method: string, viaPasskey: boolean): Promise<Response> {
    if (user.disabledAt) throw fail("user_disabled");
    // A passkey is two factors in one (the device and its unlock), so it skips the code.
    if (!viaPasskey && user.totp) {
      const trusted = cookies(req)["__Host-cms_trust"] ?? cookies(req).cms_trust;
      const t = trusted ? await readToken("trust", trusted, false) : null;
      if (!t || t.userId !== user.id) {
        const ticket = await newToken("mfa", { userId: user.id, method }, 5 * MIN);
        return json({ mfa: true, ticket: ticket.raw });
      }
    }
    const setup = (await policy()).requireMfa && !(await hasMfa(user));
    const s = await startSession(req, user, method, setup);
    audit(actorOf(user), "auth.login", { method });
    return json({ ok: true, mfaSetup: setup, user: await publicUser(user) }, 200, [s.cookie]);
  }

  async function me(req: Request, allowSetup = false) {
    const s = await sessionOf(req, { allowSetup });
    if (!s) throw fail("unauthorized");
    return s;
  }
  async function requireConfirmed(req: Request, allowSetup = false) {
    const s = await me(req, allowSetup);
    if (!recentlyConfirmed(s)) throw fail("reauth_required", {}, { status: 401 });
    return s;
  }
  async function requireAdmin(req: Request) {
    const s = await me(req);
    if (!core.isAdmin(actorOf(s.user))) throw fail("forbidden_admin");
    return s;
  }

  async function sessionsOf(userId: string, currentId: string | null): Promise<AuthSession[]> {
    return (await repo.listRecords({ kind: SESSION, scope: userId, limit: 200, order: "desc" }))
      .map((r) => ({ r, d: r.data as unknown as SessionData }))
      .filter(({ d }) => Date.parse(d.expiresAt) > now().getTime())
      .sort((a, b) => b.d.lastSeenAt.localeCompare(a.d.lastSeenAt))
      .map(({ r, d }) => ({ id: r.id, current: r.id === currentId, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, ip: d.ip, device: deviceName(d.userAgent), method: d.method }));
  }

  async function invites() {
    return (await repo.listRecords({ kind: TOKEN, scope: "invite", order: "desc", limit: 500 }))
      .map((r) => ({ ...(r.data as TokenData), id: r.id, createdAt: r.createdAt }) as TokenData & { id: string; createdAt: string })
      .filter((d) => Date.parse(d.expiresAt) > now().getTime())
      .map((d) => ({ id: d.id, email: String(d.email), isAdmin: !!d.isAdmin, roleId: (d.roleId as string | null) ?? null, invitedBy: String(d.invitedByLabel ?? ""), createdAt: d.createdAt, expiresAt: d.expiresAt }));
  }

  async function setRole(actor: Actor, userId: string, roleId: string | null) {
    await core.roles.load(true);
    for (const r of core.rolesOf(userId)) if (r.id !== roleId) await core.roles.removeMember(actor, r.id, userId);
    if (roleId) await core.roles.addMember(actor, roleId, { id: userId });
  }

  async function acceptInvite(req: Request, inv: TokenData & { id: string }, input: { name?: string | null; password?: string | null; oidcSub?: string | null }, method: string): Promise<{ user: User; cookie: string }> {
    const user = await createUser({ email: String(inv.email), name: input.name, password: input.password, isAdmin: !!inv.isAdmin, invitedBy: String(inv.invitedBy ?? "") || null, oidcSub: input.oidcSub ?? null });
    const system: Actor = { kind: "system", label: "invitation" };
    if (inv.roleId) await setRole(system, user.id, String(inv.roleId)).catch((e) => core.telemetry({ type: "error", where: "auth invite role", message: e instanceof Error ? e.message : String(e) }));
    const setup = (await policy()).requireMfa && method !== "sso";
    const s = await startSession(req, user, method, setup && !(await hasMfa(user)));
    audit(actorOf(user), "auth.accept", { email: user.email });
    return { user, cookie: s.cookie };
  }

  // ── routes ───────────────────────────────────────────────────────────────

  const Login = z.object({ email: z.string().max(254), password: z.string().max(1024) });
  const Mfa = z.object({ ticket: z.string().max(200), code: z.string().max(20).optional(), recovery: z.string().max(40).optional(), remember: z.boolean().optional() });
  const NewPassword = z.string().min(1).max(1024);
  const Credential = z.object({ id: z.string().max(1400), rawId: z.string().max(1400).optional(), type: z.string(), response: z.record(z.unknown()), clientExtensionResults: z.record(z.unknown()).optional(), authenticatorAttachment: z.string().nullable().optional() }).passthrough();

  async function handle(req: Request, seg: string[]): Promise<Response> {
    try {
      return await route(req, seg);
    } catch (e) {
      if (e instanceof PasskeyError) return errorJson(fail("passkey_invalid", { reason: e.reason }));
      if (e instanceof OidcError) return errorJson(fail("oidc_failed", { reason: e.reason }));
      throw e;
    }
  }
  function errorJson(e: CmsError) {
    return json({ ...e.toJSON(), message: core.message(e) }, e.status);
  }

  async function route(req: Request, seg: string[]): Promise<Response> {
    const m = req.method.toUpperCase();
    const [a, b, c] = seg;

    if (seg[0] === "users") return users(req, seg.slice(1));

    if (a === "state" && m === "GET") {
      const s = await sessionOf(req, { allowSetup: true });
      const setup = (await userCount()) === 0;
      if (setup) await setupCode(req);
      return json({
        setup,
        methods: { password: passwords, passkey: true, sso: oidc ? { label: oidc.label } : null },
        mail: !!o.sendMail,
        user: s ? await publicUser(s.user) : null,
        mfaSetup: !!s?.data.mfaSetup,
        adminPath,
      });
    }

    if (a === "setup" && m === "POST") {
      ipLimited(req);
      const i = await body(req, z.object({ code: z.string().max(20), email: z.string().max(254), name: z.string().max(120).optional(), password: NewPassword.optional() }));
      if ((await userCount()) > 0) throw fail("setup_done");
      const code = i.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!(await readToken("setup", code, false))) throw fail("setup_invalid");
      // Check what was typed before the code is used up.
      const email = cleanEmail(i.email);
      if (i.password) checkPassword(i.password, { email, name: i.name });
      if (!(await readToken("setup", code, true))) throw fail("setup_invalid");
      const user = await createUser({ email: i.email, name: i.name, password: i.password, isAdmin: true });
      printed = null;
      const s = await startSession(req, user, "setup");
      audit(actorOf(user), "auth.setup", { email: user.email });
      return json({ ok: true, user: await publicUser(user) }, 201, [s.cookie]);
    }

    if (a === "login" && m === "POST") {
      if (!passwords) throw fail("route_not_found");
      ipLimited(req);
      const i = await body(req, Login);
      const email = i.email.trim().toLowerCase();
      const locked = await lockedFor(email);
      if (locked) throw fail("login_locked", { minutes: Math.ceil(locked / MIN), retryAfter: Math.ceil(locked / 1000) }, { status: 429 });
      const user = await userByEmail(email);
      const v = await verifyPassword(i.password, user && !user.disabledAt ? user.passwordHash : null, hashParams);
      if (!user || !v.ok || user.disabledAt) {
        await countFail(email);
        audit(nobody, "auth.login_failed", { email: email.slice(0, 120) });
        throw fail("login_failed");
      }
      await clearFails(email);
      const fresh = v.rehash ? await saveUser(user, { passwordHash: await hashPassword(i.password, hashParams) }) : user;
      return finishLogin(req, fresh, "password", false);
    }

    if (a === "mfa" && m === "POST") {
      ipLimited(req);
      const i = await body(req, Mfa);
      const t = await readToken("mfa", i.ticket, false);
      if (!t) throw fail("mfa_ticket_invalid");
      let user = await findUser(String(t.userId));
      if (!user?.totp || user.disabledAt) throw fail("mfa_ticket_invalid");
      if (i.recovery) {
        const want = sha(normalizeRecovery(i.recovery));
        if (!user.recovery.includes(want)) throw fail("mfa_invalid");
        user = await saveUser(user, { recovery: user.recovery.filter((x) => x !== want) });
      } else {
        const step = verifyTotp(unseal(user.totp), i.code ?? "", now().getTime(), user.totp.lastStep);
        if (step === null) throw fail("mfa_invalid");
        user = await saveUser(user, { totp: { ...user.totp, lastStep: step } });
      }
      await readToken("mfa", i.ticket, true);
      const cookiesOut: string[] = [];
      if (i.remember) {
        const trust = await newToken("trust", { userId: user.id }, 30 * DAY);
        cookiesOut.push(trustCookie(req, trust.raw, 30 * 86400));
      }
      const s = await startSession(req, user, String(t.method ?? "password"));
      audit(actorOf(user), "auth.login", { method: `${String(t.method ?? "password")}+${i.recovery ? "recovery" : "totp"}` });
      return json({ ok: true, user: await publicUser(user), recoveryLeft: i.recovery ? user.recovery.length : undefined }, 200, [s.cookie, ...cookiesOut]);
    }

    if (a === "logout" && m === "POST") {
      const raw = rawSession(req);
      const s = await sessionOf(req, { allowSetup: true });
      if (raw) {
        const r = await repo.findRecordByKey(SESSION, sha(raw));
        if (r) await repo.deleteRecords({ kind: SESSION, id: r.id });
      }
      if (s) audit(actorOf(s.user), "auth.logout");
      return json({ ok: true }, 200, [sessionCookie(req, "", 0)]);
    }

    if (a === "reset" && b === "request" && m === "POST") {
      ipLimited(req);
      const i = await body(req, z.object({ email: z.string().max(254) }));
      const user = await userByEmail(i.email.trim().toLowerCase()).catch(() => null);
      // The same answer either way: whether an account exists is not told.
      if (user && !user.disabledAt && o.sendMail) {
        const t = await newToken("reset", { userId: user.id }, 60 * MIN);
        void mail({ to: user.email, ...MAILS[locale].reset(link(req, "reset", t.raw)) });
      }
      return json({ ok: true, mail: !!o.sendMail });
    }

    if (a === "reset" && !b && m === "GET") {
      const t = await readToken("reset", new URL(req.url).searchParams.get("token") ?? "", false);
      if (!t) throw fail("reset_invalid");
      const u = await findUser(String(t.userId));
      if (!u) throw fail("reset_invalid");
      return json({ email: u.email });
    }

    if (a === "reset" && !b && m === "POST") {
      ipLimited(req);
      const i = await body(req, z.object({ token: z.string().max(200), password: NewPassword }));
      const peek = await readToken("reset", i.token, false);
      if (!peek) throw fail("reset_invalid");
      const user = await findUser(String(peek.userId));
      if (!user || user.disabledAt) throw fail("reset_invalid");
      checkPassword(i.password, user);
      if (!(await readToken("reset", i.token, true))) throw fail("reset_invalid");
      const saved = await saveUser(user, { passwordHash: await hashPassword(i.password, hashParams) });
      await endSessions(user.id);
      await clearFails(user.email);
      audit(actorOf(saved), "auth.reset");
      return finishLogin(req, saved, "reset", false);
    }

    if (a === "invite" && b && m === "GET") {
      const t = await readToken("invite", b, false);
      if (!t) throw fail("invite_invalid");
      return json({ email: t.email, invitedBy: t.invitedByLabel ?? null, isAdmin: !!t.isAdmin, exists: !!(await userByEmail(String(t.email))) });
    }

    if (a === "invite" && b && m === "POST") {
      ipLimited(req);
      const i = await body(req, z.object({ name: z.string().max(120).optional(), password: NewPassword.optional() }));
      const peek = await readToken("invite", b, false);
      if (!peek) throw fail("invite_invalid");
      if (i.password) checkPassword(i.password, { email: String(peek.email), name: i.name });
      const inv = await readToken("invite", b, true);
      if (!inv) throw fail("invite_invalid");
      const { user, cookie } = await acceptInvite(req, inv, { name: i.name, password: i.password ?? null }, "invite");
      return json({ ok: true, user: await publicUser(user), needsPasskey: !i.password }, 201, [cookie]);
    }

    if (a === "passkey" && b === "options" && m === "POST") {
      const i = await body(req, z.object({ purpose: z.enum(["login", "register", "reauth"]) }));
      const rp = rpOf(req);
      const challenge = newChallenge();
      if (i.purpose === "login") {
        ipLimited(req);
        const t = await newToken("challenge", { purpose: "login", challenge }, 5 * MIN);
        return json({ challengeId: t.raw, publicKey: loginOptions(rp, challenge) });
      }
      const s = await me(req, true);
      if (i.purpose === "register" && !recentlyConfirmed(s)) throw fail("reauth_required", {}, { status: 401 });
      const t = await newToken("challenge", { purpose: i.purpose, challenge, userId: s.user.id }, 5 * MIN);
      if (i.purpose === "reauth") return json({ challengeId: t.raw, publicKey: { ...loginOptions(rp, challenge), allowCredentials: (await passkeysOf(s.user.id)).map((p) => ({ type: "public-key", id: p.credentialId, transports: p.transports })) } });
      const exclude = (await passkeysOf(s.user.id)).map((p) => ({ id: p.credentialId, transports: p.transports }));
      return json({ challengeId: t.raw, publicKey: registrationOptions(rp, { id: s.user.id, email: s.user.email, name: s.user.name }, challenge, exclude) });
    }

    if (a === "passkey" && b === "verify" && m === "POST") {
      const i = await body(req, z.object({ challengeId: z.string().max(200), credential: Credential, label: z.string().max(60).optional() }));
      const t = await readToken("challenge", i.challengeId, true);
      if (!t) throw fail("passkey_invalid", { reason: "the request expired, try again" });
      const rp = rpOf(req);
      if (t.purpose === "register") {
        const s = await me(req, true);
        if (s.user.id !== t.userId) throw fail("passkey_invalid", { reason: "another session" });
        const v = verifyRegistration(i.credential as unknown as RegistrationResponse, { challenge: String(t.challenge), rp });
        if (await repo.findRecordByKey(PASSKEY, v.credentialId)) throw fail("passkey_invalid", { reason: "already registered" });
        const data: PasskeyData = { label: i.label?.trim() || deviceName(req.headers.get("user-agent")), jwk: v.jwk as Record<string, unknown>, alg: v.alg, signCount: v.signCount, transports: v.transports, backedUp: v.backedUp, aaguid: v.aaguid, lastUsedAt: null };
        await repo.insertRecord({ kind: PASSKEY, scope: s.user.id, key: v.credentialId, data: data as unknown as Record<string, unknown>, at: iso() });
        if (s.data.mfaSetup) await repo.updateRecord(SESSION, s.id, { data: { ...s.data, mfaSetup: false } as unknown as Record<string, unknown>, at: iso() });
        audit(actorOf(s.user), "auth.passkey_add", { label: data.label });
        return json({ ok: true, passkeys: await passkeyList(s.user.id) }, 201);
      }
      // Login or reauth: find the passkey by its id.
      const cred = i.credential as unknown as AssertionResponse;
      const r = await repo.findRecordByKey(PASSKEY, cred.id);
      if (!r) throw fail("passkey_unknown");
      const pk = r.data as unknown as PasskeyData;
      const user = await findUser(r.scope);
      if (!user) throw fail("passkey_unknown");
      if (t.purpose === "reauth" && t.userId !== user.id) throw fail("passkey_invalid", { reason: "another person's passkey" });
      const v = verifyAssertion(cred, { challenge: String(t.challenge), rp, jwk: pk.jwk, alg: pk.alg, signCount: pk.signCount, userId: user.id });
      await repo.updateRecord(PASSKEY, r.id, { data: { ...pk, signCount: v.signCount, backedUp: v.backedUp, lastUsedAt: iso() } as unknown as Record<string, unknown>, at: iso() });
      if (t.purpose === "reauth") {
        const s = await me(req, true);
        await confirm(s.id);
        return json({ ok: true });
      }
      return finishLogin(req, user, "passkey", true);
    }

    if (a === "oidc" && b === "start" && m === "GET") {
      if (!oidc) throw fail("route_not_found");
      const next = safeNext(new URL(req.url).searchParams.get("next"));
      const redirectUri = `${originOf(req)}${basePath}/auth/oidc/callback`;
      const s = await oidc.start(redirectUri);
      await newToken("oidc", { nonce: s.nonce, verifier: s.verifier, next, redirectUri }, 10 * MIN, s.state);
      return redirect(s.url);
    }

    if (a === "oidc" && b === "callback" && m === "GET") {
      if (!oidc || !o.oidc) throw fail("route_not_found");
      const q = new URL(req.url).searchParams;
      const back = (code: string, params: Record<string, string> = {}) => redirect(`${adminPath}/login?${new URLSearchParams({ error: code, ...params })}`);
      if (q.get("error")) return back("oidc_failed", { reason: (q.get("error_description") ?? q.get("error") ?? "").slice(0, 200) });
      const kept = await readToken("oidc", q.get("state") ?? "", true);
      if (!kept) return back("oidc_failed", { reason: "the sign-in took too long or was opened twice" });
      try {
        const who = await oidc.finish(q.get("code") ?? "", String(kept.redirectUri), { nonce: String(kept.nonce), verifier: String(kept.verifier) }, now().getTime());
        const domain = who.email.split("@")[1];
        const allowed = o.oidc.allowedDomains?.map((d) => d.toLowerCase());
        if (allowed?.length && !allowed.includes(domain)) return back("oidc_domain", { domain });
        let user = await userByEmail(who.email);
        let cookie: string;
        if (user) {
          if (user.disabledAt) return back("user_disabled");
          if (!user.oidcSub) user = await saveUser(user, { oidcSub: who.sub });
          else if (user.oidcSub !== who.sub) return back("oidc_failed", { reason: "this email belongs to another account at the provider" });
          const setup = (await policy()).requireMfa && !(await hasMfa(user)) && false; // the provider is the second factor
          cookie = (await startSession(req, user, "sso", setup)).cookie;
          audit(actorOf(user), "auth.login", { method: "sso" });
        } else {
          const pending = (await invites()).find((x) => x.email === who.email);
          const inv = pending ? await repo.findRecord(TOKEN, pending.id) : null;
          if (inv) {
            await repo.deleteRecords({ kind: TOKEN, id: inv.id });
            cookie = (await acceptInvite(req, { ...(inv.data as TokenData), id: inv.id }, { name: who.name, oidcSub: who.sub }, "sso")).cookie;
          } else if (o.oidc.autoCreate ?? !!allowed?.length) {
            user = await createUser({ email: who.email, name: who.name, oidcSub: who.sub });
            const role = o.oidc.defaultRole;
            if (role) {
              await core.roles.load(true);
              const found = (await core.roles.list({ kind: "system", label: "sso" })).roles.find((r) => r.id === role || r.name === role);
              if (found) await core.roles.addMember({ kind: "system", label: "sso" }, found.id, { id: user.id });
            }
            cookie = (await startSession(req, user, "sso")).cookie;
            audit(actorOf(user), "auth.login", { method: "sso", created: true });
          } else return back("oidc_not_invited", { email: who.email });
        }
        return redirect(`${adminPath}${String(kept.next ?? "")}`, [cookie]);
      } catch (e) {
        if (e instanceof OidcError) return back("oidc_failed", { reason: e.reason });
        if (isCmsError(e)) return back(e.code, Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, String(v)])));
        throw e;
      }
    }

    if (a === "reauth" && m === "POST") {
      ipLimited(req);
      const s = await me(req, true);
      const i = await body(req, z.object({ password: z.string().max(1024) }));
      const v = await verifyPassword(i.password, s.user.passwordHash, hashParams);
      if (!v.ok) {
        await countFail(s.user.email);
        throw fail("password_wrong");
      }
      await confirm(s.id);
      return json({ ok: true });
    }

    if (a === "policy") {
      if (m === "GET") {
        await requireAdmin(req);
        return json(await policy());
      }
      if (m === "PATCH") {
        const s = await requireAdmin(req);
        const i = await body(req, z.object({ requireMfa: z.boolean() }));
        const r = await repo.findRecordByKey(POLICY, "policy");
        if (r) await repo.updateRecord(POLICY, r.id, { data: { requireMfa: i.requireMfa }, at: iso() });
        else await repo.insertRecord({ kind: POLICY, key: "policy", data: { requireMfa: i.requireMfa }, at: iso() });
        audit(actorOf(s.user), "auth.policy", { requireMfa: i.requireMfa });
        return json(await policy());
      }
    }

    if (a === "me") return meRoutes(req, m, b, c);

    throw fail("route_not_found");
  }

  function safeNext(next: string | null): string {
    if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "";
    return next.slice(0, 300);
  }

  async function passkeyList(userId: string) {
    return (await passkeysOf(userId)).map((p) => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, synced: p.backedUp }));
  }

  async function meRoutes(req: Request, m: string, b?: string, c?: string): Promise<Response> {
    if (!b && m === "GET") {
      const s = await me(req, true);
      return json({ user: await publicUser(s.user), prefs: s.user.prefs, passkeys: await passkeyList(s.user.id), recoveryLeft: s.user.recovery.length, mfaSetup: s.data.mfaSetup, confirmedUntil: new Date(Date.parse(s.data.confirmedAt) + REAUTH_MS).toISOString(), canChangeEmail: false });
    }
    if (!b && m === "PATCH") {
      const s = await me(req);
      const i = await body(req, z.object({ name: z.string().max(120).nullable().optional(), prefs: z.object({ theme: z.enum(["light", "dark", "system"]).optional(), locale: z.string().max(10).optional() }).strict().optional() }).strict());
      const u = await saveUser(s.user, { ...(i.name !== undefined ? { name: i.name?.trim() || null } : {}), ...(i.prefs ? { prefs: { ...s.user.prefs, ...i.prefs } } : {}) });
      return json({ user: await publicUser(u), prefs: u.prefs });
    }
    if (b === "password" && m === "POST") {
      const s = await me(req);
      const i = await body(req, z.object({ current: z.string().max(1024).optional(), password: NewPassword }));
      if (s.user.passwordHash) {
        const v = await verifyPassword(i.current ?? "", s.user.passwordHash, hashParams);
        if (!v.ok) throw fail("password_wrong");
      } else if (!recentlyConfirmed(s)) throw fail("reauth_required", {}, { status: 401 });
      checkPassword(i.password, s.user);
      const u = await saveUser(s.user, { passwordHash: await hashPassword(i.password, hashParams) });
      // A new password ends every other session (whoever knew the old one is out).
      const ended = await endSessions(u.id, s.id);
      await confirm(s.id);
      audit(actorOf(u), "auth.password", { endedSessions: ended });
      return json({ ok: true, endedSessions: ended });
    }
    if (b === "sessions" && m === "GET") {
      const s = await me(req);
      return json({ sessions: await sessionsOf(s.user.id, s.id) });
    }
    if (b === "sessions" && m === "DELETE") {
      const s = await me(req);
      if (c) {
        const r = await repo.findRecord(SESSION, c);
        if (!r || r.scope !== s.user.id) throw fail("not_found");
        await repo.deleteRecords({ kind: SESSION, id: c });
        audit(actorOf(s.user), "auth.sessions_end", { count: 1 });
        return json({ ok: true, ended: 1, signedOut: c === s.id }, 200, c === s.id ? [sessionCookie(req, "", 0)] : []);
      }
      const n = await endSessions(s.user.id, s.id);
      audit(actorOf(s.user), "auth.sessions_end", { count: n });
      return json({ ok: true, ended: n });
    }
    if (b === "totp" && m === "POST") {
      const s = await me(req, true);
      const i = await body(req, z.object({ code: z.string().max(20).optional() }));
      if (!i.code) {
        if (s.user.totp && !recentlyConfirmed(s)) throw fail("reauth_required", {}, { status: 401 });
        const secret = newTotpSecret();
        await saveUser(s.user, { pendingTotp: { ...seal(secret), at: iso() } });
        const uri = otpauthUrl({ secret, account: s.user.email, issuer: appName });
        return json({ secret, uri, svg: qrSvg(uri, { label: `${appName} ${s.user.email}` }) });
      }
      const p = s.user.pendingTotp;
      if (!p || now().getTime() - Date.parse(p.at) > 15 * MIN) throw fail("totp_not_started");
      const step = verifyTotp(unseal(p), i.code, now().getTime());
      if (step === null) throw fail("mfa_invalid");
      const codes = newRecoveryCodes();
      const u = await saveUser(s.user, { totp: { secret: p.secret, sealed: p.sealed, lastStep: step, at: iso() }, pendingTotp: null, recovery: codes.map((x) => sha(normalizeRecovery(x))) });
      if (s.data.mfaSetup) await repo.updateRecord(SESSION, s.id, { data: { ...s.data, mfaSetup: false } as unknown as Record<string, unknown>, at: iso() });
      audit(actorOf(u), "auth.mfa_on");
      return json({ ok: true, recoveryCodes: codes });
    }
    if (b === "totp" && m === "DELETE") {
      const s = await requireConfirmed(req);
      if ((await policy()).requireMfa && (await passkeysOf(s.user.id)).length === 0) throw fail("mfa_setup_required");
      const u = await saveUser(s.user, { totp: null, pendingTotp: null, recovery: [] });
      audit(actorOf(u), "auth.mfa_off");
      return json({ ok: true });
    }
    if (b === "recovery" && m === "POST") {
      const s = await requireConfirmed(req);
      if (!s.user.totp) throw fail("totp_not_started");
      const codes = newRecoveryCodes();
      await saveUser(s.user, { recovery: codes.map((x) => sha(normalizeRecovery(x))) });
      audit(actorOf(s.user), "auth.recovery");
      return json({ recoveryCodes: codes });
    }
    if (b === "passkeys" && c && m === "PATCH") {
      const s = await me(req);
      const i = await body(req, z.object({ label: z.string().trim().min(1).max(60) }));
      const r = await repo.findRecord(PASSKEY, c);
      if (!r || r.scope !== s.user.id) throw fail("not_found");
      await repo.updateRecord(PASSKEY, c, { data: { ...r.data, label: i.label }, at: iso() });
      return json({ passkeys: await passkeyList(s.user.id) });
    }
    if (b === "passkeys" && c && m === "DELETE") {
      const s = await requireConfirmed(req);
      const r = await repo.findRecord(PASSKEY, c);
      if (!r || r.scope !== s.user.id) throw fail("not_found");
      const left = (await passkeysOf(s.user.id)).length - 1;
      // The last way in cannot be removed.
      if (left === 0 && !s.user.passwordHash && !s.user.oidcSub) throw fail("passkey_invalid", { reason: "it is your only way to sign in; add a password first" });
      if (left === 0 && (await policy()).requireMfa && !s.user.totp) throw fail("mfa_setup_required");
      await repo.deleteRecords({ kind: PASSKEY, id: c });
      audit(actorOf(s.user), "auth.passkey_remove", { label: (r.data as { label?: string }).label ?? "" });
      return json({ passkeys: await passkeyList(s.user.id) });
    }
    throw fail("route_not_found");
  }

  async function users(req: Request, seg: string[]): Promise<Response> {
    const m = req.method.toUpperCase();
    const [a, b, c] = seg;
    const s = await requireAdmin(req);
    const actor = actorOf(s.user);
    if (!a && m === "GET") {
      const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
      const list = await Promise.all((await allUsers()).filter((u) => !q || u.email.includes(q) || (u.name ?? "").toLowerCase().includes(q)).map(publicUser));
      return json({ users: list, invites: (await invites()).filter((i) => !q || i.email.includes(q)), policy: await policy(), mail: !!o.sendMail, sso: oidc ? { label: oidc.label } : null });
    }
    if (a === "invite" && m === "POST") {
      const i = await body(req, z.object({ emails: z.array(z.string().max(254)).min(1).max(50), roleId: z.string().max(100).nullable().optional(), admin: z.boolean().optional() }));
      const emails = [...new Set(i.emails.map(cleanEmail))];
      if (i.roleId) {
        await core.roles.load(true);
        if (!(await core.roles.list(actor)).roles.some((r) => r.id === i.roleId)) throw fail("role_not_found");
      }
      const out: { email: string; link: string; sent: boolean }[] = [];
      for (const email of emails) {
        if (await userByEmail(email)) throw fail("email_taken", { email });
      }
      for (const email of emails) {
        // A new invitation replaces an old one for the same address.
        for (const old of (await invites()).filter((x) => x.email === email)) await repo.deleteRecords({ kind: TOKEN, id: old.id });
        const t = await newToken("invite", { email, roleId: i.roleId ?? null, isAdmin: !!i.admin, invitedBy: s.user.id, invitedByLabel: s.user.name || s.user.email }, 7 * DAY);
        const url = link(req, "invite", t.raw);
        const sent = await mail({ to: email, ...MAILS[locale].invite(s.user.name || s.user.email, url) });
        out.push({ email, link: url, sent });
        audit(actor, "auth.invite", { email, admin: !!i.admin, roleId: i.roleId ?? null });
      }
      return json({ invites: out }, 201);
    }
    if (a === "invites" && b && !c && m === "DELETE") {
      const r = await repo.findRecord(TOKEN, b);
      if (!r || r.scope !== "invite") throw fail("invite_invalid");
      await repo.deleteRecords({ kind: TOKEN, id: b });
      audit(actor, "auth.invite_revoke", { email: (r.data as TokenData).email });
      return json({ ok: true });
    }
    if (a === "invites" && b && c === "resend" && m === "POST") {
      const r = await repo.findRecord(TOKEN, b);
      if (!r || r.scope !== "invite") throw fail("invite_invalid");
      const d = r.data as TokenData;
      await repo.deleteRecords({ kind: TOKEN, id: b });
      const t = await newToken("invite", { ...d }, 7 * DAY);
      const url = link(req, "invite", t.raw);
      const sent = await mail({ to: String(d.email), ...MAILS[locale].invite(s.user.name || s.user.email, url) });
      audit(actor, "auth.invite", { email: d.email, resent: true });
      return json({ email: d.email, link: url, sent });
    }
    if (a && !b && m === "PATCH") {
      const i = await body(req, z.object({ name: z.string().max(120).nullable().optional(), disabled: z.boolean().optional(), admin: z.boolean().optional(), roleId: z.string().max(100).nullable().optional() }).strict());
      let u = await findUser(a);
      if (!u) throw fail("user_not_found");
      const sensitive = i.disabled !== undefined || i.admin !== undefined;
      if (sensitive && !recentlyConfirmed(s)) throw fail("reauth_required", {}, { status: 401 });
      const losingAdmin = u.isAdmin && (i.admin === false || i.disabled === true);
      if (losingAdmin && (await admins()).filter((x) => x.id !== u!.id).length === 0) throw fail("user_last_admin");
      const patch: Partial<UserData> = {};
      if (i.name !== undefined) patch.name = i.name?.trim() || null;
      if (i.admin !== undefined) patch.isAdmin = i.admin;
      if (i.disabled !== undefined) patch.disabledAt = i.disabled ? iso() : null;
      u = await saveUser(u, patch);
      // Switched off or demoted: their sessions end now, not at the next sign-in.
      if (i.disabled || i.admin === false) await endSessions(u.id);
      if (i.roleId !== undefined) await setRole(actor, u.id, i.roleId);
      audit(actor, "auth.user_update", { id: u.id, email: u.email, ...i });
      return json({ user: await publicUser(u) });
    }
    if (a && b === "reset-link" && m === "POST") {
      const u = await findUser(a);
      if (!u) throw fail("user_not_found");
      const t = await newToken("reset", { userId: u.id }, 60 * MIN);
      const url = link(req, "reset", t.raw);
      const sent = await mail({ to: u.email, ...MAILS[locale].reset(url) });
      audit(actor, "auth.reset_link", { id: u.id, email: u.email, sent });
      return json({ link: url, sent });
    }
    if (a && b === "sessions" && m === "DELETE") {
      const u = await findUser(a);
      if (!u) throw fail("user_not_found");
      const n = await endSessions(u.id, u.id === s.user.id ? s.id : undefined);
      audit(actor, "auth.sessions_end", { id: u.id, count: n });
      return json({ ended: n });
    }
    throw fail("route_not_found");
  }

  return {
    /** For `createCmsHandler({ resolveUser })`: the person behind the session cookie. */
    async resolveUser(req: Request): Promise<Extract<Actor, { kind: "user" }> | null> {
      const s = await sessionOf(req);
      return s ? actorOf(s.user) : null;
    },
    /** Answers `/auth/*` and `/users/*` (the CMS handler calls this). */
    handle,
    /** True when the person behind this request confirmed it is them in the last 10 minutes (sign-in, password, passkey). */
    async confirmed(req: Request): Promise<boolean> {
      const s = await sessionOf(req);
      return !!s && recentlyConfirmed(s);
    },
    /** True when this request has a session of this sign-in (not a key, not the app's own login). */
    async hasSession(req: Request): Promise<boolean> {
      return !!(await sessionOf(req, { allowSetup: true }));
    },
    /** Make a person from code or the CLI. */
    async createUser(input: { email: string; name?: string | null; password?: string | null; isAdmin?: boolean }): Promise<PublicUser> {
      return publicUser(await createUser(input));
    },
    /** The setup code when no one can sign in yet (also printed). */
    setupCode,
    /** For `_me`: what the screens need to know. */
    describe() {
      return { passwords, passkeys: true, sso: oidc ? { label: oidc.label } : null, mail: !!o.sendMail, adminPath };
    },
    /** A reset link for someone (CLI `user reset`). */
    async resetLink(email: string, origin?: string): Promise<string> {
      const u = await userByEmail(email);
      if (!u) throw fail("user_not_found");
      const t = await newToken("reset", { userId: u.id }, 60 * MIN);
      return `${(origin ?? o.origin ?? "").replace(/\/$/, "")}${adminPath}/reset#${t.raw}`;
    },
    /** Constant-time compare, exported for tests of the cookie format. */
    _equal: (x: string, y: string) => x.length === y.length && timingSafeEqual(Buffer.from(x), Buffer.from(y)),
    _b64url: b64url,
  };
}

export type CmsAuth = ReturnType<typeof createAuth>;
