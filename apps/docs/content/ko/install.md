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
npx @mainsoft/agent-cms init
```

함께 필요한 패키지는 `drizzle-orm`, `zod`(`^3.25` 또는 `^4`)예요. 그 밖에는 없어요. 패키지가 모델을 부르지 않으므로 모델 라이브러리를 설치할 일이 없어요.

`init`은 `agent-cms.config.ts`, `lib/cms.ts`, API 라우트, 스키마 다시 내보내기, `.env.example` 줄을 만들어요. 이미 있는 파일은 덮어쓰지 않아요.

### 전체 이름, 그리고 다른 패키지 매니저

`npx` 뒤에는 전체 이름을 쓰세요. 스코프도 명령의 일부예요. `@mainsoft/`를 뺀 `agent-cms`는 npm에 있는 다른 프로젝트의 패키지라서, 이 패키지가 설치되지 않은 폴더(모노레포 루트, 에이전트의 셸, 새 프로젝트)에서 스코프를 빼면 `could not determine executable to run` 오류로 멈춰요.

```sh
bunx @mainsoft/agent-cms init
pnpm dlx @mainsoft/agent-cms init     # 설치한 뒤에는 `pnpm exec agent-cms init`도 돼요
yarn agent-cms init                   # `yarn add @mainsoft/agent-cms drizzle-orm zod` 다음에
```

알아 둘 것 두 가지:

- **yarn 1**은 peer dependency를 스스로 설치하지 않아요. `drizzle-orm`과 `zod`가 없으면 CLI가 빠진 패키지 이름을 알려 주고 멈춰요.
- **pnpm 11 이상**은 기본 설정(`minimumReleaseAge`)으로 최근 하루 안에 올라온 버전을 건너뛰어요. 그래서 릴리스 당일에는 `pnpm add`가 바로 전 버전을 설치해요.

## 테이블 만들기

drizzle-kit이 테이블을 알도록 Drizzle 스키마에서 다시 내보내거나, SQL을 마이그레이션에 넣으세요.

```ts
export { cmsDocuments, cmsVersions, cmsApiKeys, cmsHits, cmsMeta, cmsAudit } from "@mainsoft/agent-cms/tables";
```

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply
npx @mainsoft/agent-cms doctor
```

`migrate check`는 빠진 것을 SQL로 보여 주고, DB가 뒤처져 있으면 1로 끝나요. `migrate apply`는 여러 번 실행해도 안전한 DDL을 돌려요. `doctor`는 테이블, 열, 스키마 버전, 깨진 행을 점검해요.

> [!note]
> CMS는 처음 호출될 때 `cms_meta.schema_version`을 확인해요. DB가 뒤처져 있으면 실행할 명령과 함께 `schema_outdated`(503)로 답해요.

## 다른 테이블 이름

`cmsTables({ prefix: "blog_", schema: "content" })`로 앞붙임말이나 Postgres 스키마가 다른 테이블 묶음을 만들 수 있어요. `new DrizzleRepo(db, { tables })`와 `defineConfig({ tables })`에 넘기세요.
