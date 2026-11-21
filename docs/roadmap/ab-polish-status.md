# 편집과 미디어 다듬기 (A·B 개선 계획) 진행 상황

승인된 계획: 시안 ab-polish v4, 계획서 `ab-polish.plan.md`(사내 작업 폴더). 첫 부분을 브랜치 `agents/ab-polish`에서 만들었다 (2026-11-21).

## 이번에 한 것

| 계획 항목 | 상태 | 내용 |
|---|---|---|
| 2.2.1 AI 편집 도구 (ab-ax) | 끝 | `read_document`, `grep_documents`, `edit_document`, `write_document`, `document_file_link`, REST 경로, 서명 링크 `/raw/:token`, 제안 정책 `agentEdits: "suggest"`, CLI `read`·`grep`·`edit`·`pull`·`push`·`status`(3-way 병합과 충돌 표시) |
| 2.3 HTML 블록 (ab-html) | 끝 | `:::html` 원본 그대로 저장, `html_inert` 경고(행 번호), 권한 `html`·`html_scripts`와 키 범위 `html`, `./html`의 `sanitizeHtml`·`isolatedHtml`·`markdownToHtml`, 어드민 미리보기 프레임(CSP로 스크립트 끔), 예제 앱과 docs 사이트 렌더 |
| 2.4 HTML 문서 (ab-htmldoc) | 서버만 | 스키마 8 `body_format`, 컬렉션 `body.formats`, `format_not_allowed`. 편집기의 모드 전환과 마크다운↔HTML 변환 창은 아직 |
| 2.2 마크다운 확장 (ab-rich 일부) | 끝 | 기울임, 취소선, 표, 할 일, 접기, 2단, 줄바꿈, 이스케이프, `toMarkdown`, 저장소의 모든 .md 왕복 테스트 |
| 3 게시 전 점검 (ab-p3 일부) | 서버만 | `publishChecks`, `publish_check_failed`, `POST …/checks`. 점검 창과 문장 단위 비교는 아직 |
| 음슴체 (ab-tone) | 끝 | 어드민·오류 문구 ko 전체, 지킴 테스트 |

## 2차에서 한 것 (2026-11-21, 브랜치 `agents/polish-2`)

- 블록 편집기 `cms-block-editor` (BlockNote MPL 코어만), 변환기 `cms-blocks-convert.ts`, / 메뉴, 이미지 붙여넣기·끌어 놓기 업로드, 블록/마크다운 전환
- 게시 전 점검 창, 제안 카드, 알림+되돌리기, 단축키와 단축키 창, 오프라인 사본, 떠나기 경고
- 미디어 여러 개 선택, 옮기기·태그·zip·삭제(되돌리기), 안 쓰는 파일·대체 텍스트 없는 이미지 필터, 정렬
- 리뷰 에이전트 제안 75개 중 57개 반영 (목록: `docs/roadmap/review-2026-11-21.md`)

## 아직 안 한 것

- **블록 편집기(ab-rich 나머지)**: BlockNote(MPL-2.0 core만, xl-* 금지) 연결, 우리 Block ↔ BlockNote 변환기(`cms-blocks-convert.ts`), 사용자 블록(미디어, 알림 상자, 문서 링크, HTML, 원문), 바뀌지 않으면 저장하지 않기, 한국어 IME e2e, 지연 로딩, `editor: "markdown"` 옵션.
- **ab-p1 공통**: 알림(toast)과 실행 취소, 확인 창 통일, 단축키(`cms-keys.ts`), `aria-live`·`aria-sort`, 상대 시각 title, 동작 줄이기.
- **ab-p2 편집기 공통**: `/` 메뉴, 이미지 붙여넣기 올리기, 오프라인 사본(`cms:draft:<c>/<slug>`), 저장 상태 표시, 떠날 때 경고.
- **ab-p3 화면**: 게시 전 점검 창, 문장·단어 단위 버전 비교.
- **ab-p4 미디어**: 여러 개 선택과 일괄 이동·태그·삭제·zip(`GET /assets/zip`), 필터(미사용, 대체 텍스트 없음)와 정렬, 저장 용량, 크롭 미리보기, 올리기 트레이, 올리기 전 크기 줄이기.
- **ab-p5 휴대폰**: 키보드 위 서식 줄, 미디어 고르기 시트.
- **ab-htmldoc 화면**: 편집기의 HTML 문서 모드와 변환 창.
- **제안 카드**: 편집기에서 제안을 보고 적용·거절하는 카드 (서버와 REST는 끝).
- 문서 사이트: 새 기능 안내 페이지(`agent-files`)만 썼다. 컴포넌트 페이지와 올리기 안내(UPGRADE-0.15)는 릴리스 때.
