# agent-cms TODO

일반 웹 앱(Next.js 등)에 얹어서 함께 돌아가는 **애드온 CMS**. 사람(어드민 화면)과 에이전트(REST, MCP, AI SDK 도구)가 같은 문서를 같이 고친다.
블로그, 사내 문서, 개발 문서, 공지, 게시판처럼 CMS가 쓰이는 곳이면 어디든 쓸 수 있어야 한다. 특정 앱의 개발 흐름(PR, CI, 배포)에 묶인 기능은 라이브러리에 넣지 않는다. 그런 흐름은 앱이 이 라이브러리의 도구(`./ai`, CLI)를 써서 직접 짠다.
이 목록은 라이브러리를 키울 때의 백로그다. 서비서(첫 사용처)는 새 버전을 받아 올려 쓴다.

표기: **[P0]** 떼어 내기 전에 필요, **[P1]** 첫 공개 버전, **[P2]** 그 뒤.
출처: (lead) 리드 에이전트, (A)~(D) 검토 에이전트 4개.

## 0. 지금 있는 것 (기준선)

- 컬렉션 설정 (`defineCollection`): 분류, zod `fields`, 버전 보관 수, 초안 모드 또는 바로 반영 모드, 금지 문자, 검색과 못 찾은 질문 기록, `[[link:key|label]]` 화면 링크 검증, 공개 URL, 접근 함수, `afterChange` 훅
- 문서 상태: draft / published / archived. 버전마다 전체 스냅샷을 남기고, 되돌리기는 새 버전을 만든다
- 동시 편집 보호: `expectedVersion`이 다르면 409
- 한글 2-gram 메모리 검색 (섹션 단위, 조사 제거, 불용어, 영문 오타 1글자 허용)
- API 키: sha256 해시만 저장, read / write / publish / admin 범위와 컬렉션 제한
- REST 하나와 stateless MCP(JSON-RPC)
- 도구 목록 하나(`tools.ts`)를 MCP, AI SDK 도구(`./ai`: `cmsTools`, `remoteCmsTools`, slash-agent-sdk에서도 그대로), CLI가 함께 쓴다
- CLI: `tools`, `collections`, `list`, `get`, `search`, `put <file.md>`(frontmatter), `publish`, `call`
- 저장소 인터페이스: `MemoryRepo`(테스트), `DrizzleRepo`(Postgres)

## 1. 리드 아이디어 (lead)

### 콘텐츠 모델
1. **[P1] 필드 스키마로 어드민 폼 자동 생성.** zod `fields`를 읽어 입력 컴포넌트(텍스트, 숫자, 선택, 날짜, 불리언, 배열, 관계)를 고르고, 필드마다 `admin: { label, help, widget }` 메타를 붙인다. 지금은 `fields`가 JSON으로만 다뤄진다.
2. **[P1] 관계 필드.** `relation('guide')`처럼 다른 문서를 가리키고, 삭제와 보관 때 참조하는 쪽을 경고한다. 공개 화면에서는 "관련 문서"로 그린다.
3. **[P2] 블록(섹션) 기반 본문.** 마크다운 외에 callout, 단계, 이미지, 표, 영상, 링크 카드 블록 배열을 쓰는 모드. 에이전트에게는 블록 단위로 패치하게 한다.
4. **[P1] 문서 트리와 순서.** `parent`와 `order`로 사이드바 목차를 정하고, 어드민에서 끌어서 순서를 바꾼다. 지금은 분류 안에서 갱신 시각순이다.
5. **[P1] 다국어(locale).** 문서마다 locale별 콘텐츠를 두고, 번역이 낡았는지(원문 버전보다 이전인지) 표시한다. 에이전트 번역 초안을 만들고 사람이 검토한다.

### 편집과 검토
6. **[P0] 버전 diff 화면.** 두 버전의 필드별 차이와 본문 줄 단위 diff를 보여 준다. 되돌리기 전에 꼭 필요하다.
7. **[P1] 예약 게시와 예약 숨김.** `publishAt`, `unpublishAt`. 앱의 크론(Inngest 등)에 붙일 `runScheduled()`를 제공한다.
8. **[P1] 검토 요청 흐름.** 에이전트가 쓴 버전은 "검토 대기"로 두고, 승인한 사람과 시각을 기록한다. 컬렉션마다 "에이전트 글은 사람 승인 필수"를 켤 수 있다.
9. **[P1] 편집 잠금 표시.** 누가 이 문서를 열고 있는지 보여 준다(하트비트, 오래되면 자동 해제). 409보다 앞서 충돌을 막는다.
10. **[P2] 버전 간 3-way 병합.** 409가 났을 때 내 변경과 남의 변경이 겹치지 않으면 자동으로 합친다.
11. **[P1] 미리보기 링크.** 서명된 토큰으로 초안을 공개 화면 모양 그대로 보는 URL(만료 시간 포함). 로그인 없이 리뷰어에게 보낼 수 있다.

### 검색과 에이전트
12. **[P1] 선택형 임베딩 검색.** 키워드 점수와 벡터 점수를 섞고(pgvector 어댑터), 키워드만으로도 돌아가게 둔다. 임베딩은 게시 때만 다시 계산한다.
13. **[P1] 동의어 사전.** 컬렉션 설정이나 어드민에서 "슬랙 = slack", "ppt = 발표 자료 = 슬라이드"를 관리한다. 지금은 문서마다 keywords에 반복해 넣어야 한다.
14. **[P1] 못 찾은 질문에서 바로 초안 만들기.** 같은 의도의 질문을 묶고, "이 질문들로 초안 쓰기"를 에이전트에게 맡긴다(MCP 도구 `draft_from_gaps`).
15. **[P1] 검색 품질 평가 세트.** `queries.eval.json`(질문 → 기대 문서)과 CLI `agent-cms eval`로 순위 회귀를 CI에서 잡는다.
16. **[P2] 답변 피드백 수집.** 에이전트가 문서로 답한 뒤 사용자의 반응(도움 됨/안 됨, 이어서 다시 물음)을 문서별 점수로 모은다.

### 운영과 보안
17. **[P0] 감사 로그.** 키 생성과 폐기, 게시, 삭제, 권한 실패를 누가 언제 했는지 남긴다. 지금은 버전 기록만 있다.
18. **[P1] 키 사용량 제한(rate limit)과 만료일.** 키마다 분당 요청 수와 만료일, IP 허용 목록을 둔다.
19. **[P1] 소프트 삭제와 휴지통.** 삭제는 30일 보관 뒤 영구 삭제한다. 지금은 바로 지운다.
20. **[P1] 웹훅.** 게시, 수정, 삭제 때 서명된 POST를 보낸다(재시도, 실패 기록). ISR 재검증이나 Slack 알림에 쓴다.
21. **[P2] 멀티 테넌트.** `tenant` 열을 두고, 한 앱 안의 워크스페이스마다 별도 문서 세트를 둔다.

### 패키징과 개발 경험
22. **[P0] 다른 저장소로 분리.** `@mainsoft-2024/agent-cms`로 만들고 엔트리를 나눈다(server, http, mcp, ai, react, markdown, cli). peer deps는 drizzle-orm, zod, ai(선택), react(선택).
23. **[P0] 공식 MCP SDK로 교체.** 지금은 손으로 짠 JSON-RPC다. `@modelcontextprotocol/sdk`로 바꾸고 resources(문서를 리소스로)와 prompts도 노출한다.
24. **[P1] `agent-cms add <component>` 레지스트리.** shadcn처럼 어드민 UI 컴포넌트를 앱으로 복사해 넣는다(문서 목록, 편집기, 버전 기록, 못 찾은 질문, 키 관리).
25. **[P1] 마이그레이션 생성기.** `agent-cms ddl`이 버전별 증분 SQL을 내보내고, 앱의 마이그레이션 체계(drizzle-kit, 직접 작성한 guarded step)에 붙인다.
26. **[P1] 가져오기와 내보내기.** 폴더의 md(frontmatter)와 DB를 서로 옮기는 CLI(`agent-cms export ./content`, `import`). 백업과 초기 시드, 로컬 편집에 쓴다.
27. **[P2] Next 이외 어댑터.** Hono, Express, Remix용 핸들러(지금 핸들러는 fetch `Request`/`Response`라 얇게 감쌀 수 있다).
28. **[P1] 예제 앱과 문서 사이트.** 문서 사이트 자체를 agent-cms로 만든다.

## 2. 편집 경험과 콘텐츠 모델 (A)

29. **[P0] 전체 진단 `diagnose()`와 필드별 오류.** 지금 `validate()`는 첫 오류에서 throw한다. `Diagnostic[]`(`{ path, code, message, params }`)을 한 번에 돌려주고 `POST /collections/:c/_diagnose`로 저장 없이 검사한다. 폼은 입력마다 `aria-invalid`를 붙이고, 에이전트는 한 번에 모든 문제를 받는다. (Payload, Sanity)
30. **[P0] 오류 코드 계약과 문구 카탈로그.** `CmsError`의 한국어 산문을 `invalid_slug`, `unknown_link`, `conflict_version` 같은 세분 코드와 `params`로 바꾸고 `createCms({ messages })`로 문구를 주입한다. 공개 패키지가 한국어 전용이 되지 않게 한다. (Directus, Strapi)
31. **[P0] 버전을 만들지 않는 자동 저장.** `autosave jsonb`, `autosave_at`, `autosave_by`에 저장하고 버전은 사람이 저장할 때만 만든다. 다시 열면 "저장하지 않은 내용을 복구할까요?"를 띄운다. 자동 저장이 `versions.max`를 채워 실제 이력을 밀어내는 것을 막는다. (Payload autosave)
32. **[P0] 복사형 어드민의 접근성 계약.** `role="status"` 저장 알림, `label`과 `aria-describedby`, 포커스 트랩과 복귀, 키보드만으로 생성부터 게시와 되돌리기까지. jsdom과 axe 검사로 고정한다. (Sanity Studio)
33. **[P1] "에이전트가 바꾼 곳" 표시와 부분 되돌리기.** `commit()`이 필드 단위 diff를 `cms_versions.changed`에 남기고, 편집 화면 상단에 "에이전트가 v12에서 제목, 본문 2곳을 바꿨어요"를 띄운다. hunk마다 "이 부분만 되돌리기"는 새 버전을 만든다. (Sanity AI Assist, Directus)
34. **[P1] 섹션에 붙는 댓글.** `cms_comments`(anchor, quote, thread, resolvedAt). 앵커는 `splitSections()`의 것을 쓴다. 서명된 미리보기 링크로 온 외부 리뷰어도 댓글만 남길 수 있다. 에이전트는 댓글을 읽고 수정안을 새 버전으로 만든다. (Directus, Sanity)
35. **[P1] 분할 라이브 미리보기와 스크롤 동기화.** 저장 전 로컬 상태로 200ms 디바운스 렌더, 커서 섹션과 미리보기 앵커를 양방향으로 맞추고, 375/768/전체 폭 전환을 둔다. `renderBlocks(blocks, components)`로 앱 컴포넌트를 주입한다. (Payload live preview, TinaCMS)
36. **[P1] 미리보기에서 소스로 점프.** 블록에 `line`, `endLine`을 남겨 제목을 누르면 편집기의 해당 줄을 선택한다. 댓글 인용과 섹션 diff에도 같은 좌표를 쓴다. (TinaCMS click-to-edit)
37. **[P1] 저장 없는 미리보기 API.** `cms.preview(actor, col, input)`가 `{ blocks, toc, diagnostics, diff, publicUrl }`를 돌려준다. 어드민 미리보기와 에이전트의 저장 전 자기 점검이 같은 코드를 쓴다.
38. **[P1] 앵커 고정과 별칭.** `## 제목 {#id}`로 명시 앵커를 허용하고, 제목을 바꾸면 옛 앵커를 `cms_anchor_aliases`에 남겨 공개 화면과 에이전트가 준 링크가 끊기지 않게 한다. (Mintlify, Fumadocs)
39. **[P1] 슬러그 도우미와 게시 후 주소 변경.** 한글 제목에서 `suggestSlug()`(로마자 표기 + 중복 검사)를 만들고, 게시 뒤 주소를 바꾸면 `cms_redirects`에 자동 기록한다. 지금은 게시 후 변경이 아예 금지돼 있다.
40. **[P1] 문서 구조 린트와 게시 전 품질 게이트.** `structure: { requiredSections, maxSectionChars, requireIntro, requireLink }`. 목록에 품질 배지, 게시 다이얼로그에 체크리스트. 검색이 `##` 단위라 구조가 곧 검색 품질이다. (Fumadocs, Mintlify)
41. **[P1] 컬렉션별 문서 템플릿.** `templates: [{ key, label, body, fields }]`, `cms.create({ template })`, MCP `list_templates`. 사람과 에이전트가 같은 골격에서 시작한다. (Sanity initial value templates)
42. **[P1] 재사용 스니펫.** `[[snippet:key]]`로 다른 문서를 끼워 넣고, 순환 감지와 "이 스니펫을 쓰는 문서 5개" 역색인을 둔다. (Mintlify snippets)
43. **[P1] 내부 링크와 고아 문서 리포트.** `cms.linkReport()`가 `{ broken, orphans, unreachable }`를 돌려주고 어드민 "링크" 탭과 MCP 도구로 노출한다.
44. **[P1] 외부 URL 미디어와 figure 블록.** `{ url, alt, caption, width, height }`, alt 필수, https만, CLS 방지 상자, lazy 로딩. 업로드 저장소는 그 뒤. (Strapi)
45. **[P1] 붙여넣기 정규화.** HTML을 지원 부분집합 마크다운으로 바꾸고(turndown), 제로폭 문자와 스마트 따옴표를 정리하며, 사라질 문법은 편집기에서 경고한다. (Payload Lexical)
46. **[P2] 버전 이름표와 고정.** `cms_versions.label`, `pinned`; prune이 고정 버전을 보호한다. (Directus)
47. **[P1] 어드민 ⌘K 빠른 열기.** 초안 포함 문서 퍼지 검색, 최근 편집, 게시와 버전 기록 같은 액션. (Sanity)
48. **[P2] 섹션 단위 편집기.** 섹션 카드로 편집, 순서 변경, 삽입. 댓글, 점프, 린트의 위치 기준이 된다. (Sanity Portable Text)

## 3. 에이전트와 검색 (B)

49. **[완료 0.5.0] 도구 스펙 단일 레지스트리와 `/ai` 진입점.** MCP와 AI SDK 도구가 같은 `ToolDef[]`(이름, 설명, zod 입력, 권한)를 쓰게 `tools.ts`로 옮기고, `createAgentTools(cms, { collections })`가 `search_docs`, `get_doc`, `report_gap`을 만든다. 지금 서비서는 앱 쪽에서 직접 감싼다.
50. **[P0] 토크나이저 기반 컨텍스트 패커.** 지금은 섹션을 1,400자로 자른다. 호출자가 넘긴 프로바이더 `countTokens`로만 예산을 계산하고(문자 수 추정 금지), 문장 경계 절단, 중복 억제, `{ sections, usedTokens, dropped }`를 돌려준다. (Context7 `tokens` 파라미터)
51. **[P0] 섹션 패치 API.** `patch(actor, col, slug, ops)`; op는 `replace | insert_after | insert_before | delete | append` + `anchor`. 틀린 앵커는 유효 앵커 목록과 함께 422, `dryRun`은 unified diff. 60k 본문을 통째로 다시 쓰는 비용과 불필요한 409를 없앤다. MCP `patch_document`.
52. **[P0] 인용 계약과 검증.** `citations: [{ id: "cms://guide/slack#connect", quote, charRange }]`와 `verifyCitations(answer, lookup)`. 앱이 출처를 그리고 없는 slug/anchor를 잡는다. (Inkeep, GitBook)
53. **[P0] 사용 기록에 출처 붙이기.** `cms_hits`에 `source`(ai, mcp, rest)와 MCP `clientInfo`를 남긴다. 이번에 `lookupForAgent`가 기록을 시작했다. (GitBook 분석)
54. **[P1] 에이전트 작업 레시피.** "코드가 바뀌면 에이전트를 불러 관련 문서를 고친다", "출시 때 공지 초안을 쓴다" 같은 흐름을 라이브러리 기능이 아니라 예제(`examples/`)로 보여 준다. `remoteCmsTools` + 모델 호출 몇 줄이면 되게.
55. **[P1] `llms.txt`, `llms-full.txt`, 문서별 `.md`.** `GET /llms.txt`와 `/:c/:slug.md`를 `changeStamp()` 캐시와 함께 연다. (Mintlify)
56. **[P1] 컬렉션 설정으로 만드는 MCP `instructions`.** 컬렉션, 링크 키, 금지 문자, 필드 설명을 담은 안내문을 생성하고 내용 해시가 바뀔 때만 바꿔 캐시를 지킨다. (Mintlify `skill.md`)
57. **[P2] 계층 색인과 이웃 섹션.** `###`를 자식 단위로 색인하고 결과에 `more: [{ anchor, rel: prev | next | child }]`를 붙여 재검색 없이 넓힌다. (Context7)
58. **[P1] 순위 함수 수리.** 필드 최댓값만 쓰는 지금 방식에 BM25식 tf 포화, 섹션 길이 정규화, 섹션 단위 coverage(형제 섹션이 대신 맞춰 주지 않게), 신선도 감쇠, `fields` 저가중 색인을 넣는다. (Algolia)
59. **[P1] 코드 블록과 오류 문자열 색인.** 지금 `plainText`가 펜스 코드를 지워 `ENOTFOUND` 같은 문자열을 못 찾는다. 별도 필드, 정확 일치 보너스, `matchedTerms` 반환.
60. **[P1] 한글 자모, 초성, 한글 오타.** "슬렉", "ㅅㄹ" 같은 입력을 자모 분해와 초성 토큰으로 받고, 영문 오타 스캔은 BK-tree로 바꾼다.
61. **[P2] 동의어 자동 후보.** 나중에 답이 생긴 gap에서 `cms_synonyms(term, target, state: proposed | active)` 후보를 만들고, 키워드에서 슬랙↔slack 같은 로마자 별칭을 뽑는다. (Algolia dynamic synonyms)
62. **[P1] 검색 질의 로그와 zero-result 리포트.** `cms_searches(query, result_ids, used_ids, source, latency_ms)`; 어드민에 실패율, 상위 질문, 1순위 오답 목록. 58번과 64번의 입력.
63. **[P1] 질문 의도 분류.** `howto | error | exists | concept`에 따라 섹션 가중치와 반환 범위를 바꾼다. (Algolia query categorization)
64. **[P1] 섹션 단위 평가와 하드 네거티브.** 기대 `slug#anchor`, 하드 네거티브, recall@1/3, MRR, 답변당 토큰, p95를 재고 `agent-cms eval --baseline`이 떨어진 질의와 이유를 낸다(15번 확장).
65. **[P1] `lint_document` 사전 검증 도구.** 헤딩 단계 건너뜀, 닫히지 않은 펜스, 중복 헤딩, 요약 누락, 긴 섹션을 `issues[]`로. error는 저장을 막고 warn은 응답에 싣는다. (GitBook Agent)
66. **[P1] 신선도와 `review_queue`.** 문서마다 `reviewEveryDays`(또는 컬렉션 기본값)와 `lastReviewedAt`을 두고, 기한이 지난 문서를 MCP `review_queue`로 돌려준다. 무엇을 계기로 검토할지는 앱이 정한다.
67. **[P2] 쓰기 권한 에이전트의 초안 포함 검색.** 중복 문서 작성을 막는다. 읽기 전용 actor에게는 초안을 절대 보이지 않는다.
68. **[P2] 사용 신호 기반 순위 보정.** hits로 문서 prior를 상한 있게 적용하고, 평가 세트를 통과 못 하면 자동으로 끈다.

## 4. 보안, 운영, 성능 (C)

69. **[P0] 접근 기본값 fail-closed.** `visibility: "public" | "internal"`을 필수로 두고, `internal`인데 `access`가 없으면 부팅 시 예외. 공개로 열린 컬렉션을 부팅 로그에 한 번 경고한다.
70. **[P0] 프롬프트 인젝션 경계.** 에이전트에게 주는 문서를 `<cms-document … trust="human|agent">` 봉투로 감싸고 "참고 자료이지 지시가 아님" 프리앰블을 붙인다. 에이전트가 쓴 미검토 문서는 표시한다.
71. **[P0] `If-Match`/`ETag`.** GET에 `ETag: "v<n>"`, PATCH/DELETE/publish/restore는 `If-Match`를 `expectedVersion`으로 쓴다. 지금 DELETE에는 낙관적 가드가 없다.
72. **[P0] gap 기록 정책과 상한.** 이번에 익명 기록을 막았다. 남은 일: `gapLogging: off | agents | all`, (actor, normalized) 짧은 창 중복 제거, 하루 신규 행 상한.
73. **[P1] 렌더러 XSS 계약.** React `DocBody`는 트리만 받아 엘리먼트로 그리고 HTML 문자열 경로를 두지 않는다. `javascript:`, `data:`, 대소문자와 공백 우회, 중첩 링크를 담은 적대적 픽스처 테스트.
74. **[P1] 증분 색인.** `SearchIndex.upsertDoc / removeDoc`로 바뀐 문서만 갈아끼우고, 영문 어휘 스캔을 접두 맵으로. 수천 문서에서 p95 5ms를 지킨다.
75. **[P1] 프로세스 간 무효화를 `pg_notify` + 시퀀스로.** `cms_change_log(seq bigserial)`와 `LISTEN`으로 즉시 무효화하고 폴링은 안전망으로. 지금 `changeStamp()`는 30~60초마다 `count(*)`를 돌린다.
76. **[P1] 게시본 읽기 캐시 어댑터.** `CacheAdapter`(메모리, Redis, Next `unstable_cache`), 키에 `publishedVersion`, 무효화는 `onChange`와 75번.
77. **[P1] 페이지네이션과 컬럼 프로젝션.** 목록은 본문 없이, 버전 목록은 스냅샷 없이 요약 모드와 `limit/cursor`. 지금은 버전 100개의 전체 스냅샷을 한 번에 보낸다.
78. **[P1] 인덱스 추가와 N+1 제거.** `cms_gaps(collection, state, last_seen_at)`, `cms_hits(day)` 인덱스. 목록과 검색 색인 빌드의 일괄 조회.
79. **[P1] CLI 확장.** `put`에 폴더 단위 일괄 처리(`put <collection> ./dir`), `--dry-run`, `diff`(파일과 현재 초안 비교), 출력 형식 `--format table`.
80. **[P1] 구조화 이벤트와 지표 훅.** `onEvent(e)`로 요청(라우트, actor 종류, 상태, ms), 검색(hit 수, ms), 색인 빌드, 훅 실패를 내보내 OTel/Prometheus에 연결한다.
81. **[P1] 보존 정책과 주체 삭제.** `retention: { gapsDays, hitsDays, revokedKeysDays }`, `purgeActor(id)`, `exportActor(id)`, `agent-cms retention --dry-run`.
82. **[P1] 스키마 버전 핀과 `doctor`.** `cms_meta.schema_version`을 부팅 때 비교해 명확히 실패하고, `doctor`가 테이블과 인덱스, 게시 버전 정합성, 고아 행, DDL 드리프트를 검사한다. 복구 절차(Neon PITR + 버전 스냅샷)를 문서화한다.
83. **[P2] 키 회전과 식별.** `rotateKey(id, { graceMinutes })`, 표시 접두 8자, `revoked_reason`, 선택적 `last_used_ip`. `touchKey`를 서버리스에서 유실되지 않게 `waitUntil`로.

## 5. 개발 경험, 패키징, 확장 (D)

84. **[P0] 설정에서 끝까지 이어지는 타입 `Cms<C>`.** `defineCollections([...] as const)` → `cms.get("guide", …)`의 `fields`가 `z.infer`로 좁혀지고 오타 슬러그는 컴파일 에러. (Payload generate:types, Better Auth `$Infer`)
85. **[P0] `agent-cms.config.ts`와 `defineConfig`.** 런타임과 CLI가 같은 파일을 읽는다(jiti). (Fumadocs `source.config.ts`, Keystone)
86. **[P0] `agent-cms init`과 `doctor`.** 설정 파일, `app/api/cms/[...path]/route.ts`, 스키마 재export, 환경 변수 자리까지 만들고 doctor가 초록이면 설치 끝. (shadcn)
87. **[P0] 분리 게이트.** `npm pack` 결과를 임시 Next 14 앱에 설치해 subpath `exports`가 실제로 resolve되는지, `publint`와 `attw` 검사. (지금 앱 import 금지 규칙은 `parts.test.ts`가 지킨다.)
88. **[P0] `cmsTables({ prefix, schema })` 팩토리.** `DrizzleRepo`가 테이블 세트를 생성자로 받고 `cmsDdl(tables)`도 접두사와 스키마를 따른다. (Payload `schemaName`)
89. **[P0] 스키마 버전 핸드셰이크와 `migrate check`.** 패키지가 기대하는 `SCHEMA_VERSION`과 DB를 비교해 빠진 컬럼만 guarded `ALTER`로 출력한다. 서비서의 `migrate-prod.ts` step 형식 그대로.
90. **[P1] 드라이버 독립 어댑터.** `PgDatabase` 계열로 넓히고 neon-http(트랜잭션 없음)는 `db.batch`로 폴백. postgres.js, pglite 팩토리.
91. **[P1] `createTestCms()`와 fetch 하네스.** `agent-cms/testing`에서 `seedDoc`, `asAdmin`, `asKey(scopes)`, `createFetchMock(cms)`. (Better Auth)
92. **[P1] 플러그인 시스템.** `definePlugin({ name, setup(ctx) })`로 훅, 컬렉션 확장, 라우트, 테이블 추가. 감사 로그, 웹훅, rate limit이 코어 수정 없이 붙는다. (Better Auth registry, Payload plugins)
93. **[P1] 전체 라이프사이클 훅.** `beforeValidate`, `beforeChange`(변형 가능), `afterChange`, `before/afterPublish`, `afterDelete`, `afterRead`와 `{ actor, previous, operation, abort }` 컨텍스트. (Payload hooks)
94. **[P1] 타입드 클라이언트와 TanStack Query 어댑터.** `createCmsClient()`의 `client.guide.update(slug, doc, { expectedVersion })`, `useDoc`, `useUpdateDoc`(409면 재조회).
95. **[P1] OpenAPI 3.1 출력.** `agent-cms openapi`와 `GET /api/cms/openapi.json`. TypeScript 밖(Python, Zapier, GPT action)의 공식 계약.
96. **[P1] `agent-cms types` 코드젠.** `.agent-cms/types.d.ts`(컬렉션 유니온, `Fields<"guide">`, `LinkKey`), `--check`로 CI에서 낡음 감지. (Fumadocs postinstall)
97. **[P1] 복사형 UI 소유권 추적과 3-way 업그레이드.** `agent-cms.json`에 복사한 파일의 버전과 해시를 남기고 `add --diff`, `add --update`(안 고친 파일만). shadcn 스키마의 `registry.json`도 빌드한다.
98. **[P1] 업그레이드 규율.** changesets, `@next` 프리릴리스, `agent-cms codemod v0.x`(ts-morph), 제거 예정 API의 1회 경고. (`@next/codemod`)
99. **[P1] 공개 렌더링 킷.** `agent-cms/next`: `generateDocParams`, 태그 캐시(`cms:guide:slug`), `revalidateDoc`, sitemap, RSS, OG 이미지.
100. **[P1] `agent-cms lint` 콘텐츠 린터.** 저장 검증과 같은 함수로 전체 문서를 검사하고 `--fix`, `--staged`(pre-commit).
101. **[P1] `agent-cms dev` 단독 하네스.** 호스트 앱 없이 pglite나 메모리 저장소로 어드민, REST, MCP를 띄운다. (Keystone dev)
102. **[P1] 호환성 매트릭스 CI.** Next 14/15/16, React 18/19, zod 3/4, ai SDK 버전 조합에 tarball을 설치해 스모크 테스트하고 지원표를 자동 갱신한다.
103. **[P1] 에이전트용 라이브러리 문서.** 문서 사이트의 `llms.txt`, MCP 리소스 `cms://docs/*`, subpath별 TypeDoc. 코딩 에이전트에게 "agent-cms로 어드민 붙여 줘"가 첫 사용 경로가 된다.
104. **[P2] Edge 런타임.** `node:crypto` 대신 `crypto.subtle`, `doctor --runtime=edge`.
105. **[P2] `import --dry-run --diff`.** 폴더 md와 DB의 차이를 문서별로 보여 주고 `db-wins | file-wins | newest`를 고른다.
106. **[P2] `agent-cms bench`.** 검색 p95, 색인 빌드 시간, 1만 문서 목록 쿼리를 CI에서 회귀 감시.

## 6. 이번 PR에서 고친 것 (리뷰 에이전트가 찾음)

- admin 범위 키가 자기보다 넓은 키를 발급하던 권한 상승 (`createKey`가 부분집합만 허용)
- 익명 검색과 `reportGap`이 `cms_gaps`에 무제한으로 쓰던 문제 (요청할 때만, 익명은 금지)
- 색인 빌드 실패 시 낡은 색인이 계속 쓰이던 문제 (stamp 먼저, 실패 시 dirty 유지와 보고)
- publish와 restore가 잘못된 JSON 본문을 삼키고 최신 버전을 게시하던 문제
- `Authorization`이 키가 아니어도 세션을 무시하고 401을 내던 문제, 세션 쓰기 요청의 Origin 검사
- `/api/cmsx` 같은 접두 경로 오매칭, 퍼센트 인코딩 오류의 500, 음수 limit, 512KB 본문 상한, MCP 배치 20개 상한
- 동시 생성의 유니크 위반이 500이던 것 (409로)
- MCP에서 숨긴 도구도 호출되던 불일치, `JSON.stringify` 들여쓰기로 토큰 낭비
- `recordHits`가 아무 데서도 불리지 않던 것, slug 지정 시 질문을 무시하던 것
- jsonb 키 순서 때문에 변경 없는 저장이 새 버전을 만들던 것

## 7. 아직 남은 버그와 약점

- `cms.update`의 `fields`가 얕은 병합이라 중첩 객체를 지울 수 없다(JSON Merge Patch 의미로).
- 상태만 바뀌어도 `changed()`가 색인을 dirty로 만들고 `afterChange`를 부른다(게시 내용 변화 여부로 구분).
- `recordHits`의 날짜가 UTC라 KST 오전 9시 전 사용량이 전날로 들어간다(`timeZone` 옵션).
- `archive` 뒤 재게시해도 `publishedAt`이 최초 시각으로 남는다(`republishedAt` 분리).
- `normalizeQuery`가 어순을 정렬하지 않아 "슬랙 연결"과 "연결 슬랙"이 다른 gap이 된다.
- `hitCounts`가 컬렉션 필터 없이 전체를 집계한다.
- `toJsonSchema`가 `.min/.max/.default`를 버려 모델이 제한을 모른다.
- 키 생성의 `% 62` 모듈로 편향(거부 샘플링으로), 쓰이지 않는 `sameHash`.
- 문서 삭제 시 `cms_gaps.document_slug` 참조가 남는다.
- `remoteCmsTools`는 키 권한과 상관없이 모든 도구를 노출한다(`only`로 직접 줄여야 함). 시작할 때 `tools/list`로 맞추는 비동기 버전 `await remoteCmsToolsFor(...)`.
- `cms_documents`에 0.4.0까지 쓰던 `covers`, `needs_review`, `review_reason`, `pending_pr`, `cms_versions.pr` 열이 기존 DB에 남아 있다. 쓰지 않으니 해는 없지만 `doctor`가 알려 주고 지울 SQL을 내야 한다.
