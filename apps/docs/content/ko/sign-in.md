---
title: 자체 로그인
summary: 로그인이 없는 앱을 위한 사람, 비밀번호, 패스키, 2단계 코드, SSO, 초대.
category: Guides
order: 14
sourceVersion: 1
---
대부분의 앱은 이미 로그인이 있고 `resolveUser`로 넘깁니다. 로그인이 없거나 단독 서버로 쓸 때는 CMS가 직접 로그인을 맡을 수 있습니다.

```ts
import { createAuth } from "@mainsoft/agent-cms/auth";
import { createCmsHandler } from "@mainsoft/agent-cms/http";

const auth = createAuth({
  cms,
  origin: "https://cms.example.com", // 패스키와 메일 링크가 이 주소를 씀
  appName: "Example CMS",
  sendMail: async ({ to, subject, text }) => { /* Resend, SES, SMTP… */ },
  oidc: { issuer: "https://accounts.google.com", clientId, clientSecret, label: "Google", allowedDomains: ["example.com"] },
});
export const handler = createCmsHandler({ cms, auth });
```

데이터베이스 스키마는 바뀌지 않습니다. 사람, 세션, 패스키, 일회용 링크는 `cms_records`에 저장됩니다.

## 첫 관리자

계정이 하나도 없는 동안 서버 로그에 설정 코드가 나옵니다(15분 유효, 지나면 다음 요청 때 새 코드).

```
[agent-cms] No one can sign in yet. Open https://cms.example.com/admin/setup and enter the setup code K7M2-9XQ4 (valid for 15 minutes).
```

이 코드로 `POST /auth/setup`을 하면 첫 관리자가 생기고, 그 뒤로 설정은 닫힙니다.

## 로그인 방법

| | |
|---|---|
| 비밀번호 | 12자 이상. 흔한 비밀번호(가장 흔한 1만 개), 이메일 이름, `abcdefgh…` 같은 연속 글자는 거절합니다. scrypt(N=2^17, r=8, p=1)로 해시하고, 더 약한 해시는 다음 로그인 때 바꿉니다. `passwords: false`로 끌 수 있습니다. |
| 패스키 | 라이브러리 없이 구현한 WebAuthn. ES256, EdDSA, RS256. 이메일을 먼저 치지 않습니다. 패스키는 2단계로 칩니다. |
| 2단계 코드 | 인증 앱(TOTP, RFC 6238). 설정할 때 QR 코드, 한 번씩 쓰는 복구 코드 10개. "이 기기 신뢰"를 고르면 30일 동안 코드를 묻지 않습니다. |
| SSO | PKCE를 쓰는 OpenID Connect: Google, Microsoft Entra, Okta, Keycloak, Auth0 등. `allowedDomains`로 로그인할 수 있는 사람을 정합니다(이 도메인은 초대 없이 들어오고, `autoCreate: false`면 초대 필요). |

## 세션

- `HttpOnly`, `SameSite=Lax` 쿠키. HTTPS에서는 `__Host-cms_session`이고 `Secure`. 저장하는 것은 해시뿐입니다.
- 마지막으로 쓴 때부터 30일, 길어도 90일.
- 한 이메일로 15분 안에 비밀번호를 10번 틀리면 그 이메일의 비밀번호 로그인이 멈춥니다(패스키와 SSO는 됨). 한 주소에서 15분에 50번 시도하면 그 주소가 멈춥니다.
- 비밀번호를 바꾸면 내 다른 세션이 끝나고, 재설정하면 전부 끝납니다. 누군가를 끄거나 관리자에서 빼면 그 사람의 세션이 바로 끝납니다.
- API 키 만들기·교체, 2단계 끄기, 패스키 지우기, 사람 끄기·관리자 지정은 10분 안의 본인 확인이 필요합니다(`POST /auth/reauth` 또는 패스키).
- 무언가를 바꾸는 요청은 CMS 자신의 페이지에서 와야 합니다(로그인 CSRF 거절).

## 사람

관리자는 이메일로 초대합니다(`POST /users/invite`, 링크 7일 유효, 역할과 관리자 여부 지정). `sendMail`이 없으면 응답에 복사할 링크가 옵니다. `requireMfa` 정책을 켜면 모두가 다른 일을 하기 전에 패스키나 2단계 코드를 설정해야 합니다. 관리자는 늘 한 명 이상 남습니다.

모든 단계는 감사 로그에 남습니다(`auth.*`).

## 코드에서

```ts
await auth.createUser({ email: "park@example.com", name: "Park", password, isAdmin: true });
const link = await auth.resetLink("park@example.com");
```

경로는 `/openapi.json`의 "sign-in", "account", "people" 아래에 있습니다.
