# 0.22.0 리뷰: 고친 것, 남은 것

## 폼 서버

테스트: `src/forms.test.ts` ("forms review: …"), `src/db/drizzle.test.ts` ("db: 0.22 forms review on Postgres …").

| 발견 | 수정 | 테스트 |
| --- | --- | --- |
| P1 동시 저장이 서로 덮어쓰고 버전 번호를 두 번 씀 | `RecordPatch.ifUpdatedAt`: `updateRecord`가 `WHERE id=? AND date_trunc('ms', updated_at)=?` 한 문장으로 비교 후 교체 (MemoryRepo도 같은 의미). `forms.update()`가 읽은 행의 `updatedAt`으로 교체하고, 진 쪽은 `form_conflict`. 새 `updatedAt`은 늘 이전보다 뒤 (`after()`) | "two saves that read the same form…" (MemoryRepo), pglite 테스트 |
| P1 업로드 허가가 원자적으로 한 번만 쓰이지 않음, 실패 시 고아 파일 | 허가마다 `cms_records` 행 (kind `form_upload`, issued → uploaded → claimed → done). PUT과 제출 모두 비교 후 교체로 차지함. 직접(서명된) PUT도 행의 임시 키로만 감. 저장 실패 시 복사본 삭제, 허가 되돌림 (같은 토큰으로 다시 보낼 수 있음), 지우지 못한 복사본은 `orphans`에 남겨 하루 청소가 지움. 차지했지만 저장 안 된 허가도 청소가 정리함 | "one upload token sent by two submissions at once…", "a submission whose insert fails…", pglite 테스트 |
| P1 multipart boundary를 소문자로 바꿔 거부됨 | `mediaType()`로 미디어 타입만 소문자로 골라 분기, 파싱은 보낸 헤더 그대로 | "browser-style multipart with a mixed-case boundary…" |
| P1 npm 패키지에 UPGRADE-0.22.md 없음 | `package.json` `files`에 추가, `scripts/check-pack-files.mjs`가 루트의 모든 `UPGRADE-*.md`(0.21, 0.22 포함)·README·CHANGELOG·LICENSE를 `npm pack --dry-run`에서 확인 (`npm run check:pack` 첫 단계) | `npm run check:pack` |
| P2 verify가 이미 읽힌 요청을 받음 | `verify(req, { form, values, raw })`: `raw`는 파싱된 전체 입력 (선언 안 된 캡차 토큰 포함), `req`는 같은 바이트(최대 64KB)로 만든 읽을 수 있는 사본 | "verify gets the parsed fields…" |
| P2 요청 제한의 주소 출처가 불분명 | `forms.clientIp(req)` → 핸들러 `clientIp` → `X-Forwarded-For` 첫 항목. 새 `clientIpBehind(n)` (덧붙이는 프록시 뒤). README·UPGRADE에 설정 필요 명시 | "forms.clientIp decides the sender's address…" |
| P2 Node 어댑터가 64KB 폼에 8MB까지 버퍼링 | `bodyLimit()`: `POST {basePath}/forms/:slug`는 64KB, 선언된 길이가 넘으면 읽기 전에 413, 아니면 읽는 중 413. 새 옵션 `basePath` | "the Node adapter refuses a form submission past 64 KB…" |
| P2 로그·감사에 토큰과 파일 이름 | `redactPath`가 `/forms/:slug/uploads/:token`으로 씀, `form.submitted` 이벤트와 `form.file_open` 감사는 파일 id (이름은 `eventValues: true`일 때만), 임시 키에 파일 이름 없음 | "upload tokens are not in request logs…" |
| P2 보관 기간 삭제가 파일보다 행을 먼저 지움 | `purge()`: `selectFormSubmissions`로 고르고 파일을 먼저 지운 뒤 파일이 다 지워진 행만 삭제. 실패한 행은 다음 실행에서 다시 | "retention deletes files first…", pglite 테스트 |
| P2 CSV가 목록 필터를 안 받음 | `GET /forms/:slug/export.csv?status=&q=`, `client.exportSubmissions(slug, { status, q })` (상태 배열만 줘도 됨), openapi 반영 | "CSV export takes the list's filters…" |
| P2 업로드 가능 여부가 안 보임 | 관리 응답(목록, 정의, 생성, 수정)과 `_me.forms`에 `uploads: boolean`. 필수 파일 칸이 있는 폼은 업로드 불가 서버에서 켜기/켠 채 저장 거부 `form_uploads_unavailable` (`field`) | "the admin sees whether files can be taken…" |
| P2 정의 오류 이유가 영어로 한국어 문장에 섞임 | `definitionIssues()` (코드 `issue`, `field`, `step`, `value`), `form_invalid` params에 실어 보냄 (`reason`은 영어 그대로 유지, `more`, 문제마다 진단). ko 문구가 코드별로 완전한 한국어. `form_upload_invalid`의 `reason`도 ko에서 번역 | "definition problems are codes…" |

남은 것:
- 사용자 정의 repo가 `ifUpdatedAt`을 무시하면 원자성이 없음 (UPGRADE에 명시).
- 청소가 "차지됐지만 저장 안 된" 허가를 판단할 때 제출 값 검색(`q` = 파일 id)을 씀. 정확하지만 큰 폼에서는 느릴 수 있음.
- 관리 화면이 `uploads`와 CSV 필터를 쓰도록 연결하는 일은 UI 쪽 작업.

## 다국어 서버

테스트: `src/review-0-22.test.ts` ("review 0.22: …"), `src/locale.test.ts` (기존 테스트를 새 동작에 맞춤), `src/db/drizzle.test.ts` ("db: review 0.22 (다국어) …").

| 발견 | 수정 | 테스트 |
| --- | --- | --- |
| P0 번역 읽기가 원문의 초안·숨은 공유 필드를 노출 | `src/cms.ts` `sharedSource()`·`fillShared(docs, draft, actor)`: 원문을 고칠 수 있는 편집자만 원문 작업본, 그 밖에는 원문 발행본을 그 사람이 원문을 읽을 때와 같은 규칙(`access.read`, `fieldAccess`)으로 거른 것. 원문 발행본이 없거나 못 읽으면 번역에 저장된 공유 값 사본(원문 초안에서 복사됨)과 분류를 지움. get, list, page, search(규칙 있는 컬렉션은 결과마다 원문 규칙으로 다시 채움), expand(`docForReader`) 모두. 규칙이 있는 컬렉션은 캐시 뒤에서 사람마다 채움 (`perReader`) | "a draft source's shared fields never reach readers…", "a source denied by access.read or fieldAccess…" |
| P0 번역 이벤트로 자동화가 원문을 바꿈 | `src/automations.ts`: `addressOf(col, slug, locale)`로 이벤트의 `locale`을 `slug@locale`로 찾고, 수정·릴리스 추가·다시 읽기 모두 `docAddress(d)` 사용. `src/cms.ts`가 `addressOf` 연결 | "an automation on publish acts on the English translation only" |
| P0 휴지통 연쇄가 번역 권한·가드를 건너뛰고 원자적이지 않음 | 삭제 `remove()`: 번역마다 `assert(delete)`, 참조 확인, `beforeDelete`를 먼저 다 통과해야 시작, 트랜잭션 안에서 확인 뒤 생긴 번역은 충돌. 복원 `restoreOne()` (`src/flow.ts`): 돌아올 번역마다 권한 먼저, 쓰기는 `repo.tx` 하나 (MemoryRepo는 스냅숏 되돌림) | "deleting a source is refused when one translation may not be deleted…", "a beforeDelete hook refusing a translation…", "restoring … is all or nothing" (Memory, pglite) |
| P1 원문 이름 바꾸면 발행된 번역이 옛 주소로 남음 | `commit()`: 번역의 `published.slug`도 바꿈 (공개 사본, 검색, 사이트맵), `redirects`가 켜져 있으면 발행된 번역마다 옛 주소 → 새 주소. `src/model.ts` `targetOf()`가 번역의 주소를 `slug@locale`로 계산 | "renaming a source moves its published translations' …" |
| P1 원문만 바뀌어도 번역이 304 | `src/http.ts` `contentTag()`: 번역은 보낸 본문·필드·분류·형식의 해시를 붙인 약한 태그 (`W/"v3-en-…"`) | "a source-only change to a shared field gives the translation a new ETag…" |
| P1 번역 쓰기의 `If-Match`가 다른 언어 태그를 받음 | `localeTagMatches()`: 다른 언어의 태그(같은 버전이라도)와 번역에 보낸 언어 없는 태그는 409 `locale_etag_mismatch` (새 코드, en/ko 문구). 맨 숫자(`If-Match: 3`)는 그대로 받음 | 같은 테스트, "If-Match tags of another language…", `locale.test.ts` REST 테스트 |
| P1 Postgres 분류 필터가 번역의 낡은 분류로 거름 | `pageOf()`: 언어와 분류를 함께 거는 페이지는 SQL 빠른 길을 쓰지 않고 채운 행에서 거름 (list와 같은 결과) | pglite "a language's page filtered by category follows the source…" |
| P1 `bulk_documents`, `add_to_release`가 locale을 안 받음 | `src/tools.ts`: `bulk_documents`의 `locale` (모든 slug에), `add_to_release`의 항목별 `locale` → `cms.address()`로 `slug@locale`. 결과는 slug와 `locale`. 릴리스 보기 항목에 `locale` (`src/flow.ts`) | "bulk_documents and add_to_release with locale…" |
| P2 `list_translations`가 읽기 전용 호출자를 막음 | `translations()`: 편집자는 전체, 그 밖에는 읽을 수 있는 발행 언어만 (발행 버전, 초안 정보 없음) | "list_translations gives readers only the published languages…", `locale.test.ts` |
| P2 `@`가 든 slug | locales가 켜져 있으면 `@` 든 slug는 `invalid_slug`. `inspect()`의 `atSlugs`(`@<언어>`로 끝나는 slug), `migrate check`와 `doctor`가 알림 | "with locales on a slug with @ is refused…" |
| P2 실패한 CONCURRENTLY 인덱스(INVALID) 뒤에 옛 인덱스를 지움 | `src/tables.ts` `invalidIndexGuard()`: 스키마 11 단계가 옛 인덱스를 지우기 전에 `pg_index.indisvalid` 확인, 무효면 멈춤 (옛 인덱스 유지). `inspect()`의 `invalidIndexes`, `doctor` 실패, `migrate check` 알림 | pglite (`indisvalid = false`로 만든 뒤 단계 실행) |
| P2 문서 | README 다국어 예제를 그대로 실행되게 (import, repo, label, visibility, 원문 생성). UPGRADE-0.22.md: `migrate check`(보고, SQL 출력)와 `migrate apply`(실행) 구분, 사전 점검. CHANGELOG 0.22.0 문구를 동작에 맞춤 | README 예제를 실제로 실행해 확인 |

남은 것:
- 규칙(`access.read`/`fieldAccess`)이 있는 컬렉션은 번역 목록 캐시가 채우기 전 행을 담고 읽을 때마다 원문을 다시 읽음 (원문 조회 한 번 더).
- 언어 + 분류 페이지는 메모리 경로(목록 전체를 읽고 자름)라 아주 큰 컬렉션에서는 느림. SQL에서 원문과 조인하는 빠른 길은 다음에.
- 번역 이벤트의 `slug`는 여전히 맨 slug이고 `locale`이 따로 옴 (웹훅 받는 쪽 형식은 그대로).

## 화면

고친 것 (각 항목 옆은 UI 테스트):
- P0 뒤로 가기로 폼 초안이 사라지던 것: 라우터(`admin/main.tsx`)가 popstate도 막음. 고친 것이 있으면 확인을 받고, 취소하면 주소를 원래대로 되돌림. 문서 편집기도 같은 `beforeunload` 신호를 쓰므로 함께 막힘. 저장 안 한 폼 고침은 sessionStorage(`cms-form-draft:<id>`, 읽은 시점 `updatedAt` 기준)에 남고, 다시 열면 "저장 안 한 고침이 있음 — 되살리기 / 버리기"가 뜸. 그사이 누가 저장했으면 남은 고침은 버림 (`forms-review`: form draft 두 개).
- P0 저장하는 동안 고친 것이 응답에 덮이던 것: 응답의 버전·시각만 받고 그사이 고친 것은 그대로 두어 저장 안 함 상태로 남음. 주소가 바뀌어 화면이 다시 열려도 따라옴 (`form save: edits made while…`).
- P0 파일 서버 없는 곳의 필수 파일 필드: 폼 정의의 `uploads`가 false이면 필드 줄에 "파일 못 받음", 종류 선택에 "(이 서버에서 못 받음)", 패널에 경고(필수이면 폼을 켤 수 없다고), 미리보기에서도 공개 페이지처럼 못 받는다고 보임. 켜기가 거절되면(`form_uploads_unavailable`) 이유가 스위치 아래 알림 줄에 남음 (`file fields on a server that takes no files…`).
- P1 폼 안 탭 전환(필드·제출·설정)은 묻지 않음(`go(…, { guard: false })`). 편집기 자체 대화상자에서 "나가기/저장하지 않고 바꾸기/저장하고 바꾸기"를 고르면 라우터가 다시 묻지 않음 (`form tabs…`, `form draft: leaving through…`, `locale: 'Switch without saving'…`).
- P1 보기 이름을 바꾸면 조건이 깨지던 것: 보기 값은 만들 때 한 번(`option_N`, 겹치지 않게) 정하고 이름만 바뀜. 조건이 없는 보기·맞지 않는 연산을 보면 그 필드에 오류, 저장은 막히고 요약 메시지가 뜸. 다른 필드가 조건으로 쓰는 필드를 지우면 목록을 보여 주고 "필드와 조건 삭제 / 취소"를 물음 (`choices: renaming…`, `removing a field…`).
- P1 HTML 퍼가기: 파일 필드나 조건이 있으면 복사할 코드 대신 이유와 "React 컴포넌트 쓰기"를 보임. 버튼 글자는 `cf_send` 번역을 씀 (`embed: …` 두 개).
- P1 지난 제출의 첨부: 지금 폼에 없는 필드라도 제출에 저장된 `files`로 이름·크기를 보여 주고 열 수 있음 (`submissions: files of a field removed since…`).
- P1 CSV: 제출 탭 위에 "CSV에는 지금 보이는 목록이 담김: 받은 편지함 N건"(검색 중이면 검색어도)을 보이고, 내보내기는 같은 상자와 검색어(`exportSubmissions(slug, { status, q })`)를 보냄. 빈 목록이면 버튼이 꺼짐 (`CSV: says what it takes…`).
- P2 "vN 기준으로 맞춤"은 화면의 버전을 보내고, 그사이 원문이 새로 게시됐으면 바뀐 곳을 펼치고 다시 확인하라고 알림 (`locale: mark as matching sends…`).
- P2 공개 폼: 파일 필드 묶음이 `tabIndex=-1` 그룹(오류를 `aria-describedby`로 연결)이라 선택기가 꺼져 있어도 초점이 감. 올리기 실패는 `aria-live` 문구로 읽힘 (`public form: a required file field…`).
- P2 휴대폰 누름 영역 40px 이상: 필드 순서 버튼·단계 선택·보기 빼기·필드 삭제, 제출 상자 탭·검색 지우기·첨부 버튼, 공개 폼 이전/다음/보내기·파일 빼기.
- P3 번역 비교: 원문 옆에서는 문서 정보가 한 줄로 접혀 두 본문이 화면을 거의 다 씀 (필드 오류가 있으면 자동으로 펼침). 360px에서 언어 탭은 현재 탭만 상태 글자를 보이고 나머지는 점으로 줄여 잘리지 않음. 휴대폰 편집/원문/미리보기/댓글 탭이 화면 밖으로 나가던 것도 줄바꿈으로 고침 (`locale: comparing with the source folds…`).
- P3 문구: "받은 것으로" → "받은 편지함으로 이동", 공유 필드 안내는 자물쇠 표시의 뜻을 설명함.

화면 확인 (헤드리스 브라우저, `.slash/workspace/vis/fix22/`): `1440-uploads-off.png`, `1440-restore-offer.png`, `1440-submissions-csv-scope.png`, `1440-embed-html-blocked.png`, `1440-translation-compare.png`, `360-restore-offer.png`, `360-submissions.png`, `360-field-panel.png`, `360-preview-step2.png`, `360-translation-tabs.png`. 뒤로 가기 → 취소하면 주소와 고침이 남고, 확인하면 목록으로 가고 다시 열 때 되살리기를 물음을 실제로 확인함.

남은 것:
- (해결) `locale: a translation shows the shared fields read only…` 실패: 리뷰 수정으로 번역 쓰기의 `If-Match`가 언어를 확인하게 됐는데, `client.ts`가 언어 없는 `"vN"`을 보내 409 `locale_etag_mismatch`가 남. 클라이언트가 `slug@locale` 주소면 `"vN-<언어>"`를 보내도록 고침 (`client: If-Match on a translation names its language…`).
- sessionStorage 초안은 탭 안에서만 남음 (탭을 닫으면 사라짐). 의도한 범위임.

## 3차 (확인 리뷰) 서버

| 지적 | 고친 것 | 테스트 |
| --- | --- | --- |
| P0 번역 자동 저장(autosave)에 원문에서 못 읽는 공유 필드가 실림 (쓰기 응답, 이후 초안 GET) | `src/cms.ts` `sharedCopy()`: `fillShared()`가 자동 저장 사본도 문서와 같은 원문 사본(읽는 사람 기준으로 투영)으로 채움. 원문 사본이 있어도 번역에 저장된 공유 값은 버림. `autosave()` 응답, 쓰기 응답(`forCaller()`가 번역이면 `fillOne(…, actor)`), 충돌 응답(`sharedless()`)도 같은 길 | `src/review-0-22.test.ts` "a translation's autosave never carries…" (core + REST, 응답 전체 `JSON.stringify`/본문 문자열 검사) |
| P1 옛 번역 버전을 게시하면(직접, 릴리스) 옛 slug가 `published`로 들어감 | `publishIn()`: 번역이면 게시 사본의 `slug`를 지금 그룹 주소로 찍음. 기록(버전 스냅숏)은 그대로 | "publishing an older translation version puts it at the group's current address…" |
| P1 게시 안 된 원문 + 게시된 번역: 원문 초안 이름 바꾸기가 살아 있는 번역을 게시·리디렉트 없이 옮김 | `commit()`: 그룹 안 아무 언어라도 살아 있으면 `moved` (`slug_needs_publish`, `slug_locked` 규칙 적용). 리디렉트는 살아 있는 언어마다(원문은 게시돼 있을 때만). 번역 행 이동은 원문 쓰기가 통과한 뒤에 | "renaming a never-published source whose translation is live…" |
| P1 휴지통 연쇄 삭제·복원의 사전 점검이 실제 쓰기와 묶이지 않음 | 삭제: 각 행을 점검한 버전·살아 있음 조건으로 씀(`updateDoc(…, version)`, 실패하면 `conflict_version`, 전체 취소), 번역이 있으면 `{ atomic: true }`. 복원(`src/flow.ts` `restoreOne`): 묶음을 트랜잭션 안에서 다시 읽어 비교, 각 행은 `updateDoc(…, { trashed: { version, deletedAt } })` 조건부(새 오류 `trash_changed`), 여럿이면 `atomic`. `src/drizzle-repo.ts`: 조건부 복원 SQL, `lockGroup()`(그룹 id 기준 advisory xact lock)을 연쇄 삭제·복원·번역 시작에서 잡음. 트랜잭션 없는 드라이버는 `transactions_required` | "a translation revised between the delete's check…", "a restore whose batch changed…"; pglite `src/db/drizzle.test.ts` "cascades are bound to the rows checked…" (`transactions: false` 포함) |
| P2 번역 ETag가 주소·게시 시각 등 버전 없는 변화를 모름; `If-Match: "vN"` 문서와 코드 불일치 | `src/http.ts` `contentTag()`: 번역은 보낸 문서 전체로 해시. 언어 없는 태그는 번역에서 거절(코드 유지), UPGRADE-0.22.md·CHANGELOG를 코드에 맞춤 | "translation ETags follow the address…" |
| P2 `list_translations` 투영이 컬렉션 단위로 먼저 거절하고, 못 읽는 원문의 버전을 알려 줌 | `translations()`: 언어마다 문서 read 규칙 + `beforeRead`로 따로 판단, 원문을 못 읽으면 `sourceVersion: null`(타입 `number \| null`)이고 상태는 `current` | "list_translations judges each language by its own read rule…" |
| P2 업로드 청소가 삭제 실패한 200건에서 멈춤; 복사 대상 키를 복사 뒤에 기록 | `src/forms.ts` `sweepUploads()`: 오래된 쪽에서 내려가며(desc) 남은 행이 있으면 커서를 그 뒤로 옮김. 제출: 대상 키를 `copy` 전에 `copied`에 넣음 | `src/forms.test.ts` "the upload sweep pages past grants…", "a copy that lands but answers with an error…" |
| P2 Node 본문 한도가 사용자 basePath에서 안 걸림; chunked 초과 시 소켓을 끊어 413이 안 감 | `src/serve.ts`가 정규화한 `basePath`를 어댑터에 넘김. `src/adapters/node.ts` `readBody()`: 한도를 넘으면 더 모으지 않고 나머지는 흘려 버림(소켓 유지), 413에 `connection: close` | `src/serve.test.ts` "a form submission past 64 KB on a custom basePath…" (실제 HTTP, Content-Length와 chunked) |

남은 것:
- 메모리 repo의 `lockGroup`은 없음 (한 프로세스, 테스트용). 원격 트랜잭션 없는 드라이버에서 번역 없는 문서 하나 삭제는 예전처럼 조건부 쓰기만으로 처리.
- 번역 시작(`create` with `locale`)과 연쇄 삭제는 Postgres에서 같은 그룹 잠금으로 줄을 섬. 다른 저장소는 삭제 쪽의 묶음 재확인(`listDocs(groupId)` 비교)에 기댐.

## 3차 (확인 리뷰) 화면

고친 것 (각 항목 옆은 UI 테스트):
- P1 보기 값 재사용: 새 보기 값은 `option_<n>`, n은 필드의 `nextOption`(새 속성, `src/form-rules.ts`의 `FormField`)과 지금 값 중 가장 큰 `option_<n>`, 보기 수 + 1 중 큰 것부터 비어 있는 첫 번호 (`nextOptionNumber()`, 같은 파일에서 내보냄). 보기를 빼면 그 전에 카운터가 뺀 값 뒤로 옮겨져 같은 값이 다시 나오지 않음. 종류를 선택으로 바꿀 때 만드는 기본 보기 둘도 카운터를 씀. 이미 저장된 이름 값(`bug` 등)은 그대로. 같은 고침에서 보기를 빼고 새로 더해도 뺀 값을 보던 조건은 "없는 보기" 오류로 남음 (`choices: a removed choice's value is never given…`, `choices: the next value comes from the field's counter…`). 서버가 저장할 때 `nextOption`을 남겨야 저장 뒤에도 이어짐: `src/forms.ts` `cleanSteps()`에 한 줄 필요 (아래 남은 것).
- P1 CSV 범위: 제출 목록이 `onView`에 `state`(`loading`/`ready`/`error`)를 함께 알림. 상자·검색을 바꾸거나 검색어를 치는 중(아직 적용 전)이면 `loading`, 불러오기 실패면 `error`. 내려받기는 `ready`일 때만 켜지고, 버튼에 연결된 줄이 이유를 말함: "Spam 목록을 다 불러온 뒤 CSV 내려받기 가능", "목록을 불러오지 못해 CSV 없음", "담긴 것이 없어 CSV 없음". 다른 상자로 바꾼 뒤 불러오기가 실패하면 앞 상자의 줄을 그 아래 보이지 않음 (`CSV: switching box disables the download until…`).
- P2 저장 안 한 폼에서 뒤로/앞으로 취소: 라우터를 `admin/history.ts`로 옮김. 앱이 만드는 모든 기록 항목의 `history.state.cmsIdx`에 위치를 남기고, 취소하면 `history.go(지금 − 간 곳)`으로 되돌림(한 번만 쓰는 표시로 그 popstate는 무시). 새 항목을 넣지 않으므로 앞으로 가기 항목과 상태가 남음. 위치 없는 항목(앱 밖에서 생긴 것)만 예전처럼 다시 넣음 (`admin-history`: router 세 개).
- P2 CI `ui` 작업: 테스트 단계가 시작 53초 뒤 "The runner has received a shutdown signal"로 끝남 (10분 제한이 아님, 실패한 테스트 없음). 그때 돌던 파일은 `model.test.tsx`. 이 파일의 `await waitFor(() => assert.equal(document.activeElement, …))` 두 곳은 초점이 늦게 오면(느린 CI) 실패 메시지를 만들며 DOM 노드를 출력하는데, 노드 하나를 출력하는 것만으로 로컬에서도 3분 넘게 끝나지 않음을 확인함 (메모리 계속 증가). `document.activeElement`를 노드와 `assert.equal`로 비교하던 6곳(`model` 4, `locale` 1, `editor-toolbar` 1)을 `assert.ok(a === b, "focus on …")`로 바꿈. 다시 생기지 않게 `registry/__tests__/test-rules.test.ts`가 테스트 파일에서 이 형태를 거부함. `test:ui`에 `--test-timeout=120000`. 그 밖에: `forms-review`의 CSV 테스트가 `URL.revokeObjectURL`을 되돌리지 않던 것 고침. 남은 타이머·열린 핸들은 없음: 전체 실행이 요약 뒤 1초 안에 끝남 (CI와 같은 명령 `NODE_OPTIONS=--max-old-space-size=2048 npm run test:ui`, 2 CPU에서 5회 모두 통과, 프로세스 합계 최대 1.5 GB).

화면 확인 (헤드리스 브라우저, `npm run build:admin` 후 `dev`, `.slash/workspace/vis/fix22b/`): `1440-csv-ready.png`, `1440-csv-loading.png`(스팸 응답을 8초 늦춤: 버튼 꺼짐, 이유 줄), `1440-csv-failed.png`, `360-csv-failed.png`, `1440-choice-replaced-flagged.png`("버그"를 빼고 보기 추가: 새 보기는 다른 값, 버그를 보던 두 필드에 오류). 실제 브라우저에서 고친 폼 → 뒤로 → 취소: 주소·`cmsIdx`·기록 길이 그대로, 다시 뒤로(확인) → 목록, 앞으로 → 폼으로 돌아감.

남은 것:
- `src/forms.ts` `cleanSteps()`가 모르는 속성을 버려서 `nextOption`이 아직 저장되지 않음. 저장 뒤 다시 열면 카운터는 지금 값과 보기 수에서 다시 계산되므로, 저장 전에 지운 가장 큰 `option_<n>`은 다시 나올 수 있음. 서버 쪽 한 줄과 OpenAPI 설명 추가 필요.
- 실패한 불러오기에서 다시 시도는 목록의 "다시 시도" 버튼으로 함 (CSV 줄에는 버튼 없음).
