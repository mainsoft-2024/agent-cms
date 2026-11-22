---
title: Sign-in of its own
summary: People, passwords, passkeys, two-step codes, single sign-on and invitations, for apps without a login.
category: Guides
order: 14
---
Most apps already have a login and pass it in with `resolveUser`. When yours does not (or for the standalone server), the CMS can sign people in itself.

```ts
import { createAuth } from "@mainsoft/agent-cms/auth";
import { createCmsHandler } from "@mainsoft/agent-cms/http";

const auth = createAuth({
  cms,
  origin: "https://cms.example.com", // passkeys and mail links use it
  appName: "Example CMS",
  sendMail: async ({ to, subject, text }) => { /* Resend, SES, SMTP… */ },
  oidc: { issuer: "https://accounts.google.com", clientId, clientSecret, label: "Google", allowedDomains: ["example.com"] },
});
export const handler = createCmsHandler({ cms, auth });
```

Nothing new goes into the database schema: people, sessions, passkeys and one-time links live in `cms_records`.

## The first admin

While nobody has an account, the server prints a setup code where it logs (valid for 15 minutes; a new one comes with the next request after that):

```
[agent-cms] No one can sign in yet. Open https://cms.example.com/admin/setup and enter the setup code K7M2-9XQ4 (valid for 15 minutes).
```

`POST /auth/setup` with the code makes the first admin. After that, setup is closed.

## Ways to sign in

| | |
|---|---|
| Password | At least 12 characters; common and guessable ones are refused (the 10,000 most common, the email name, runs like `abcdefgh…`). Hashed with scrypt (N=2^17, r=8, p=1); weaker hashes are replaced at the next sign-in. Turn passwords off with `passwords: false`. |
| Passkey | WebAuthn without a library: ES256, EdDSA, RS256; no email typed first. A passkey counts as two factors. |
| Two-step code | Any authenticator app (TOTP, RFC 6238), a QR code on setup, ten recovery codes that work once. "Trust this device" skips the code for 30 days. |
| Single sign-on | OpenID Connect with PKCE: Google, Microsoft Entra, Okta, Keycloak, Auth0… `allowedDomains` limits who may sign in (and lets them in without an invitation, unless `autoCreate: false`). |

## Sessions

- An `HttpOnly`, `SameSite=Lax` cookie; on HTTPS it is `__Host-cms_session` and `Secure`. Only a hash of it is stored.
- 30 days from the last use, at most 90 days.
- Ten wrong passwords for one email in 15 minutes pause password sign-in for that email (passkeys and SSO still work); fifty tries from one address in 15 minutes pause that address.
- Changing the password ends your other sessions; a reset ends all of them; switching someone off or taking admin away ends theirs at once.
- Making or rotating API keys, turning two-step off, removing a passkey, and switching people off or making them admin need a confirmation in the last 10 minutes (`POST /auth/reauth`, or a passkey).
- Requests that change something must come from the CMS's own page (login CSRF is refused).

## People

Admins invite by email (`POST /users/invite`, links valid for 7 days, with a role and optionally as admin). Without `sendMail` the answer has the links to copy. The policy `requireMfa` makes everyone set up a passkey or two-step codes before anything else. At least one admin always stays.

Every step is in the audit log (`auth.*` actions).

## From code

```ts
await auth.createUser({ email: "park@example.com", name: "Park", password, isAdmin: true });
const link = await auth.resetLink("park@example.com");
```

The routes are listed under "sign-in", "account" and "people" in `/openapi.json`.
