---
title: 컬렉션
summary: 공개 범위, 필드, 카테고리, 권한 규칙, 훅.
category: Guides
order: 1
sourceVersion: 1
---
컬렉션은 문서의 종류예요. 글, 가이드, 공지처럼요. 모든 컬렉션이 같은 테이블을 써서, 컬렉션을 더해도 마이그레이션이 필요 없어요.

## 옵션

```ts
defineCollection({
  slug: "posts",
  label: "Blog",
  visibility: "public",                    // 필수: "public" 또는 "internal"
  categories: ["News", "Engineering"],
  versions: { max: 100, drafts: true },    // 수정은 게시할 때까지 기다려요
  search: { enabled: true },
  fields: z.object({ cover: z.string().url().optional() }),
  admin: { fields: { cover: { label: "Cover image" } } },
  url: (d) => `/blog/${d.slug}`,
  access: { write: ({ actor }) => actor.kind === "user" && actor.isAdmin },
});
```

## 공개 범위

컬렉션마다 `public`인지 `internal`인지 정해요. `internal` 컬렉션은 누가 읽을 수 있는지(`access.read`)를 꼭 정해야 해요. 정하지 않으면 CMS가 시작되지 않아서, 실수로 공개되는 일이 없어요.

## 필드

`fields`는 zod 객체예요. 편집기는 이걸로 입력 폼을 만들고, `cms.get`은 `fields`를 zod 결과 타입으로 돌려줘요. `update`에서 `fields`는 JSON Merge Patch예요. 보낸 키는 바뀌고, `null`은 지우고, 나머지는 그대로예요.

## 권한

기본값: 공개 컬렉션의 게시된 문서는 누구나 읽어요. 관리자는 쓰고 게시해요. API 키는 범위(`read`, `write`, `publish`, `admin`, 필요하면 컬렉션별)만큼 할 수 있어요. 컬렉션마다 `read`, `write`, `publish`를 바꿀 수 있어요.

`managed: true`면 앱 코드(`system`)만 쓸 수 있는 컬렉션이 돼요.

## 훅

`afterChange` 훅과 `cms.onChange`는 두 번째 인자로 `{ contentChanged }`를 받아요. 초안만 바뀌고 공개본이 그대로면 false라서, 그때는 페이지를 다시 만들지 않아도 돼요.

`createCms`의 `timeZone`(기본 `UTC`)은 사용 기록을 어느 날짜로 셀지 정해요.
