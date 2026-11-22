---
title: 단독 서버로 쓰기
summary: npx @mainsoft/agent-cms dev 또는 serve — 웹 앱 없이 어드민, API, MCP, 로그인을 포트 하나로 띄웁니다.
category: Guides
order: 15
sourceVersion: 1
---
agent-cms는 Next.js 앱 없이도 쓸 수 있습니다. 패키지에 빌드된 어드민과 서버가 들어 있습니다.

## 바로 써 보기

```bash
npx @mainsoft/agent-cms dev
```

나온 주소를 엽니다. 처음에는 로그인할 사람이 없고, 터미널에 나온 **설정 코드**(15분 유효)로 첫 관리자를 만듭니다. `dev`는 "Posts" 컬렉션을 만들고, `@electric-sql/pglite`가 설치돼 있으면 `.agent-cms/dev`에 문서를 남깁니다(없으면 메모리).

## 내 컬렉션으로 띄우기

`agent-cms.config.ts`의 `server`에 `createCms`를 넣고 `serve`를 실행합니다.

```ts
import { defineConfig } from "@mainsoft/agent-cms/config";

export default defineConfig({
  db: async () => (await import("./cms")).db,
  server: {
    cms: async () => (await import("./cms")).cms,
    appName: "Acme",
    trustProxy: true, // HTTPS 프록시 뒤
    auth: { sendMail: async (m) => { /* 메일 서비스 */ } },
  },
});
```

```bash
npx @mainsoft/agent-cms migrate apply && npx @mainsoft/agent-cms serve --port 3000
```

코드에서는 `import { startServer } from "@mainsoft/agent-cms/serve"; await startServer({ cms, port: 3000 })`.

## 서버가 하는 일

- `/admin`: 어드민. 엄격한 콘텐츠 보안 정책(`frame-ancestors 'none'`, 해시로 허용한 스크립트 하나 외 인라인 스크립트 없음)
- `/api/cms`: REST, MCP(`/api/cms/mcp`), 로그인
- `GET /healthz`(부하 분산기용), SIGTERM에서 진행 중인 요청을 마치고 종료(최대 10초)
- 1분마다 예약 작업: 예약 게시, 웹훅 전송, 자동화, 보존 기간
- 빌드 파일은 1년 캐시, 페이지는 캐시 안 함

## Docker

저장소의 `examples/server`에 Postgres, MinIO와 함께 띄우는 `Dockerfile`과 `compose.yaml`이 있습니다.

```bash
export CMS_PREVIEW_SECRET=$(openssl rand -base64 32) CMS_SECRETS_KEY=$(openssl rand -base64 32)
docker compose up --build
docker compose logs cms | grep "setup code"
```

패스키, 2단계 코드, 회사 계정, 초대는 [로그인](/ko/docs/sign-in)을 보세요.
