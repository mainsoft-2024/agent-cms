---
title: 0.15로 올리기
summary: 스키마 8에서 열 하나가 늘어납니다. 블록 편집기, HTML, 에이전트 파일 도구, 게시 전 점검은 켤 때만 동작합니다.
category: Upgrade
order: 8
sourceVersion: 1
---
0.14.x에서 올리는 방법입니다. **스키마 8**: `cms_documents.body_format` 열 하나(`text`, 기본값 `'markdown'`)가 생깁니다. 나머지는 쓰기 전까지 아무것도 바뀌지 않습니다.

## 1. 데이터베이스

```sh
npx @mainsoft/agent-cms migrate check     # 단계 하나를 보여 줍니다
npx @mainsoft/agent-cms migrate apply     # 또는 출력된 SQL을 직접 실행
```

단계는 `ALTER TABLE cms_documents ADD COLUMN IF NOT EXISTS body_format text NOT NULL DEFAULT 'markdown'`입니다. 기존 문서는 마크다운 그대로입니다.

## 2. 화면

```sh
npx @mainsoft/agent-cms add --update            # 가지고 있는 화면 전부
npx @mainsoft/agent-cms add cms-block-editor    # 선택: 블록 편집기
```

블록 편집기는 확장 자리로 넘깁니다. 문서를 열 때만 불러오도록 `lazy`를 권합니다.

```tsx
const CmsBlockEditor = lazy(() => import("@/components/cms/cms-block-editor"));
const slots = { blockEditor: CmsBlockEditor };
<CmsProvider slots={slots} …>
```

넘기지 않으면 편집기는 지금처럼 마크다운 글 상자입니다. 어느 쪽이든 본문은 마크다운으로 저장됩니다.

## 3. 한국어 화면 문구

화면과 서버 오류의 `ko` 문구가 음슴체("저장 실패", "대표 이미지 없음")로 바뀌었습니다. 한국어 문구를 직접 덮어썼다면 말투가 맞는지 확인하세요.

## 4. HTML

- `:::html` 블록과 HTML 문서는 쓴 그대로 저장됩니다. 페이지에서 동작하지 않을 부분은 `html_inert` 경고로 돌아옵니다.
- HTML을 넣거나 고치려면 역할 권한 `html`이 필요합니다(관리자는 기본으로 가짐). API 키는 새 `html` 범위가 필요합니다. 실제로 도는 HTML(`html: { render: "isolated" }`에서 `:::html isolated`)은 `html_scripts`가 필요합니다.
- 사이트에서 HTML을 그릴 때는 `@mainsoft/agent-cms/html`(`sanitizeHtml`, `markdownToHtml`, `bodyToSafeHtml`)을 쓰세요. 저장된 본문을 그대로 HTML로 넣으면 안 됩니다.
- HTML 문서는 꺼져 있습니다. 컬렉션마다 `body: { formats: ["markdown", "html"] }`로 켭니다.

## 5. 에이전트

새 도구 `read_document`, `grep_documents`, `edit_document`, `write_document`, `document_file_link`가 생겼고, 기존 도구는 그대로입니다. 에이전트가 제안만 하게 하려면 컬렉션에 `agentEdits: "suggest"`를 두세요.

## 6. 타입과 동작

- `Inline`에 `em`, `del`, `br`이 생기고 `strong`에 `kids`가 올 수 있습니다. `Block`에 `todo`, `table`, `toggle`, `columns`, `html`, `raw`, `list.start`가 생겼습니다. 블록 종류로 `switch`하는 렌더러는 새 종류를 그리거나 건너뛰어야 합니다.
- `DocContent.format`(`"html"` 또는 없음), `CollectionConfig.body.formats`, `html`, `agentEdits`, `publishChecks`.
- 새 오류 코드: `forbidden_html`, `forbidden_html_scripts`, `raw_link_invalid`, `raw_link_expired`, `suggestion_not_found`, `suggestion_stale`, `format_not_allowed`, `edit_not_found`, `edit_not_unique`, `edit_invalid`, `file_invalid`, `pattern_invalid`, `publish_check_failed`, `zip_too_large`. 검증 오류에는 `issues`가 붙습니다.
- `update_document`, `patch_document`, `edit_document`는 모르는 필드를 거절합니다.
- Node 어댑터는 `toNodeHandler(handler, { trustProxy: true })`일 때만 `X-Forwarded-For`를 믿습니다.
- `grep`과 `raw`는 예약된 이름이라 컬렉션 슬러그로 쓸 수 없습니다.
