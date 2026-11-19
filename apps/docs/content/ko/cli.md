---
title: CLI
summary: 셸에서 문서를 읽고 써요. 에이전트와 스크립트용.
category: Agents
order: 3
sourceVersion: 1
---
## 연결

```sh
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx agent-cms collections
```

`--env <파일>`을 주면 `AGENT_CMS_URL`과 `AGENT_CMS_KEY`를 파일에서 읽어요.

## 명령

```sh
npx agent-cms search "설치 테이블" --collections docs
npx agent-cms get posts hello-world --draft
npx agent-cms put posts ./hello-world.md --publish --note "launch post"
npx agent-cms patch posts hello-world ./ops.json --expected-version 3 --dry-run
npx agent-cms call archive_document '{"collection":"posts","slug":"old","archived":true}'
```

`put`은 문서를 만들어요. 이미 있는 문서를 고치려면 읽은 버전을 `--expected-version N`으로 넘기세요. 그사이 누가 저장했으면 덮어쓰지 않고 충돌로 실패해요. `--force`는 이 검사를 건너뛰어요.

## 파일 형식

앞부분(frontmatter)이 있는 마크다운이에요. `slug`, `title`, `summary`, `category`, `keywords`가 아닌 키는 `fields`로 들어가요.

```md
---
title: Hello, world
summary: Our first post
category: News
tags: [launch]
---
Body in **markdown**.
```

## 로컬 명령

`init`, `doctor`, `migrate check | print | apply`, `add`는 서버 없이 프로젝트에서 돌아가요. [설치](/docs/install)와 [어드민 화면](/docs/admin-screens)을 보세요.
