/** 0.16.0: the CMS's own sign-in (passwords, two-step codes, passkeys, SSO, invitations, people). */

import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes, sign as signData, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { createAuth } from "./auth";
import { createOidc } from "./auth/oidc";
import { hashPassword, isCommon, passwordProblem, verifyPassword } from "./auth/password";
import { base32Encode, totp, verifyTotp } from "./auth/totp";
import { cborEncode, verifyAssertion } from "./auth/webauthn";
import { createCms, defineCollection } from "./cms";
import { createCmsHandler } from "./http";
import { API_ROUTES } from "./openapi";
import { MemoryRepo } from "./repo";

const FAST = { logN: 10, r: 8, p: 1 };
const ORIGIN = "http://cms.test";

function setup(o: { oidc?: Parameters<typeof createAuth>[0]["oidc"]; mail?: boolean } = {}) {
  const clock = { t: Date.parse("2026-11-22T00:00:00Z") };
  const lines: string[] = [];
  const mails: { to: string; subject: string; text: string }[] = [];
  const guide = defineCollection({ slug: "guide", label: "Guide", visibility: "public" });
  const cms = createCms({ repo: new MemoryRepo(), collections: [guide], now: () => new Date(clock.t), warn: () => {}, secretsKey: "k".repeat(40) });
  const auth = createAuth({ cms, hash: FAST, log: (l) => lines.push(l), oidc: o.oidc, appName: "Test CMS", sendMail: o.mail ? async (m) => void mails.push(m) : undefined });
  const handler = createCmsHandler({ cms, auth });
  /** A browser: keeps cookies, sends its origin on writes. */
  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? (init.body === undefined ? "GET" : "POST");
      const res = await handler(
        new Request(`${ORIGIN}/api/cms${path}`, {
          method,
          headers: { "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", "x-forwarded-for": "203.0.113.9", ...(method !== "GET" ? { origin: ORIGIN } : {}), ...init.headers },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
      );
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const i = pair.indexOf("=");
        const name = pair.slice(0, i);
        const value = pair.slice(i + 1);
        if (/max-age=0/i.test(attrs.join(";")) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
      const text = res.status === 303 ? "" : await res.text();
      return { status: res.status, res, body: (text ? JSON.parse(text) : {}) as Record<string, any>, location: res.headers.get("location") };
    };
    return { call, jar };
  };
  return { cms, auth, handler, clock, lines, mails, browser };
}

const setupCode = (lines: string[]) => /setup code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.at(-1) ?? "")?.[1] ?? "";

async function firstAdmin(s: ReturnType<typeof setup>) {
  const b = s.browser();
  const st = await b.call("/auth/state");
  assert.equal(st.body.setup, true);
  const r = await b.call("/auth/setup", { body: { code: setupCode(s.lines), email: "Park@Example.com", name: "Park Jiwoo", password: "correct horse battery" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return b;
}

// ── pieces ───────────────────────────────────────────────────────────────────

test("passwords: scrypt with its parameters in the hash, weaker hashes are upgraded, no account takes the same path", async () => {
  const h = await hashPassword("correct horse battery", FAST);
  assert.match(h, /^scrypt\$10\$8\$1\$/);
  assert.deepEqual(await verifyPassword("correct horse battery", h, FAST), { ok: true, rehash: false });
  assert.deepEqual(await verifyPassword("wrong", h, FAST), { ok: false, rehash: false });
  assert.deepEqual(await verifyPassword("correct horse battery", h, { logN: 11, r: 8, p: 1 }), { ok: true, rehash: true });
  assert.deepEqual(await verifyPassword("anything", null, FAST), { ok: false, rehash: false });
  assert.equal(passwordProblem("short")?.code, "password_weak");
  assert.equal(passwordProblem("aaaaaaaaaaaaaa")?.code, "password_common");
  assert.equal(passwordProblem("abcdefghijklmn")?.code, "password_common");
  assert.equal(passwordProblem("Dragon2026!!!!")?.code, "password_common");
  assert.equal(passwordProblem("jiwoo.park2026", { email: "jiwoo.park@example.com" })?.code, "password_common");
  assert.equal(passwordProblem("monkeymonkey12")?.code, "password_common");
  assert.equal(passwordProblem("correct horse battery"), null);
  assert.equal(passwordProblem("한글로 된 긴 비밀번호입니다"), null);
  assert.ok(isCommon("Password123"));
});

test("totp: RFC 6238 test vectors, one step of drift, a used step is refused", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1234567890, "005924"], [2000000000, "279037"]] as const) assert.equal(totp(secret, t * 1000), code);
  const at = 1234567890_000;
  const step = verifyTotp(secret, "005924", at);
  assert.equal(step, Math.floor(1234567890 / 30));
  assert.equal(verifyTotp(secret, "005924", at, step), null, "the same code twice");
  assert.equal(verifyTotp(secret, totp(secret, at - 30_000), at), step! - 1, "30 seconds behind");
  assert.equal(verifyTotp(secret, totp(secret, at - 90_000), at), null, "too old");
  assert.equal(verifyTotp(secret, "12345", at), null);
});

// ── a software authenticator ─────────────────────────────────────────────────

function authenticator(kind: "ES256" | "RS256" = "ES256") {
  const { privateKey, publicKey } = kind === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const id = randomBytes(16);
  let count = 0;
  const jwk = publicKey.export({ format: "jwk" });
  const cose = kind === "ES256" ? new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]) : new Map<any, any>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n!, "base64url")], [-2, Buffer.from(jwk.e!, "base64url")]]);
  const rpHash = (rpId: string) => createHash("sha256").update(rpId).digest();
  const authData = (rpId: string, withCred: boolean, flags = 0x05) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    if (!withCred) return Buffer.concat([rpHash(rpId), Buffer.from([flags]), c]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    return Buffer.concat([rpHash(rpId), Buffer.from([flags | 0x40]), c, Buffer.alloc(16), len, id, cborEncode(cose)]);
  };
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: id.toString("base64url"),
    create(opts: { challenge: string; rp: { id: string } }, origin = ORIGIN) {
      count = 0;
      const att = cborEncode(new Map<any, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(opts.rp.id, true)]]));
      return { id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", response: { clientDataJSON: clientData("webauthn.create", opts.challenge, origin).toString("base64url"), attestationObject: att.toString("base64url"), transports: ["internal"] } };
    },
    get(opts: { challenge: string; rpId: string }, userId: string, o: { origin?: string; key?: KeyObject; keepCount?: boolean } = {}) {
      if (!o.keepCount) count++;
      const ad = authData(opts.rpId, false);
      const cd = clientData("webauthn.get", opts.challenge, o.origin ?? ORIGIN);
      const data = Buffer.concat([ad, createHash("sha256").update(cd).digest()]);
      const sig = kind === "ES256" ? signData("sha256", data, { key: o.key ?? privateKey, dsaEncoding: "der" }) : createSign("sha256").update(data).sign(o.key ?? privateKey);
      return { id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", response: { clientDataJSON: cd.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url"), userHandle: Buffer.from(userId).toString("base64url") } };
    },
  };
}

// ── flows through the handler ────────────────────────────────────────────────

test("setup: the first admin needs the printed code; afterwards setup is closed and the state shows who is in", async () => {
  const s = setup();
  const b = s.browser();
  const st = await b.call("/auth/state");
  assert.deepEqual([st.body.setup, st.body.methods.password, st.body.methods.passkey, st.body.methods.sso, st.body.user], [true, true, true, null, null]);
  assert.match(s.lines.at(-1)!, /Open http:\/\/cms\.test\/admin\/setup and enter the setup code [A-Z0-9]{4}-[A-Z0-9]{4}/);
  assert.equal((await b.call("/auth/setup", { body: { code: "AAAA-AAAA", email: "a@example.com", password: "correct horse battery" } })).body.error, "setup_invalid");
  assert.equal((await b.call("/auth/setup", { body: { code: setupCode(s.lines), email: "a@example.com", password: "password12345" } })).body.error, "password_common");
  const ok = await b.call("/auth/setup", { body: { code: setupCode(s.lines).toLowerCase(), email: "Park@Example.com", name: "Park", password: "correct horse battery" } });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.user.email, ok.body.user.isAdmin], ["park@example.com", true]);
  assert.ok(b.jar.has("cms_session"), "a session cookie (http: no __Host- prefix)");
  const me = await b.call("/_me");
  assert.deepEqual([me.body.actor.kind, me.body.actor.label, me.body.isAdmin, me.body.auth.people], ["user", "Park", true, true]);
  assert.equal((await s.browser().call("/auth/setup", { body: { code: "AAAA-AAAA", email: "b@example.com", password: "correct horse battery" } })).body.error, "setup_done");
  assert.equal((await s.browser().call("/auth/state")).body.setup, false);
});

test("sessions: https cookies are __Host- and Secure; wrong passwords lock password sign-in for 15 minutes; a stranger's page cannot post", async () => {
  const s = setup();
  await firstAdmin(s);
  const res = await s.handler(new Request("https://cms.test/api/cms/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "https://cms.test" }, body: JSON.stringify({ email: "park@example.com", password: "correct horse battery" }) }));
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-cms_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000; Secure$/);
  const evil = await s.handler(new Request(`${ORIGIN}/api/cms/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }));
  assert.equal(evil.status, 403);
  const b = s.browser();
  for (let i = 0; i < 10; i++) assert.equal((await b.call("/auth/login", { body: { email: "park@example.com", password: `wrong ${i}` } })).body.error, "login_failed");
  const locked = await b.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  assert.deepEqual([locked.status, locked.body.error, locked.res.headers.get("retry-after")], [429, "login_locked", "900"]);
  assert.equal((await b.call("/auth/login", { body: { email: "nobody@example.com", password: "whatever at all" } })).body.error, "login_failed", "an unknown email answers the same");
  s.clock.t += 16 * 60_000;
  assert.equal((await b.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } })).status, 200);
  // The session slides and ends.
  s.clock.t += 31 * 86_400_000;
  assert.equal((await b.call("/_me")).body.actor.kind, "anonymous", "30 days unused");
});

test("two-step: setup shows a QR code, sign-in then asks for a code, recovery codes work once, a trusted device skips it", async () => {
  const s = setup();
  const b = await firstAdmin(s);
  const start = await b.call("/auth/me/totp", { body: {} });
  assert.match(start.body.svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.match(start.body.uri, /^otpauth:\/\/totp\/Test%20CMS%3Apark%40example\.com\?secret=[A-Z2-7]{32}&issuer=Test%20CMS/);
  assert.equal((await b.call("/auth/me/totp", { body: { code: "000000" } })).body.error, "mfa_invalid");
  const on = await b.call("/auth/me/totp", { body: { code: totp(start.body.secret, s.clock.t) } });
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.match(on.body.recoveryCodes[0], /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  const c = s.browser();
  const first = await c.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  assert.equal(first.body.mfa, true);
  assert.equal(c.jar.size, 0, "no session before the code");
  s.clock.t += 30_000;
  assert.equal((await c.call("/auth/mfa", { body: { ticket: first.body.ticket, code: "123456" } })).body.error, "mfa_invalid");
  const done = await c.call("/auth/mfa", { body: { ticket: first.body.ticket, code: totp(start.body.secret, s.clock.t), remember: true } });
  assert.equal(done.status, 200);
  assert.ok(c.jar.has("cms_trust"));
  assert.equal((await c.call("/auth/mfa", { body: { ticket: first.body.ticket, code: totp(start.body.secret, s.clock.t) } })).body.error, "mfa_ticket_invalid", "a ticket works once");
  // Trusted for 30 days: the next sign-in needs no code.
  await c.call("/auth/logout", { body: {} });
  assert.equal((await c.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } })).body.ok, true);

  const d = s.browser();
  const t2 = await d.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  const rec = await d.call("/auth/mfa", { body: { ticket: t2.body.ticket, recovery: on.body.recoveryCodes[0].toUpperCase().replace(/-/g, " ") } });
  assert.deepEqual([rec.status, rec.body.recoveryLeft], [200, 9]);
  const e = s.browser();
  const t3 = await e.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  assert.equal((await e.call("/auth/mfa", { body: { ticket: t3.body.ticket, recovery: on.body.recoveryCodes[0] } })).body.error, "mfa_invalid", "a recovery code works once");

  // Turning it off needs a fresh confirmation.
  s.clock.t += 11 * 60_000;
  assert.equal((await b.call("/auth/me/totp", { method: "DELETE" })).body.error, "reauth_required");
  assert.equal((await b.call("/auth/reauth", { body: { password: "wrong" } })).body.error, "password_wrong");
  assert.equal((await b.call("/auth/reauth", { body: { password: "correct horse battery" } })).status, 200);
  assert.equal((await b.call("/auth/me/totp", { method: "DELETE" })).status, 200);
});

test("passkeys: register after confirming, sign in without an email (ES256 and RS256), refuse other sites, other keys and counters that go back", async () => {
  for (const kind of ["ES256", "RS256"] as const) {
    const s = setup();
    const b = await firstAdmin(s);
    const key = authenticator(kind);
    const opt = await b.call("/auth/passkey/options", { body: { purpose: "register" } });
    assert.deepEqual([opt.body.publicKey.rp.id, opt.body.publicKey.authenticatorSelection.residentKey, opt.body.publicKey.attestation], ["cms.test", "required", "none"]);
    const reg = await b.call("/auth/passkey/verify", { body: { challengeId: opt.body.challengeId, credential: key.create(opt.body.publicKey), label: "MacBook" } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.deepEqual(reg.body.passkeys.map((p: { label: string }) => p.label), ["MacBook"]);

    const c = s.browser();
    const lo = await c.call("/auth/passkey/options", { body: { purpose: "login" } });
    assert.deepEqual(lo.body.publicKey.allowCredentials, []);
    const me = (await b.call("/auth/me")).body.user;
    const ok = await c.call("/auth/passkey/verify", { body: { challengeId: lo.body.challengeId, credential: key.get(lo.body.publicKey, me.id) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await c.call("/_me")).body.actor.label, "Park Jiwoo");

    const again = await c.call("/auth/passkey/options", { body: { purpose: "login" } });
    const bad = await c.call("/auth/passkey/verify", { body: { challengeId: again.body.challengeId, credential: key.get(again.body.publicKey, me.id, { keepCount: true }) } });
    assert.match(bad.body.message, /counter went back/);
    const o3 = await c.call("/auth/passkey/options", { body: { purpose: "login" } });
    assert.match((await c.call("/auth/passkey/verify", { body: { challengeId: o3.body.challengeId, credential: key.get(o3.body.publicKey, me.id, { origin: "https://evil.example" }) } })).body.message, /origin/);
    const o4 = await c.call("/auth/passkey/options", { body: { purpose: "login" } });
    const other = kind === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey : generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    assert.match((await c.call("/auth/passkey/verify", { body: { challengeId: o4.body.challengeId, credential: key.get(o4.body.publicKey, me.id, { key: other }) } })).body.message, /signature/);
    assert.equal((await c.call("/auth/passkey/verify", { body: { challengeId: o4.body.challengeId, credential: key.get(o4.body.publicKey, me.id) } })).body.error, "passkey_invalid", "a challenge works once");
  }
});

test("passkeys: the low-level check refuses a response for another site", () => {
  const key = authenticator();
  const res = key.get({ challenge: "abc", rpId: "evil.example" }, "u1");
  assert.throws(() => verifyAssertion(res, { challenge: "abc", rp: { id: "cms.test", name: "x", origins: [ORIGIN] }, jwk: { kty: "EC" }, alg: -7, signCount: 0, userId: "u1" }), /another site/);
});

test("people: invite with a role, accept with a password, switch off ends their sessions now, the last admin stays, reset links work once", async () => {
  const s = setup({ mail: true });
  const b = await firstAdmin(s);
  const admin = { kind: "system" as const, label: "test" };
  const role = await s.cms.core.roles.create(admin, { name: "Writers", permissions: { guide: { read: true, write: true } } });
  const inv = await b.call("/users/invite", { body: { emails: ["lee@example.com", "Kim@Example.com"], roleId: role.id } });
  assert.equal(inv.status, 201);
  assert.deepEqual(inv.body.invites.map((i: { email: string; sent: boolean }) => [i.email, i.sent]), [["lee@example.com", true], ["kim@example.com", true]]);
  assert.match(s.mails[0].subject, /Park Jiwoo invited you to Test CMS/);
  const linkTok = /#([\w-]+)$/.exec(inv.body.invites[0].link)![1];
  assert.match(inv.body.invites[0].link, /^http:\/\/cms\.test\/admin\/invite#/);
  const list = await b.call("/users");
  assert.deepEqual([list.body.users.length, list.body.invites.length], [1, 2]);

  const lee = s.browser();
  assert.deepEqual((await lee.call(`/auth/invite/${linkTok}`)).body, { email: "lee@example.com", invitedBy: "Park Jiwoo", isAdmin: false, exists: false });
  const acc = await lee.call(`/auth/invite/${linkTok}`, { body: { name: "Lee Minho", password: "lee's long passphrase" } });
  assert.equal(acc.status, 201);
  assert.deepEqual(acc.body.user.roles.map((r: { name: string }) => r.name), ["Writers"]);
  assert.equal((await lee.call(`/auth/invite/${linkTok}`)).body.error, "invite_invalid", "an invitation works once");
  assert.equal((await lee.call("/collections/guide", { body: { doc: { slug: "x", title: "X", body: "x\n" } } })).status, 201, "the role lets Lee write");
  assert.equal((await lee.call("/users")).body.error, "forbidden_admin");

  const people = (await b.call("/users")).body.users as { id: string; email: string }[];
  const leeId = people.find((p) => p.email === "lee@example.com")!.id;
  const parkId = people.find((p) => p.email === "park@example.com")!.id;
  assert.equal((await b.call(`/users/${leeId}`, { method: "PATCH", body: { disabled: true } })).status, 200, "fresh sign-in counts as confirmed");
  assert.equal((await lee.call("/_me")).body.actor.kind, "anonymous", "their session ended at once");
  assert.equal((await lee.call("/auth/login", { body: { email: "lee@example.com", password: "lee's long passphrase" } })).body.error, "login_failed");
  assert.equal((await b.call(`/users/${parkId}`, { method: "PATCH", body: { admin: false } })).body.error, "user_last_admin");

  // Reset: the same answer for unknown emails; the link works once and ends every session.
  const n = s.mails.length;
  assert.deepEqual((await s.browser().call("/auth/reset/request", { body: { email: "nobody@example.com" } })).body, { ok: true, mail: true });
  assert.equal(s.mails.length, n);
  await s.browser().call("/auth/reset/request", { body: { email: "park@example.com" } });
  await new Promise((r) => setTimeout(r, 10));
  const resetTok = /#([\w-]+)/.exec(s.mails.at(-1)!.text)![1];
  const r = s.browser();
  assert.equal((await r.call(`/auth/reset?token=${resetTok}`)).body.email, "park@example.com");
  assert.equal((await r.call("/auth/reset", { body: { token: resetTok, password: "short" } })).body.error, "password_weak");
  assert.equal((await r.call("/auth/reset", { body: { token: resetTok, password: "a brand new passphrase" } })).status, 200);
  assert.equal((await b.call("/_me")).body.actor.kind, "anonymous", "the old session ended");
  assert.equal((await r.call("/auth/reset", { body: { token: resetTok, password: "another new passphrase" } })).body.error, "reset_invalid");
  // Withdrawn invitations stop working.
  const kim = (await r.call("/users")).body.invites[0];
  await r.call(`/users/invites/${kim.id}`, { method: "DELETE" });
  assert.equal((await r.call("/users")).body.invites.length, 0);
});

test("account: devices list and sign-out, a password change ends the others, keys need a fresh confirmation, the policy can require two-step", async () => {
  const s = setup();
  const b = await firstAdmin(s);
  const other = s.browser();
  await other.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  const list = await b.call("/auth/me/sessions");
  assert.equal(list.body.sessions.length, 2);
  assert.equal(list.body.sessions[0].device, "Chrome · macOS");
  assert.equal(list.body.sessions.filter((x: { current: boolean }) => x.current).length, 1);
  const theirs = list.body.sessions.find((x: { current: boolean }) => !x.current);
  await b.call(`/auth/me/sessions/${theirs.id}`, { method: "DELETE" });
  assert.equal((await other.call("/_me")).body.actor.kind, "anonymous");
  await other.call("/auth/login", { body: { email: "park@example.com", password: "correct horse battery" } });
  assert.equal((await b.call("/auth/me/password", { body: { current: "nope", password: "a different passphrase" } })).body.error, "password_wrong");
  const ch = await b.call("/auth/me/password", { body: { current: "correct horse battery", password: "a different passphrase" } });
  assert.equal(ch.body.endedSessions, 1);
  assert.equal((await other.call("/_me")).body.actor.kind, "anonymous");
  assert.equal((await b.call("/_me")).body.actor.kind, "user", "mine stays");
  // Preferences.
  const p = await b.call("/auth/me", { method: "PATCH", body: { prefs: { theme: "dark", locale: "ko" } } });
  assert.deepEqual(p.body.prefs, { theme: "dark", locale: "ko" });
  // Keys: within 10 minutes of confirming, fine; later, confirm again.
  assert.equal((await b.call("/keys", { body: { name: "bot", scopes: ["read"] } })).status, 201);
  s.clock.t += 11 * 60_000;
  assert.equal((await b.call("/keys", { body: { name: "bot2", scopes: ["read"] } })).body.error, "reauth_required");
  // Policy: everyone needs two-step; a person without it signs in to the setup step only.
  await b.call("/auth/reauth", { body: { password: "a different passphrase" } });
  assert.deepEqual((await b.call("/auth/policy", { method: "PATCH", body: { requireMfa: true } })).body, { requireMfa: true });
  const c = s.browser();
  const li = await c.call("/auth/login", { body: { email: "park@example.com", password: "a different passphrase" } });
  assert.equal(li.body.mfaSetup, true);
  assert.equal((await c.call("/_me")).body.actor.kind, "anonymous", "nothing else until two-step is set up");
  assert.equal((await c.call("/auth/state")).body.mfaSetup, true);
  const start = await c.call("/auth/me/totp", { body: {} });
  await c.call("/auth/me/totp", { body: { code: totp(start.body.secret, s.clock.t) } });
  assert.equal((await c.call("/_me")).body.actor.kind, "user");
});

test("sso: code flow with PKCE against a provider; wrong nonce, wrong signature, other domains and unverified emails are refused", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const issuer = "https://idp.test";
  let claims: Record<string, unknown> = {};
  let signer: KeyObject = privateKey;
  let lastToken: Record<string, string> = {};
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (u === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (u === `${issuer}/token`) {
      lastToken = Object.fromEntries(new URLSearchParams(String(init?.body)));
      const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = createSign("sha256").update(`${head}.${payload}`).sign(signer).toString("base64url");
      return Response.json({ id_token: `${head}.${payload}.${sig}`, access_token: "x" });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const s = setup({ oidc: { issuer, clientId: "cms", clientSecret: "shh", label: "Example SSO", allowedDomains: ["corp.example"], fetch: fetchStub } });
  await firstAdmin(s);
  const signIn = async (o: { email: string; nonce?: string; verified?: boolean }) => {
    const b = s.browser();
    const start = await b.call("/auth/oidc/start?next=/guide");
    assert.equal(start.status, 303);
    const to = new URL(start.location!);
    assert.equal(to.origin + to.pathname, `${issuer}/auth`);
    assert.deepEqual([to.searchParams.get("code_challenge_method"), to.searchParams.get("redirect_uri")], ["S256", "http://cms.test/api/cms/auth/oidc/callback"]);
    claims = { iss: issuer, aud: "cms", sub: `sub-${o.email}`, email: o.email, email_verified: o.verified ?? true, name: "Choi Yuna", exp: Math.floor(s.clock.t / 1000) + 300, iat: Math.floor(s.clock.t / 1000), nonce: o.nonce ?? to.searchParams.get("nonce") };
    const back = await b.call(`/auth/oidc/callback?code=abc&state=${to.searchParams.get("state")}`);
    assert.equal(createHash("sha256").update(lastToken.code_verifier ?? "").digest("base64url"), to.searchParams.get("code_challenge"), "the verifier matches the challenge");
    return { b, back };
  };
  const ok = await signIn({ email: "yuna@corp.example" });
  assert.equal(ok.back.location, "/admin/guide");
  assert.equal((await ok.b.call("/_me")).body.actor.label, "Choi Yuna");
  assert.match((await signIn({ email: "x@other.example" })).back.location!, /error=oidc_domain&domain=other\.example/);
  assert.match((await signIn({ email: "z@corp.example", nonce: "nope" })).back.location!, /error=oidc_failed&reason=nonce/);
  assert.match((await signIn({ email: "z@corp.example", verified: false })).back.location!, /not\+verified/);
  signer = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.match((await signIn({ email: "z@corp.example" })).back.location!, /signature\+does\+not\+match/);
  // Opening the callback twice is refused.
  const b2 = s.browser();
  const st = new URL((await b2.call("/auth/oidc/start")).location!).searchParams.get("state");
  signer = privateKey;
  await b2.call(`/auth/oidc/callback?code=abc&state=${st}`);
  assert.match((await b2.call(`/auth/oidc/callback?code=abc&state=${st}`)).location!, /error=oidc_failed/);
  // The pieces on their own.
  assert.equal(createOidc({ issuer, clientId: "cms", fetch: fetchStub }).label, "SSO");
});

test("openapi: with sign-in on, every /auth and /users route is answered", async () => {
  const s = setup({ oidc: { issuer: "https://idp.invalid", clientId: "x" } });
  const b = await firstAdmin(s);
  const fill: Record<string, string> = { id: "x" };
  const missing: string[] = [];
  for (const r of API_ROUTES.filter((x) => x.needs === "auth")) {
    const path = r.path.replace(/\{(\w+)\}/g, (_m, k: string) => fill[k]);
    const res = await b.call(path, { method: r.method.toUpperCase(), body: r.method === "get" || r.method === "delete" ? undefined : {} });
    if (res.body.error === "route_not_found") missing.push(`${r.method} ${r.path}`);
  }
  assert.deepEqual(missing, []);
  const doc = await b.call("/openapi.json");
  assert.ok(doc.body.paths["/auth/login"] && doc.body.paths["/users/invite"]);
});
