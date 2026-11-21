---
title: 에이전트가 코드처럼 문서 고치기
summary: 문서를 줄 번호가 붙은 파일로 읽고, 여러 문서에서 찾고, 정확한 글을 바꾸고, 편집기에서 고친 파일을 올리고, 에이전트의 수정을 제안으로 받고, HTML을 쓴 그대로 둔다.
category: Guides
order: 13
sourceVersion: 1
---
> [!note]
> 0.15.0에서 새로 생겼다. 스키마 8이 필요하다(`npx @mainsoft/agent-cms migrate apply`).

## 문서 하나, 파일 하나

모든 문서는 텍스트 파일 하나로 읽힌다. 앞부분 줄(slug, title, summary, category, keywords, 그리고 필드마다 한 줄)과 본문이다. 에이전트는 줄 번호와 함께 읽고, 정확한 글을 바꿔서 고친다. 코딩 에이전트가 코드를 고치는 방식과 같다. 본문 글, HTML 블록, 필드를 같은 방법으로 고친다.

## 도구

- `read_document`: 줄 번호가 붙은 파일. 긴 문서는 `offset`, `limit`, 제목과 블록 위치만 보려면 `outline: true`.
- `grep_documents`: 여러 문서에서 맞는 줄. 기본은 글자 그대로, `regex: true`면 정규식. `collections`, `slugs`, `glob`(`guide/2026-*`)으로 좁힌다.
- `edit_document`: `edits: [{ oldString, newString, replaceAll? }]`. 바꿀 글은 한 곳에만 있어야 한다. 여러 편집은 순서대로 한 버전으로 저장되고, 하나라도 실패하면 아무것도 저장되지 않는다. 글을 찾지 못하면 가장 비슷한 줄을 알려 준다.
- `write_document`: 파일 전체. 바꿀 때는 `expectedVersion`이 필요하다.
- `document_file_link`: 파일을 받거나 올리는 10분짜리 링크.

## 명령줄에서

```bash
npx @mainsoft/agent-cms pull guide new-dashboard
# guide/new-dashboard.md를 아무 편집기로 고친다
npx @mainsoft/agent-cms push
```

그 사이 CMS에서 누가 고쳤으면 `push`가 둘을 합친다. 같은 줄을 둘 다 고쳤으면 파일에 `<<<<<<<` 표시가 생기고, 고칠 때까지 저장하지 않는다.

## 제안

컬렉션에 `agentEdits: "suggest"`를 두면 API 키와 에이전트의 수정은 제안으로 기다린다. 사람이 적용하거나 거절한다.

## HTML 블록과 HTML 문서

HTML은 쓴 그대로 저장된다. 화면에서 동작하지 않을 부분(스크립트, `onclick`, 다른 호스트의 프레임)은 행 번호와 함께 경고로 알려 준다. 그릴 때는 `@mainsoft/agent-cms/html`의 `sanitizeHtml`이나, 격리된 프레임용 `isolatedHtml`을 쓴다. HTML을 넣거나 고치려면 `html` 권한이 필요하다(키는 `html` 범위). 문서 전체를 HTML로 쓰는 것은 컬렉션에 `body: { formats: ["markdown", "html"] }`를 두어 켠다.
