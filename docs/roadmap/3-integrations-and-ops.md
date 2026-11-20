# 묶음 3: 연동과 운영 (0.12.0)

CMS를 바깥 시스템과 잇고, 호스트 앱 없이도 띄우고, 운영에 필요한 장치를 갖춘다. 가장 큰 묶음이라 세 번에 나눠 낸다.

`TODO.md` 번호 (구현 순서): 126, 20, 120, 95, 26, 105, 131, 79, 27, 113, 101, 115, 122, 121, 93, 92, 134, 80, 18, 81, 83, 73, 21, 75, 76, 77, 78, 82, 90, 104, 106, 127.

| 나눠 내기 | 내용 | 번호 |
|---|---|---|
| 0.12.0 | 작업 실행기, 웹훅, 자동화, 대시보드, 훅과 플러그인과 이벤트 | 126, 20, 120, 121, 93, 92, 134, 80 |
| 0.12.1 | OpenAPI, 가져오기와 내보내기, 어댑터, 역할, 단독 서버와 로그인 | 95, 26, 105, 131, 79, 27, 113, 101, 115, 122 |
| 0.12.2 | 운영과 성능 | 18, 81, 83, 73, 21, 75, 76, 77, 78, 82, 90, 104, 106, 127 |

시안 (승인되면 그 버전에 고정한다):

[연동과 운영](../../.slash/workspace/mockups/ops-integrations/mockup.json)

## 126. 백그라운드 작업 실행기

**무엇을, 왜.** 예약 게시, 웹훅 재시도, 휴지통 비우기, 자동화, 올리다 만 파일 정리가 모두 "나중에, 요청 밖에서" 실행돼야 한다. 이 라이브러리는 호스트 앱 안에서 돌기 때문에 스스로 타이머를 가질 수 없다. 그래서 작업을 표에 적어 두고, 누군가 불러 줄 때 꺼내 실행한다 (Payload jobs).

**데이터.** `cms_jobs(id, kind, payload jsonb, run_at, attempts, max_attempts, locked_until, last_error, done_at)`.

**동작.**

- `cms.runJobs({ budgetMs })`가 실행할 때가 된 작업을 꺼내 정해진 시간 안에서 실행한다. 여러 곳에서 동시에 불러도 같은 작업을 두 번 실행하지 않는다 (`FOR UPDATE SKIP LOCKED`와 잠금 시각).
- 부르는 길 셋:
  1. `/api/cms/_cron` (GET과 POST 둘 다 받는다. 크론 서비스마다 부르는 방식이 다르다). `createCms({ cronSecret })`를 `Authorization: Bearer`로 확인한다. Vercel 크론이 이 헤더를 붙여 부른다. 다른 호스팅은 자기 크론으로 같은 주소를 부른다.
  2. CLI `agent-cms cron` (한 번 실행하고 끝) 또는 `agent-cms cron --watch`.
  3. 단독 서버(115번)는 안에서 30초마다 스스로 부른다.
- 실패하면 작업 종류마다 정한 간격으로 다시 시도하고, 끝까지 실패하면 `last_error`와 함께 남긴다. `doctor`가 실패한 작업 수를 알려 준다.
- 묶음 2에서 먼저 만든 `runScheduled()`는 이 실행기의 작업 종류 하나가 된다.

**확인하지 못한 것.** Vercel이 크론을 "Schedules"로 옮기는 중이다 (2026-11-19 문서). 옮긴 뒤에도 `Authorization: Bearer <CRON_SECRET>`으로 부르는지 시작할 때 확인한다.

## 20. 웹훅

**무엇을, 왜.** 문서가 게시되면 사이트의 캐시를 비우거나 메신저에 알리고 싶다. 지금은 앱이 `afterChange` 훅을 코드로 짜야 한다. 웹훅이 있으면 화면에서 주소만 넣으면 된다.

**데이터.** `cms_webhooks(id, name, url, events[], collections[], secret_enc, enabled, failures, created_by*)`, `cms_webhook_deliveries(id, webhook_id, event, payload, status, response_ms, attempt, error, at)`.

**동작.**

- 이벤트: `doc.created`, `doc.updated`, `doc.published`, `doc.unpublished`, `doc.archived`, `doc.deleted`, `doc.restored`, `review.requested`, `review.approved`, `review.rejected`, `asset.uploaded`, `asset.moved`, `asset.deleted`, `release.published`, `comment.created`, `form.submitted`. 화면에서는 사람이 읽는 이름으로 보여 준다 (시안의 "게시", "게시 취소", "검토 요청").
- 보내는 내용: `{ id, event, at, actor, collection, slug, version, url }`. 본문 전체는 넣지 않는다 (받는 쪽이 필요하면 API로 읽는다).
- 서명: 헤더 `X-CMS-Signature: t=<시각>,v1=<HMAC-SHA256>`. 받는 쪽이 확인하는 함수 `verifyWebhook(req, secret)`을 `./webhooks`에서 내보낸다.
- 서명 키는 DB에 암호화해서 저장한다 (`createCms({ secretsKey })`). `secretsKey`가 없으면 웹훅을 만들 수 없다. 화면에는 만들 때와 "복사"를 누를 때만 보인다.
- 실패하면 1분, 5분, 30분, 2시간, 12시간 뒤에 다시 보낸다 (5번). 연속 20번 실패하면 자동으로 끄고 감사 로그에 남긴다.
- 보낼 수 있는 주소는 `import_asset`과 같은 규칙으로 막는다 (https만, 내부망과 로컬 주소 차단). 개발 중에는 `webhooks: { allowInsecure: true }`로 풀 수 있다.
- 전송 기록은 30일 보관한다.

**API와 도구.** `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries`, `POST /webhooks/deliveries/:id/retry`. admin 범위가 필요하다. 에이전트 도구로는 내지 않는다 (에이전트가 데이터를 밖으로 보내는 길을 스스로 만들면 안 된다). CLI `agent-cms webhooks list|test`.

**화면.** 시안 2번.

## 120. 자동화 흐름

**무엇을, 왜.** "Blog에 News 글이 게시되면 태그를 붙이고 Slack에 알린다" 같은 규칙을 개발자 없이 화면에서 만든다 (Directus Flows). 사용자가 로드맵에 넣었다.

**데이터.** `cms_automations(id, name, enabled, trigger jsonb, conditions jsonb, actions jsonb, created_by*)`, `cms_automation_runs(id, automation_id, event, state, steps jsonb, error, at)`.

**구성.**

| 단계 | 고를 수 있는 것 |
|---|---|
| 언제 | 문서가 만들어지면, 저장되면, 게시되면, 게시 취소되면, 삭제되면, 검토가 요청되면, 파일이 올라오면, 폼이 제출되면, 정해진 시각마다 (매일, 매주) |
| 조건 (여러 개, 모두 맞아야 함) | 컬렉션이, 분류가, 필드 값이 (같다, 포함한다, 비어 있다), 바꾼 이가 (사람, 에이전트) |
| 동작 (위에서 아래로) | 웹훅 보내기, 검토 요청하기, 태그 붙이기, 필드 바꾸기, 릴리스에 넣기, 앱 함수 부르기, 플러그인이 더한 동작 |

- 플러그인(92번)이 동작을 더할 수 있다: `ctx.automations.addAction({ name, label, run })`. 시안 3번에 그려진 "번역 초안 만들기"는 모델을 부르는 동작이라 이 패키지에 없고, 확장 패키지가 이 방법으로 더한다. 이 패키지만 쓰면 동작 목록에 보이지 않는다.
- "앱 함수 부르기"는 `createCms({ automations: { actions: { notifySales: async (ctx) => {} } } })`로 앱이 등록한 함수다. 화면에는 등록된 이름이 보인다.
- 자동화가 만든 변경은 감사 로그에 `via: "automation"`과 자동화 이름으로 남는다.
- 자동화가 만든 변경으로 다른 자동화가 다시 실행되지 않는다 (깊이 1). 무한 반복을 막는 가장 단순한 규칙이다.
- "시험 실행"은 고른 문서 하나로 조건을 평가하고, 동작은 실제로 하지 않고 무엇을 할지만 보여 준다.
- 실행은 작업 실행기(126번)가 한다. 실행 기록은 30일 보관한다.

**API.** `GET/POST /automations`, `PATCH/DELETE /automations/:id`, `POST /automations/:id/test`, `GET /automations/:id/runs`. admin 범위. 에이전트 도구로는 내지 않는다.

**화면.** 시안 3번.

## 121. 대시보드

**무엇을, 왜.** 어드민에 들어왔을 때 지금 무슨 일이 일어나고 있는지 한눈에 본다: 검토를 기다리는 글, 에이전트가 얼마나 고쳤는지, 무엇이 많이 읽히는지 (Directus Insights).

**동작.** `GET /_stats?days=7|14|30`이 지금 있는 표에서 숫자를 모은다. 새 표는 없다.

- 요약 카드: 문서 수, 게시됨, 검토 대기, 예약됨. 누르면 그 필터의 목록으로 간다.
- 변경 그래프: 날마다 만들어진 버전 수를 사람과 에이전트로 나눈다 (`cms_versions.author_kind`).
- 많이 본 문서: `cms_hits`.
- 최근 활동: 감사 로그와 최근 버전을 합쳐 10줄.
- 읽기 권한이 없는 컬렉션은 숫자에 넣지 않는다.
- 조회 한 번에 1분 캐시.

위젯을 사용자가 고르거나 배치하는 기능은 만들지 않는다. 앱이 `dashboard.extra` 자리에 자기 카드를 넣을 수 있게만 한다.

**화면.** 시안 1번. 대시보드가 생기면 어드민의 첫 화면이 된다.

## 95. OpenAPI 3.1

**무엇을, 왜.** TypeScript가 아닌 언어(Python, Go)와 자동화 도구가 CMS를 쓰려면 기계가 읽는 계약이 필요하다. 사용자가 "다른 언어에서 접속"을 골랐다.

**어떻게.** 지금 `http.ts`는 `if`로 이어진 경로 검사다. 이것을 경로 표(`{ method, path, input(zod), output(zod), needs }`)로 바꾸고, 표에서 OpenAPI 문서와 실제 처리를 함께 만든다. 문서와 동작이 어긋날 수 없게 하기 위해서다.

- `GET /api/cms/openapi.json`, CLI `agent-cms openapi > openapi.json`.
- 컬렉션마다 `fields`의 zod 스키마가 문서에 들어간다.
- 이 작업이 경로 처리의 큰 고쳐 쓰기라서 기존 REST 테스트 전부가 그대로 통과하는 것을 기준으로 삼는다.
- Python과 Go로 만든 예제 클라이언트를 `examples/`에 넣어 문서에서 생성한 코드가 실제로 도는지 확인한다.

## 26, 105, 131, 79. 가져오기와 내보내기

**무엇을, 왜.** 백업, 초기 데이터 넣기, 로컬에서 편집하기, 다른 CMS에서 옮겨 오기.

**형식.** 폴더 하나.

```
export/
  guide/getting-started.md      # 프런트매터(제목, 요약, 분류, 필드, 상태)와 본문
  guide/connect-slack.md
  _assets/manifest.json         # 파일 ID, 경로, 대체 텍스트, 태그
  _assets/blog/launch-hero.jpg  # --with-files일 때만
  _meta.json                    # 내보낸 버전, 시각, 컬렉션 목록
```

**동작.**

- CLI: `agent-cms export ./content [--collection] [--with-files] [--drafts]`, `agent-cms import ./content [--dry-run] [--diff] [--on-conflict file-wins|db-wins|newest]`.
- `--dry-run --diff`는 문서마다 "새 문서", "v7 → v8", "같음"과 진단 결과, 바뀌는 줄을 보여 준다 (105번). 시안 5번의 표가 이 결과다.
- 같은 주소가 있을 때 (`TODO.md` 105번의 세 가지): `file-wins`는 파일의 내용을 새 버전으로 저장한다 (화면의 "새 버전으로 저장", 기본값. 기존 내용은 버전 기록에 남는다). `db-wins`는 건너뛴다. `newest`는 수정 시각이 더 늦은 쪽을 따른다.
- 가져온 문서는 초안으로 들어간다. `--publish`를 주면 내보낼 때 게시돼 있던 것만 게시한다.
- 문서 안의 `asset:ID`는 가져올 때 새 ID로 바꿔 준다.
- 어드민에서는 ZIP을 올려 가져온다. 서버를 거치므로 4MB까지고, 더 크면 CLI를 쓰라고 안내한다. 내보내기는 ZIP 내려받기.
- **79번**: `agent-cms put <컬렉션> <폴더>`로 폴더째 올리기, `--dry-run`, `agent-cms diff <컬렉션> <파일>`, `--format table|json`.
- **131번**: `agent-cms import --from wordpress <export.xml>`, `--from csv`, `--from json`. HTML 본문은 붙여넣기 정규화(45번)와 같은 변환기로 마크다운으로 바꾼다. 이미지는 `import_asset`과 같은 길로 가져온다.

**화면.** 시안 5번 (가져오기 탭). 내보내기 탭은 시안에 없다.

## 27. 다른 JS 프레임워크 어댑터

지금 핸들러는 표준 `Request`를 받아 `Response`를 돌려준다. 그래서 대부분은 예제만 있으면 된다.

| 대상 | 방법 |
|---|---|
| Hono, Remix, SvelteKit, Astro, Nuxt(Nitro), Bun, Deno | 표준 `Request`를 그대로 넘긴다. 프레임워크마다 예제 한 쪽 |
| Express, Fastify, Node 기본 서버 | `./adapters/node`의 `toNodeHandler(handler)`가 Node 요청을 표준 요청으로 바꾼다 |

`resolveUser`(누가 로그인했는지)를 프레임워크마다 어떻게 잇는지가 실제 어려운 부분이라 예제마다 그 코드를 넣는다. 예제는 CI에서 띄워 `/_me`가 답하는지까지 확인한다.

## 113. 역할 관리 화면

**무엇을, 왜.** 지금 사람의 권한은 `isAdmin` 하나와 컬렉션마다의 코드 함수다. 운영자가 화면에서 "이 사람은 Blog만 쓸 수 있다"를 정할 수 없다 (Strapi, Directus).

**데이터.** `cms_roles(id, name, permissions jsonb, builtin)`, `cms_role_members(role_id, user_id)`.

**동작.**

- 대상(컬렉션마다, 단일 문서마다, 미디어, 폼)마다 읽기, 쓰기, 게시, 삭제를 켠다. 사람에게는 삭제가 게시와 따로 있다. 키는 지금처럼 publish 범위가 삭제를 포함한다.
- 권한을 정하는 순서: 시스템 > 컬렉션의 코드 함수(`access`) > 역할 > 기본값(관리자만 쓰기). 코드 함수가 있는 컬렉션은 화면에서 "코드에서 정함"으로 보이고 고칠 수 없다.
- 기본 역할 넷: 관리자(전부), 편집자(읽기, 쓰기, 게시), 작성자(읽기, 쓰기), 보기 전용. 고치거나 지울 수 있지만 관리자 역할의 마지막 한 사람은 뺄 수 없다.
- 역할을 하나도 만들지 않은 앱은 지금과 똑같이 동작한다.
- 사람 목록은 앱이 준다: `createCms({ users: { search(q), get(id) } })`. 단독 서버에서는 122번의 사용자 표를 쓴다.
- 역할 변경은 감사 로그에 남는다 (`role.update`, `role.member.add`, `role.member.remove`).

**화면.** 시안 4번.

## 101, 115. 단독 서버

**무엇을, 왜.** 호스트 앱 없이 CMS만 띄운다. Python이나 Go로 만든 앱 옆에 두고 REST로 쓴다. 사용자가 골랐다. 101번(`agent-cms dev`)은 개발용, 115번은 운영용이고 같은 코드다.

**어떻게.**

- `agent-cms serve --config agent-cms.config.ts --port 3000`. 어드민 화면, REST, MCP, `/files`, `/_cron`을 한 프로세스가 낸다. 작업 실행기를 안에서 돌린다.
- `agent-cms dev`는 같은 것을 pglite(파일 하나짜리 Postgres)와 메모리 저장소로 띄운다. 설정 파일만 있으면 DB 없이 써 볼 수 있다.
- 어드민 화면은 복사형 부품을 미리 빌드한 묶음(`dist/admin`)으로 패키지에 넣는다. 호스트 앱에 얹을 때는 지금처럼 복사해 쓴다.
- Docker 이미지와 `docker-compose.yml`(CMS, Postgres, MinIO) 예제.
- 공개 화면(블로그 등)은 내지 않는다. 그것은 앱의 일이다. 앱은 지금처럼 REST로 게시된 문서를 읽는다 (공개 컬렉션은 키 없이도 읽힌다).

## 122. 단독 서버용 로그인

**무엇을, 왜.** 호스트 앱에 얹을 때는 앱의 로그인을 쓴다 (`resolveUser`). 단독 서버에는 그 앱이 없으므로 자체 로그인이 필요하다.

**데이터.** `cms_users(id, email, name, password_hash, disabled_at, created_at)`, `cms_sessions(id, user_id, expires_at, ip, user_agent)`.

**동작.**

- `./auth` 모듈. 단독 서버에서만 켠다. 호스트 앱에서도 원하면 쓸 수 있다.
- 비밀번호는 scrypt로 해시한다. 세션은 httpOnly, SameSite=Lax 쿠키, 30일.
- 가입 화면은 없다. 첫 관리자는 CLI `agent-cms user create --admin`으로 만들고, 나머지는 관리자가 초대한다 (초대 링크, 7일).
- 로그인 시도는 계정과 IP마다 제한한다 (15분에 10번).
- SSO: OIDC(코드 흐름과 PKCE). `auth: { oidc: { issuer, clientId, clientSecret, allowedDomains, defaultRole } }`. Google, Microsoft, Okta 같은 곳이 이 방식을 쓴다. SAML은 요청이 있을 때 한다.
- 비밀번호 재설정 메일은 앱이 주는 `auth.sendMail` 함수로 보낸다. 없으면 관리자가 재설정 링크를 만들어 준다.
- 로그인, 실패, 초대는 감사 로그에 남는다.

**화면.** 시안 6번 (로그인). 사용자 관리 화면은 시안에 없다.

## 93, 92, 80. 훅, 플러그인, 이벤트

- **93.** 컬렉션 훅을 `afterChange` 하나에서 `beforeValidate`, `beforeChange`(내용을 바꿀 수 있음), `afterChange`, `beforePublish`, `afterPublish`, `afterDelete`, `afterRead`로 넓힌다. 인자는 `{ actor, doc, previous, operation }`. `before*`에서 `throw`하면 그 작업이 멈추고 메시지가 사용자에게 간다.
- **92.** `definePlugin({ name, setup(ctx) })`. 플러그인은 훅, 경로, 테이블, 도구, 자동화 동작, `GET /_me`에 덧붙일 값, 어드민 메뉴(`extraNav`)를 추가한다. 플러그인의 테이블은 `migrate`가 함께 만든다. 플러그인의 경로는 `/api/cms/<플러그인 이름>/` 아래에 놓이고, 로그인과 키 확인을 거친 행위자를 받는다. 웹훅과 자동화를 이 방식으로 만들어 플러그인 계약이 실제로 충분한지 확인한다.
- **134.** 어드민 확장 자리. `CmsProvider`의 `slots`에 자리마다 화면 조각을 돌려주는 함수를 넣는다. 0.8.0에 `assetAlt`(미디어 정보 패널의 대체 텍스트 칸 옆)가 먼저 들어갔고, 여기서 나머지를 넣는다.

  | 자리 | 위치 | 넘겨주는 값 |
  |---|---|---|
  | `editorHeader` | 편집기 머리글의 버튼 줄 끝 | 컬렉션, 문서, `getContent()`, `setField(path, value)`, `refresh()` |
  | `editorPanel` | 편집기 오른쪽 패널 (폭은 자리를 쓰는 쪽이 정함, 휴대폰에서는 전체 화면) | 위와 같음, `open`, `onClose` |
  | `fieldAction` | 필드 이름 옆 | 필드 이름, 지금 값, `setValue(value)` |
  | `localeAction` | 다국어 화면의 배너 (묶음 4에서 추가) | 원문, 대상 언어, `refresh()` |

  - 자리가 비어 있으면 아무것도 그리지 않고 화면 구성이 지금과 같다.
  - `setField`와 `setValue`는 칸을 채울 뿐이다. 사람이 저장해야 버전이 된다.
  - `refresh()`는 서버의 새 버전을 다시 읽는다. 저장하지 않은 수정이 있으면 0.6.0의 병합 화면이 뜬다.
  - 자리에 들어간 조각이 오류를 내도 편집기는 죽지 않는다 (자리마다 오류 경계).
  - 왜 필요한가: 모델을 부르는 기능(채팅 에이전트, AI 보조 같은 것)은 이 패키지에 넣지 않기로 했다. 그런 기능을 만드는 확장 패키지나 앱이 어드민 부품을 복사해 고치지 않고도 버튼과 패널을 붙일 수 있어야 한다.
- **80.** `createCms({ onEvent(e) })`로 요청(경로, 누가, 상태 코드, 걸린 시간), 검색, 색인 빌드, 작업 실행, 훅 실패를 내보낸다. OpenTelemetry로 잇는 예제를 넣는다.

## 운영과 성능 (0.12.2)

| 번호 | 무엇 | 어떻게 |
|---|---|---|
| 18 | 키 사용량 제한 | 키마다 분당 요청 수. 넘으면 429와 `Retry-After`. 기본은 메모리에서 세고, 서버가 여러 대면 `rateLimit.store`에 Redis 같은 저장소를 준다. IP 허용 목록 |
| 81 | 보존 정책 | `retention: { hitsDays, auditDays, revokedKeysDays, deliveriesDays }`. `purgeActor(id)`, `exportActor(id)`. CLI `agent-cms retention --dry-run`. 작업 실행기가 매일 돈다 |
| 83 | 키 회전 | `rotateKey(id, { graceMinutes })`로 새 키를 내고 옛 키를 잠시 함께 받는다. 폐기 이유, 마지막 사용 IP(선택) |
| 73 | 렌더러 XSS 계약 | 화면은 블록 트리만 받아 요소로 그린다. HTML 문자열을 받는 길을 두지 않는다. 대소문자, 공백, 중첩 링크, `data:` 주소를 담은 적대적 픽스처 테스트 |
| 21 | 멀티 테넌트 | 모든 표에 `tenant` 열. `createCms({ tenant: (req) => id })`. 한 앱 안의 워크스페이스마다 문서 세트가 따로다. 미디어는 저장소의 `prefix`를 테넌트마다 나눈다 |
| 75 | 프로세스 간 무효화 | `cms_change_log(seq)`와 `LISTEN/NOTIFY`로 바로 알리고, 지금의 조회는 안전망으로 둔다 |
| 76 | 게시본 읽기 캐시 | `CacheAdapter`(메모리, Redis, Next의 캐시). 키에 게시 버전을 넣는다 |
| 77 | 페이지네이션 (남은 부분) | 감사 로그, 버전, 댓글, 전송 기록, 휴지통 전부 `limit`과 `cursor` |
| 78 | 인덱스와 N+1 | 목록과 색인 빌드의 일괄 조회, 빠진 인덱스 |
| 82 | `doctor` (남은 부분) | 인덱스, 게시 버전 정합성, 고아 행(사용처, 댓글, 릴리스 항목), 실패한 작업. 복구 절차 문서 |
| 90 | 드라이버 | neon-http처럼 트랜잭션이 없는 드라이버는 `db.batch`로. postgres.js, node-postgres, pglite, Neon용 팩토리 |
| 104 | Edge 런타임 | `node:crypto`를 `crypto.subtle`로. `doctor --runtime=edge`. 이미지 모듈과 단독 서버는 Node 전용이라고 적는다 |
| 106 | `agent-cms bench` | 검색 p95, 색인 빌드, 문서 1만 개 목록을 CI에서 재고 나빠지면 알린다 |
| 127 | 앱용 실시간 변경 알림 | `GET /_events`(SSE). 앱이 문서 변경을 구독해 화면을 새로 고친다. 75번 위에 얹는다. 서버리스에서는 연결이 짧게 끊기므로 마지막 순번부터 이어 받는다 |

## 정해 둔 기본값

| 항목 | 값 | 이유 |
|---|---|---|
| 크론 진입점의 인증 | `Authorization: Bearer <cronSecret>` | Vercel 크론의 형식. 다른 호스팅도 헤더 하나면 된다 |
| 웹훅 재시도 | 5번 (1분, 5분, 30분, 2시간, 12시간) | 하루 안에 포기한다 |
| 웹훅 자동 끄기 | 연속 20번 실패 | 죽은 주소에 계속 보내지 않게 |
| 웹훅에 본문을 넣는가 | 넣지 않는다 | 비공개 컬렉션의 내용이 밖으로 나가지 않게. 받는 쪽이 키로 읽는다 |
| 웹훅과 자동화를 에이전트 도구로 내는가 | 내지 않는다 | 데이터를 밖으로 보내는 길을 에이전트가 스스로 만들지 못하게 |
| 자동화의 연쇄 실행 | 깊이 1 | 무한 반복을 막는 가장 단순한 규칙 |
| 대시보드 위젯 배치 | 고정 | 범위를 줄인다. 앱이 카드를 덧붙일 수는 있다 |
| 가져오기에서 같은 주소 | 새 버전으로 저장 | 기존 내용이 사라지지 않는다 |
| 가져온 문서의 상태 | 초안 | 확인 없이 공개되지 않게 |
| 사람의 삭제 권한 | 게시와 따로 | 시안 4번의 표. 키는 지금 규칙 그대로 |
| 단독 서버의 가입 | 없음 (초대만) | 공개된 가입은 CMS에 위험하다 |
| SSO | OIDC 먼저, SAML은 나중 | 대부분의 회사 로그인이 OIDC를 지원한다 |
| 비밀번호 해시 | scrypt | Node에 들어 있어 의존성이 없다 |

## 시안에 없는 화면

| 화면 | 따르는 것 | 문구 (제안) |
|---|---|---|
| 웹훅 만들기와 수정 창 | 지금 있는 API 키 만들기 창 | 입력 "이름", "주소", "이벤트", "컬렉션", 버튼 "취소", "만들기" |
| 자동화 목록 | publish-flow 7번 릴리스 목록 | 열 "이름", "언제", "상태", "마지막 실행", 버튼 "새 자동화" |
| 단계 고르기 메뉴 | content-model 6번의 블록 추가 메뉴 | 위 표의 이름 그대로 |
| 내보내기 탭 | 시안 5번 가져오기 탭 | 입력 "컬렉션", 스위치 "파일 포함", "초안 포함", 버튼 "내보내기" |
| 사용자 관리 (단독 서버) | 시안 4번 역할 | 메뉴 "사용자", 열 "이름", "이메일", "역할", "마지막 로그인", 버튼 "초대" |
| 초대 수락과 비밀번호 설정 | 시안 6번 로그인 | 입력 "이름", "비밀번호", 버튼 "시작하기" |
| 키의 사용량 제한 입력 | 지금 있는 API 키 만들기 창에 입력 하나 | "분당 요청 수" |

## 끝났다고 보는 기준

- `/_cron`을 올바른 비밀값으로 부르면 때가 된 작업이 실행되고, 틀린 값이면 401이다. 두 곳에서 동시에 불러도 작업은 한 번만 실행된다
- 문서를 게시하면 등록한 주소로 서명된 요청이 가고, `verifyWebhook`으로 확인된다. 받는 쪽이 500을 주면 정한 간격으로 다시 간다 (시계를 돌려 테스트)
- 시안 3번의 자동화를 화면에서 만들고 News 글을 게시하면 실행 기록에 "성공"이 남는다. 분류가 다른 글은 "건너뜀"이다
- 대시보드의 숫자가 목록의 탭 숫자와 같다
- `openapi.json`으로 만든 Python 클라이언트가 문서를 읽고 쓴다
- 내보낸 폴더를 빈 DB에 가져오면 문서 수, 본문, 이미지 연결이 같다. `--dry-run`은 아무것도 바꾸지 않는다
- Hono와 Express 예제가 CI에서 뜨고 `/_me`가 답한다
- 작성자 역할의 사람은 쓰기는 되고 게시는 `forbidden_publish`다. 역할이 없는 앱은 이전 버전의 테스트가 그대로 통과한다
- `agent-cms dev`가 DB 없이 뜨고, Docker 예제로 로그인부터 게시까지 된다
- OIDC 로그인이 시험용 공급자(CI에서 띄우는 가짜 서버)로 통과한다
- 실제 화면을 시안 6개와 같은 크기로 찍어 비교한다
