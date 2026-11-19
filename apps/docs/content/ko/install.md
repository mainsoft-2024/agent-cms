---
title: 설치
summary: 패키지를 넣고 init을 실행한 뒤 테이블을 만들어요.
category: Get started
order: 2
sourceVersion: 1
---
## 패키지 설치

```sh
npm i @mainsoft/agent-cms drizzle-orm zod
npx agent-cms init
```

함께 필요한 패키지는 `drizzle-orm`, `zod`(`^3.25` 또는 `^4`)예요. 그 밖에는 없어요. 패키지가 모델을 부르지 않으므로 모델 라이브러리를 설치할 일이 없어요.

`init`은 `agent-cms.config.ts`, `lib/cms.ts`, API 라우트, 스키마 다시 내보내기, `.env.example` 줄을 만들어요. 이미 있는 파일은 덮어쓰지 않아요.

## 테이블 만들기

drizzle-kit이 테이블을 알도록 Drizzle 스키마에서 다시 내보내거나, SQL을 마이그레이션에 넣으세요.

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit } from "@mainsoft/agent-cms/tables";
```

```sh
npx agent-cms migrate check
npx agent-cms migrate apply
npx agent-cms doctor
```

`migrate check`는 빠진 것을 SQL로 보여 주고, DB가 뒤처져 있으면 1로 끝나요. `migrate apply`는 여러 번 실행해도 안전한 DDL을 돌려요. `doctor`는 테이블, 열, 스키마 버전, 깨진 행을 점검해요.

> [!note]
> CMS는 처음 호출될 때 `cms_meta.schema_version`을 확인해요. DB가 뒤처져 있으면 실행할 명령과 함께 `schema_outdated`(503)로 답해요.

## 다른 테이블 이름

`cmsTables({ prefix: "blog_", schema: "content" })`로 앞붙임말이나 Postgres 스키마가 다른 테이블 묶음을 만들 수 있어요. `new DrizzleRepo(db, { tables })`와 `defineConfig({ tables })`에 넘기세요.
