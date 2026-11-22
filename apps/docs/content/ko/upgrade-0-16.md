---
title: 0.16으로 올리기
summary: 스키마 변경 없음. 사람을 이름이나 이메일로 찾고, CMS가 직접 로그인을 맡거나 단독으로 돌 수 있습니다.
category: Upgrade
order: 9
sourceVersion: 1
---
스키마는 바뀌지 않습니다. 새 데이터는 모두 `cms_records`에 들어가고, 쓰기 전에는 아무것도 바뀌지 않습니다.

1. `npm i @mainsoft/agent-cms@0.16` 후 `npx @mainsoft/agent-cms add --update` (역할, 가져오기, 미디어, 미리보기 링크 화면이 많이 바뀌었습니다).
2. 역할: 사람을 이름이나 이메일로 찾으므로 화면이 더 이상 ID를 묻지 않습니다. `POST /roles/:id/members`에 `{ "email": "…" }`도 됩니다. 이런 사람은 처음 어드민을 쓸 때까지 `pending: true`로 보입니다. CMS는 어드민을 쓴 사람을 기억하고(`person` 레코드), `GET /roles/_users`가 `lastSeenAt`과 함께 돌려줍니다.
3. 셸의 계정 메뉴에 `dropdown-menu` 부품이 필요합니다(`npx shadcn add dropdown-menu`).

## 선택: CMS 자체 로그인

```ts
import { createAuth } from "@mainsoft/agent-cms/auth";
const auth = createAuth({ cms, sendMail /* 선택 */, oidc /* 선택 */ });
export const handler = createCmsHandler({ cms, auth }); // resolveUser 대신
```

`npx @mainsoft/agent-cms add cms-login cms-people cms-account`로 화면을 넣고, `/admin/login`, `/setup`, `/invite`, `/reset`(어드민 틀 밖), `/admin/people`, `/admin/account` 경로를 만듭니다. 첫 관리자는 서버가 출력한 설정 코드로 가입합니다.

## 선택: 단독 서버

```bash
npx @mainsoft/agent-cms dev     # 써 보기
npx @mainsoft/agent-cms serve   # agent-cms.config.ts의 server: { cms }
```

Docker와 compose는 `examples/server`를 보세요.
