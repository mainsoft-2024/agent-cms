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

## 구현 결과 (0.12.0, 1차)

묶음 3의 첫 배포분이다. 나머지 항목은 0.12.x에서 이어 간다.

| 항목 | 상태 | 계획과 다른 점 |
|---|---|---|
| 126 작업 실행기 | 만듦 | `cms_jobs` 표, `cms.jobs`, `/_cron`이 작업까지 실행(호출당 약 20초, 5개씩), `agent-cms cron [--watch]`, doctor 경고. dev 서버가 1분마다 스스로 실행하는 것은 넣지 않고 `cron --watch`로 대신했다. 예약 게시와 휴지통 비우기는 작업 표로 옮기지 않고 cron 호출 안에서 전처럼 직접 실행한다 |
| 20 웹훅 | 만듦 | 이벤트가 계획의 10개보다 많은 15개다(`doc.created`, `doc.updated`, `doc.archived`, `doc.restored`, `asset.moved`, `comment.created` 추가). 화면은 시안 2번의 목록과 전송 기록을 한 화면(목록 + 옆 패널)으로 만들었다 |
| secretsKey | 만듦 | AES-256-GCM, `createSealer` |
| 93 훅 | 일부 | `beforeChange`, `beforePublish`, `beforeDelete`를 만들었다. `beforeValidate`, `beforeRead`, `afterRead`, 필드 단위 훅은 아직. `afterPublish`와 `afterDelete`는 이벤트(`ctx.on`)로 받는다 |
| 92 플러그인 | 일부 | `definePlugin`: 이벤트, 라우트, 도구, 작업, `_me`, 메뉴, 암호화. 플러그인의 표는 `cms.plugins.sql`로 모으기만 하고 `migrate`가 실행하지는 않는다. 컬렉션 확장은 아직 |
| 134 어드민 확장 자리 | 일부 | 사이드바 메뉴(`ctx.nav`)와 `_me.plugins`만. 편집기 머리글, 옆 패널, 필드 옆 자리는 아직 |
| 80 onEvent | 일부 | 요청, 이벤트, 작업, cron, 오류. 검색과 색인 지표는 아직 |

시안에 없던 문구: "정상", "실패 {n}", "꺼짐", "시험 전송", "서명 키", "보기", "전송 기록", "다시 보내기", "켜기", "자동으로 꺼졌어요: {이유}", "아무것도 고르지 않으면 모든 이벤트예요.", "대기열에 넣었어요. 다음 cron 호출 때 나가요."

확인하지 못한 것: 실제 Slack이나 Vercel 재검증 주소로 보내는 것(예제 앱의 수신 경로와 가짜 주소로만 확인), 운영 DB에서 수천 개 작업이 쌓였을 때의 속도, Edge 런타임에서 `verifyWebhook` 실행(Node와 브라우저 공용 API만 쓰는 것은 빌드 결과로 확인).

## 구현 결과 (0.13.0, 2차, 2026-11-21)

PR #24. 스키마 7. 검증: 단위 166개(159 통과, 7은 실제 저장소가 필요해 건너뜀), DB 9개(스키마 6 → 7 포함), 화면 58개, 예제 앱 브라우저 테스트, docs 앱 브라우저 테스트. 실제 화면 스크린샷 9장.

| 번호 | 상태 | 만든 것과 계획과 다른 점 |
|---|---|---|
| 120 자동화 | 만듦 | `src/automations.ts`, 화면 `cms-automations`. 트리거 9개, 조건 5종, 동작 5종(웹훅, 검색어, 필드, 릴리스, 앱 함수). 다음 cron 호출 때 실행, 자동화가 만든 변경은 다른 자동화를 깨우지 않는다. 시험 실행은 아무것도 바꾸지 않는다. 화면에서 만든 것은 꺼진 채로 시작한다. 에이전트 도구는 만들지 않았다(관리자만) |
| 113 역할 | 만듦 | `src/roles.ts`, 화면 `cms-roles`. 컬렉션별 쓰기·게시·삭제, 관리자 역할, 사람 찾기(`createCms({ users })`). 코드의 `access`가 먼저다. 이름은 한 번만(`name_taken`). 미디어 권한과 필드 단위 권한은 아직 |
| 121 대시보드 | 만듦 | `src/stats.ts`, `GET /_stats`, 화면 `cms-dashboard`. 카드 4개, 변경 막대(사람, 에이전트), 많이 읽은 문서, 최근 활동. 위젯을 고르거나 옮기는 기능은 없다 |
| 26·105·79 내보내기와 가져오기 | 만듦 | `src/transfer.ts`, `GET /export`, `POST /import`, CLI `export`·`import`·`put <collection> <dir>`, 화면 `cms-transfer`. 미리 보기, 충돌 정책 3개, 초안으로 저장. `export --with-files`와 `import`가 파일도 옮기고 `asset:` 주소를 새 id로 바꾼다. 화면은 .json 묶음과 .md만 받는다(zip은 아직) |
| 131 다른 곳에서 가져오기 | 일부 | `src/import-sources.ts`: JSON, CSV, WordPress(WXR). HTML → 마크다운 변환기를 DOM 없이 만들었다. Notion, Contentful, Strapi는 아직. WordPress 글 안의 그림은 옛 주소를 그대로 가리킨다 |
| 95 OpenAPI | 만듦 | `src/openapi.ts`, `GET /openapi.json`, CLI `openapi`. 읽을 수 있는 컬렉션마다 타입이 있는 스키마. 문서의 모든 경로를 실제 핸들러에 보내 보고, 핸들러가 아는 첫 경로 조각이 문서에 다 있는지도 보는 테스트 |
| 27 어댑터 | 일부 | `./adapters/node`(Express, Fastify, Koa, node:http). 웹 `Request`를 쓰는 프레임워크는 어댑터가 필요 없다고 문서에 적음. 프레임워크별 예제 앱과 CI는 아직 |

정해 둔 기본값 (묻지 않고 정함):

- 자동화 실행 기록은 30일. 역할은 15초마다 다시 읽는다. 대시보드 기간은 7, 14, 30일이고 기본 14일.
- 가져오기는 요청 하나에 파일 2000개, CLI는 100개씩. 충돌 기본값은 `file-wins`.
- 같은 이름·크기·폴더의 파일이 받는 쪽에 있으면 다시 올리지 않고 그 파일을 쓴다.
- 영어 글자가 없는 제목(한글)의 주소는 `doc-1`처럼 붙인다.
- Node 어댑터의 본문 상한은 8MB.

알려진 약점 (고치지 않은 것):

- 대시보드의 "최근 활동"이 문서의 첫 버전(만들기)도 "수정"이라고 적는다.
- 자동화 화면의 "시험 실행" 상자가 일정(매일, 매주) 트리거에서도 보인다.
- 역할과 자동화 화면에서 "새로 만들기"를 누르고 서버가 답하기 전의 짧은 순간에 입력한 글자는 사라진다.

확인하지 못한 것: 실제 WordPress 사이트에서 받은 큰 내보내기 파일(테스트는 손으로 만든 WXR), 수천 개 문서의 내보내기 속도, Fastify와 Koa에서의 실제 실행(Express식 `originalUrl`과 본문 파서는 node:http 테스트로만 확인).

## 구현 결과 (0.14.0, 3차, 2026-11-21)

스키마는 그대로 7. 키에 붙는 값(제한, 허용 주소, 폐기 이유, 교체한 키)은 `cms_records`의 `key_meta` 레코드에 둔다.

| 번호 | 상태 | 만든 것과 계획과 다른 점 |
|---|---|---|
| 18 요청 제한, IP 허용 목록 | 만듦 | `src/limits.ts`. 키별·주소별 분당 한도(고정 1분 구간), 429 `rate_limited`와 `Retry-After`, 키마다 다른 한도, 허용 주소(IPv4·IPv6 범위, 50개까지). 횟수는 프로세스 메모리, 함께 쓰려면 `rateLimit.store`. 로그인한 사람은 세지 않는다. 한도를 넘은 요청의 감사 로그와 대시보드 표시는 없다 |
| 83 키 교체 | 만듦 | `cms.rotateKey`, `POST /keys/:id/rotate`, 키 화면의 "교체". 유예 시간 기본 60분(0~7일). 폐기 이유 저장. 만료가 가까운 키 알림은 아직 |
| 81 보존 규칙 | 만듦 | `src/retention.ts`. 감사 로그, 조회 수, 폐기된 키, 웹훅 전송 기록. cron이 하루 한 번, `POST /retention { dryRun }`, CLI `retention --dry-run`. 댓글과 presence의 보존 규칙, 화면은 아직 |
| 93 훅의 나머지 | 일부 | `beforeValidate`, `afterPublish`, `afterDelete`, `afterRead`(문서 하나를 읽을 때만). 필드 단위 훅과 목록·검색의 `afterRead`는 아직 |
| 127 이벤트 스트림 | 만듦 | `src/events.ts`, `GET /_events`(SSE), `cms.subscribe`. 다시 연결하면 `resync` 한 번. 프로세스 하나가 자기 이벤트만 흘려보낸다: 여러 서버 사이의 전달(LISTEN/NOTIFY, 75번)은 아직 |

정해 둔 기본값: 요청 제한과 보존 규칙은 설정하기 전에는 꺼져 있다. 키 메타는 30초마다 다시 읽는다(다른 서버에서 바꾼 한도가 반영되는 데 걸리는 시간). `resync`는 문서 200개까지.

확인하지 못한 것: 서버 여러 대에서의 요청 제한(공유 저장소 예시는 문서에만 있고 Redis로 돌려 보지 않음), Vercel 같은 서버리스에서 이벤트 스트림이 실제로 얼마나 오래 유지되는지, 운영 규모의 감사 로그에서 보존 실행에 걸리는 시간.

## 묶음 3에서 아직 안 한 것

다음 버전에서 이어서 한다. 순서는 위 번호 순서를 따른다.

- 101·115 단독 서버(`serve`, `dev`)와 122 자체 로그인·OIDC
- 73의 나머지, 21 여러 사이트(테넌트). 18·81·83은 0.14.0에서 만듦 (남은 것: 한도 초과의 대시보드 표시, 만료가 가까운 키 알림, 댓글·presence 보존)
- 75 변경 로그와 LISTEN, 76 읽기 캐시, 77 페이지 나누기의 나머지, 78 색인, 82 doctor의 나머지, 90 드라이버, 104 Edge, 106 벤치마크. 127 이벤트 스트림은 0.14.0에서 만듦 (여러 서버 사이 전달은 75번과 함께)
- 93의 나머지 훅(필드 단위, 목록과 검색의 `afterRead`, `beforeRead`), 92의 플러그인 표를 `migrate`가 실행하기, 134의 편집기 안 확장 자리, 80의 검색·색인 지표
- 131의 나머지(Notion, Contentful, Strapi), 화면의 zip 가져오기, 프레임워크별 예제 앱(Hono, Express)과 CI, 다른 언어 클라이언트 예제
- 113의 나머지(미디어 권한, 필드 단위 권한), 자동화의 에이전트 도구

## 0.16.0 진행 상황 (2026-11-22, 브랜치 `agents/auth-016`)

계획: `.slash/workspace/plans/c-rest-standalone-auth.plan.md`, 시안 `standalone-auth` v1(승인됨).

한 것 (122 자체 로그인, 서버 쪽):
- `@mainsoft/agent-cms/auth`의 `createAuth`, `createCmsHandler({ cms, auth })`. 스키마 변경 없음(`cms_records`: auth_user, auth_session, auth_passkey, auth_token, auth_policy, auth_fails).
- 비밀번호: scrypt N=2^17 r=8 p=1, 파라미터를 해시에 기록하고 약하면 다음 로그인 때 다시 해시. 12자 이상, 흔한 비밀번호 1만 개·이메일 이름·연속 글자 거절. 없는 계정도 같은 시간.
- 패스키: 라이브러리 없이 WebAuthn(CBOR, COSE, ES256/EdDSA/RS256, 출처·챌린지·rpId·카운터 확인). 소프트웨어 인증기로 테스트.
- 2단계: TOTP(RFC 6238 벡터로 확인, 같은 코드 재사용 거절), 자체 QR 인코더(독립 디코더 jsqr로 확인), 복구 코드 10개, 30일 기기 신뢰.
- SSO: OIDC 코드 흐름 + PKCE, state·nonce, 디스커버리·JWKS 캐시와 키 교체 대응, 도메인 제한, 초대된 사람만 또는 자동 생성, 기본 역할.
- 첫 관리자 설정 코드(로그에 출력, 15분), 초대(7일, 역할·관리자), 재설정(1시간, 계정 유무 숨김), 세션 30일·최대 90일·`__Host-` 쿠키, 기기 목록·원격 로그아웃, 10분 본인 확인(키 만들기·교체, 2단계 끄기, 패스키 삭제, 사람 끄기·관리자 지정), `requireMfa` 정책, 로그인 잠금(이메일 15분/10회, 주소 15분/50회), 로그인 CSRF 거절, 감사 로그 `auth.*`.
- REST `/auth/*`, `/users/*`(OpenAPI 목록 포함), `_me.auth`, 역할 화면의 사람 찾기 연결.
- 테스트 `src/auth.test.ts` 12개.

화면과 단독 서버 (같은 0.16.0, 2026-11-22 오후):
- 화면: `cms-login`(로그인·첫 설정·2단계·복구 코드·초대 수락·재설정), `cms-people`(초대 칩 입력, 시작 역할, 메일/링크, 다시 보내기·새 링크·취소, 로그인 방법 표시, 계정 끄기, 관리자 지정, 모두 2단계 정책), `cms-account`(이름, 테마, 언어, 패스키 추가·이름·삭제, 비밀번호와 강도, 인증 앱 QR·복구 코드 받기, 기기 목록과 로그아웃), `cms-auth-kit`(패스키 브라우저 처리, 본인 확인 창, 비밀번호 칸), 셸 계정 메뉴와 어두운 테마(밝게·어둡게·시스템), 로그인 풀림 화면.
- 단독 서버: `npx @mainsoft/agent-cms dev`(설정 없이, PGlite 있으면 `.agent-cms/dev`에 보관), `serve`(설정의 `server`), `@mainsoft/agent-cms/serve`의 `startServer`, 미리 빌드한 어드민 `dist/admin`(scripts/build-admin.mjs, esbuild + tailwind), CSP(인라인 스크립트는 해시 하나), `/healthz`, 1분 예약 작업, SIGTERM 정리, `examples/server`(Dockerfile, compose: CMS+Postgres+MinIO).
- 역할의 사람: ID 입력 없앰. 이름·이메일 검색(앱 users + 자체 로그인 + 어드민을 쓴 사람 기록 `person`), 처음 보는 이메일은 대기 멤버로 넣고 첫 로그인 때 합류.
- 전체 화면 레이아웃 검사 `e2e/layout.spec.ts`(17개 화면 × 4개 폭, 긴 이름, 열리는 대화상자까지) 통과. 리뷰 결과와 반영 현황: `docs/roadmap/review-ui-2026-11-22.md`.
- 실제 브라우저 `e2e/standalone.spec.ts`(설정 코드, 인증 앱 2단계, Chrome 가상 인증기로 패스키 등록·로그인, 초대 링크 수락과 한 번만 쓰기, 어두운 테마) 5개 통과.

아직 안 한 것:
- CLI `user create`, 메일 보내기 예제(Resend 등), 실제 OIDC 공급자(Google 등)로 확인.
- 리뷰의 [남음] 항목(`docs/roadmap/review-ui-2026-11-22.md`).
- 0.17.0: 75, 76, 77, 78, 82, 90, 104, 106, 21, 73, 93/92/134/80 나머지, 113, 131(Notion, zip), 27.

## 구현 결과 (0.17.0, 묶음 3 마무리, 2026-11-22)

| 번호 | 결과 |
|---|---|
| 75 변경 로그 | `cms_changes`(스키마 9). 이벤트마다 번호. 듣는 쪽이 있으면 2초 폴링, `ChangeSignal`(pg LISTEN/NOTIFY, postgres.js)로 즉시. `/_events`는 번호로 이어 받기, `GET /_changes` 폴링. 7일 보관 |
| 76 읽기 캐시 | `cache`(`memoryCache` 또는 get/set 저장소). 컬렉션 세대 키로 무효화. `access.read`가 있는 컬렉션은 캐시 안 함 |
| 77 페이지 | `pageDocs` keyset 커서 `k.…`, 예전 숫자 커서 호환. 휴지통·댓글·버전에 limit/cursor |
| 78 색인 | 색인 11개, 일괄 조회(사용처, 릴리스, resync) |
| 82 doctor | 색인, 게시 버전 행, 고아 행 검사와 `--fix` |
| 90 드라이버 | `./db` connectPostgres(pg, postgres.js, neon WebSocket/HTTP, pglite), 트랜잭션 없는 드라이버 |
| 104 Edge | `./crypto`(SHA-256, HMAC, base64url), secrets 지연 로드, DoH. Edge 런타임 테스트 |
| 106 bench | `npm run bench` |
| 21 여러 사이트 | `./tenants` 사이트마다 스키마 |
| 73 XSS 계약 | 적대적 픽스처 테스트, `/\host` 링크 버그 수정 |
| 93·92·134·80 | `beforeRead`, 목록 `afterRead`, 필드 훅, `config.plugins` migrate, 편집기 확장 자리 3개, `/metrics`·`createMetrics` |
| 113 | 미디어 저장소 역할 권한, `fieldAccess`(화면은 읽기 전용 표시) |
| 131 | Notion(CLI는 그림까지), 어드민 zip |
| 27 | Hono·Express 예제와 CI |
| 로그인 | `user create`, `user reset-link` |

남은 것(묶음 밖으로 넘김): 목록 본문 제외(77), 복구 절차 문서(82), `doctor --runtime=edge`(104), bench의 CI 회귀 감시(106), Contentful·Strapi 가져오기(131), Remix 예제와 다른 언어 클라이언트(27), 실제 Google·Okta로 SSO 확인, 어드민 zip 가져오기의 Notion 그림(지금은 CLI만).

## 플러그인 v2 (2026-11-24 계획, 0.22.2 → 0.23.0 → 0.24.0) — 끝남

세 버전 모두 냈다(2026-11-24). 남은 한계는 CHANGELOG 0.23.0의 "Known limits"(설정 저장이 다른 인스턴스로 퍼지지 않음, 권한 규칙은 동기, `render.html` 필터 없음)와 Vue·Svelte 판(116).

92번과 134번은 0.12.0~0.17.0에서 "일부"로 끝났다: `ctx.automationAction`은 주석에만 있었고, 플러그인이 컬렉션 훅·컬렉션·필드를 붙일 수 없었고, "웹훅과 자동화를 플러그인으로 만들어 계약이 충분한지 확인"은 하지 않았다. 모델을 부르는 기능(G)이 이 계약 위에 올라가므로 v2로 끝까지 만든다. 목표는 Payload, Strapi, Sanity와 같거나 나은 수준. 뼈대는 Strapi식(등록 → 비동기 시작 → 종료, 서버와 어드민 진입점이 따로)에 WordPress식 필터와 Sanity식 자리 합치기를 더한다.

| 버전 | 무엇 |
|---|---|
| 0.22.2 | 자동화의 "웹훅 보내기" 고침(그 자리에서 웹훅 만들기, `events: ["automation"]`, 웹훅이 꺼진 서버 안내), 어드민 기본 폰트(Wanted Sans + Geist Mono, `init`이 `cms-fonts.css`) |
| 0.23.0 | 서버 쪽: 옵션(zod)·`engine`·`requires`·`required`, 비동기 `start`/`stop`과 `cms.close()`, 시작 실패 격리(그 플러그인과 기대는 것만 끔), 자리(`hook`, `collection`, `field`, `automationAction`, `filter` 6곳, 좁히기만 하는 `access`, `store`, 어드민에서 바꾸는 `settings`, `log`), `cms.plugins.list()`와 `GET /plugins`·다시 시작·설정 API, 웹훅·자동화를 내장 플러그인으로 옮기기(`builtins`로 끔). 92·134의 계약 검증이 여기서 끝난다 |
| 0.24.0 | 어드민 짝: `@mainsoft/agent-cms/admin`(프레임워크 무관 코어)과 `/react`(`defineAdminPlugin`), 자리 합치기, `add cms-plugin-page`의 catch-all 페이지, 플러그인 목록·설정·다시 시작 화면(`cms-plugins`), 작성자 도구(`@mainsoft/agent-cms/testing`의 `createTestCms`, `plugin init`, `examples/plugins/`) |

필터 이름: `render.html`, `sitemap.entries`, `rest.doc`, `mcp.result`, `export.file`, `mail.message`. 하지 않는 것: 플러그인 마켓, 어드민에서 설치, 넓히는 권한 규칙, Payload식 `config => config`.

**프레임워크 무관**: 서버는 웹 표준 `Request → Response`라 어디에나 붙는다(예제와 CI는 27번). 어드민은 0.24.0에서 프레임워크와 무관한 코어(`/admin`)와 React 판으로 나눈다. Vue·Svelte 판은 116번(묶음 6)에서 그 코어 위에 얹는다. 비유는 Auth.js의 `@auth/core`, TanStack Query의 `query-core`. (2026-11-24 사용자 결정: 0.24.0에서는 코어와 React만 나눈다. 0.24.0에서 그렇게 냈다.)
