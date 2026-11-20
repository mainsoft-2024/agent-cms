---
title: 어드민 화면
summary: 화면을 앱에 복사하고, 테마를 입히고, 최신으로 유지해요.
category: Admin screens
order: 1
sourceVersion: 1
---
화면은 앱에 복사해서 내 것이 되는 소스 파일이에요. shadcn/ui와 같은 방식이에요. 앱의 shadcn/ui 부품을 쓰고, `@mainsoft/agent-cms/client`의 `createRestClient`로 CMS와 통신해요.

## 넣기

shadcn CLI로, 이 사이트의 레지스트리에서:

```sh
npx shadcn add https://agent-cms-docs.vercel.app/r/cms-doc-editor.json
```

또는 agent-cms CLI로:

```sh
npx agent-cms add cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command
npx agent-cms add cms-media cms-files   # 미디어 라이브러리가 있을 때 (0.10.0부터)
```

파일은 `<components>/cms/`에 들어가요. 필요한 shadcn 부품과 다른 화면도 함께 따라와요. 모든 화면은 [화면](/components)에서 실제로 눌러 볼 수 있어요.

## 연결

```tsx
<CmsProvider baseUrl="/api/cms">
  <CmsShell title="Admin" LinkComponent={Link} extraNav={[{ label: "App", items: [{ label: "Reports", href: "/admin/reports" }] }]}>
    <CmsDocList collection="posts" hrefFor={(c, s) => `/admin/${c}/${s}`} />
  </CmsShell>
</CmsProvider>
```

`extraNav`로 앱의 화면을 사이드바에 더해요. 화면 문구는 영어가 기본이고, `cms-messages`의 `messages={ko}`를 주면 한국어가 돼요.

## 테마

화면은 shadcn 변수(`--background`, `--primary`, `--radius`, 글꼴)를 써요. 변수를 바꾸면 화면이 따라가요. 이 사이트의 어드민도 같은 화면에 변수만 다르게 준 거예요. 화면 갤러리에서 두 모양을 바꿔 볼 수 있어요.

## 업데이트

```sh
npx agent-cms add --diff      # 새 버전이 내 복사본에서 무엇을 바꾸는지
npx agent-cms add --update    # 안 고친 파일은 바꾸고, 고친 파일은 .new 사본을 만들어요
```

`agent-cms.json`이 무엇을 복사했는지 기록해요. `--diff`와 `--update`는 `agent-cms add`로 복사한 파일만 알아요.
