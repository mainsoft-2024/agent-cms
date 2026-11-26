# 묶음 6: 오픈소스 공개 준비 (1.0.0)

누구나 설치하고, 믿고 쓰고, 고쳐서 보낼 수 있게 한다. 사용자는 당분간 지금처럼(GitHub Packages) 쓰겠다고 했으므로 맨 마지막 묶음이다. 어드민 화면이 아니라서 시안이 없다.

`TODO.md` 번호 (구현 순서): 117, 28, 103, 102, 91, 94, 96, 98, 99. 116은 1.0 뒤로 옮겼다(아래 116 절).

## 지금 상태 (2026-11-19에 확인)

- 저장소는 공개, MIT 라이선스. 패키지는 GitHub Packages에만 있어 설치하려면 토큰이 필요하다.
- README(영어), CHANGELOG, `UPGRADE-0.6.md`, `TODO.md`(한국어)가 있다.
- CONTRIBUTING, 행동 강령, 보안 신고 안내, 이슈와 PR 템플릿이 없다.
- CI는 단위 테스트, DB 매트릭스(pglite, Postgres 16), 패키지 설치 테스트를 돌린다.

## 117. 공개 npm 배포와 커뮤니티 문서

**배포.**

- 공개 npm에 낸다. 이름 후보: `agent-cms`, 안 되면 스코프(`@agent-cms/core`). **이름이 비어 있는지는 확인하지 않았다.** 시작할 때 먼저 확인하고, 이름이 정해지면 README와 예제의 설치 문구를 한 번에 바꾼다.
- GitHub Packages에도 당분간 함께 낸다 (지금 쓰는 앱이 끊기지 않게). `UPGRADE-1.0.md`에 옮기는 법을 적는다.
- npm provenance(어느 커밋과 워크플로에서 만들어졌는지 증명)를 켠다.
- 복사형 레지스트리의 주소를 공개 주소로 낸다 (`npx shadcn add <주소>/cms-shell.json`이 토큰 없이 되게).

**문서.**

| 파일 | 내용 |
|---|---|
| `CONTRIBUTING.md` | 개발 환경, 테스트 돌리는 법, 커밋 규칙(Conventional Commits), PR 올리는 법, 화면 변경에는 스크린샷 |
| `CODE_OF_CONDUCT.md` | Contributor Covenant |
| `SECURITY.md` | 취약점 신고하는 곳(GitHub의 비공개 신고), 지원하는 버전, 답하는 기한 |
| `.github/ISSUE_TEMPLATE/` | 버그, 기능 제안, 질문 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 무엇을 왜, 테스트, 스크린샷 |
| `ROADMAP.md` (영어) | 이 폴더의 문서를 영어로 요약. `TODO.md`와 `docs/roadmap/`은 한국어로 남긴다 |
| `GOVERNANCE.md` | 누가 결정하고 누가 머지하는지 (지금은 한 팀) |

**1.0의 약속.** 1.0부터 semver를 지킨다: 공개 API(패키지의 `exports`), REST 경로, 도구 이름과 입력, 테이블 구조의 호환을 깨는 변경은 메이저에서만 한다. 무엇이 공개 API인지를 README에 목록으로 적는다.

## 28. 문서 사이트

- 이 CMS로 만든다 (자기 제품을 자기가 쓴다). `examples/docs-site` 또는 별도 폴더에 Next 앱 하나.
- 내용: 시작하기, 개념(컬렉션, 버전, 권한, 에이전트), 기능별 안내(미디어, 게시 흐름, 연동, 모델, 검색), API 참조(OpenAPI에서 생성, 95번), 도구 참조(`tools.ts`에서 생성), 레시피(54번), 업그레이드 안내.
- 영어가 기본, 한국어는 다국어(5번)로.
- `llms.txt`(55번)를 낸다.
- 어디에 올릴지는 정하지 않았다. Vercel이 연결돼 있으므로 기본은 Vercel이고, 시작할 때 확인한다.

## 103. 에이전트용 라이브러리 문서

코딩 에이전트에게 "agent-cms로 어드민 붙여 줘"라고 하는 것이 첫 사용 경로가 되게 한다.

- 문서 사이트의 `llms.txt`와 `llms-full.txt` (55번의 기능을 자기 문서에 쓴다)
- MCP 리소스 `cms://docs/*`: 패키지에 든 문서를 MCP로 읽는다. 설치한 버전의 문서가 나온다
- subpath마다 TypeDoc으로 만든 API 참조
- `agent-cms init`(0.6.0)이 만드는 파일과 문서의 "시작하기"가 어긋나지 않는지 CI에서 확인한다 (문서의 명령을 깨끗한 폴더에서 그대로 실행)

## 102. 호환성 매트릭스

CI에서 조합을 돌린다: Node 20/22/24, Next 14/15/16, React 18/19, zod 3/4, drizzle-orm의 지원 범위 양끝, Postgres 14~17. 결과 표를 README와 문서 사이트에 자동으로 넣는다. 깨지는 조합은 고치거나 "지원하지 않음"으로 적는다.

**확인하지 못한 것.** 위 버전 번호는 2026-11 기준으로 다시 확인해야 한다. 시작할 때 각 패키지의 최신 메이저를 조회해서 표를 정한다.

## 91. 테스트 도우미

`@.../testing`: `createTestCms({ collections })`가 메모리 저장소와 메모리 미디어 저장소로 CMS를 만든다. 가짜 시계, 가짜 사용자와 키, 정해진 답을 돌려주는 가짜 검색 순위 함수(135번). 앱이 자기 훅과 권한 함수를 DB 없이 테스트한다. 이 저장소의 테스트도 이것을 쓴다.

## 94, 96. 타입이 붙은 클라이언트

- **96.** `agent-cms types`가 `.agent-cms/types.d.ts`를 만든다 (컬렉션 유니온, `Fields<"guide">`, `LinkKey`). `--check`로 CI에서 낡았는지 잡는다. 0.6.0의 `Cms<C>` 타입(84번)으로 충분한 앱도 많으므로, 이 명령은 설정 파일을 직접 가져올 수 없는 곳(프런트엔드가 다른 저장소에 있는 경우)을 위한 것이다.
- **94.** `createCmsClient()`: `client.guide.update(slug, doc, { expectedVersion })`. TanStack Query 훅 `useDoc`, `useUpdateDoc`(409면 다시 불러온다)을 `./react-query`로 낸다.

## 98. 업그레이드 규율

- changesets로 버전과 CHANGELOG를 만든다. PR마다 변경 기록 한 줄을 요구하고(CI가 검사), main에 머지되면 릴리스 PR이 생기고, 그것을 머지하면 npm과 GitHub Packages에 나간다.
- `@next` 프리릴리스.
- `agent-cms codemod v0.x`(ts-morph): 버전 사이에 바뀐 설정과 API를 앱 코드에서 자동으로 고친다. 0.8.0부터 이 로드맵이 만드는 호환을 깨는 변경마다 codemod를 하나씩 쌓아 둔다.
- 없앨 API는 한 번만 경고하고 다음 메이저에서 없앤다.

## 99. 공개 렌더링 킷 (Next)

`@.../next`: `TODO.md` 99번의 것(`generateDocParams`, 태그 캐시 `cms:guide:slug`, `revalidateDoc`, sitemap, RSS, OG 이미지)에, 지금 예제 앱에 손으로 적혀 있는 것과 이 로드맵에서 생긴 것을 더한다.

- `createCmsRoute(cms, { resolveUser })`가 `app/api/cms/[...path]/route.ts`의 내용 전부를 준다
- 미리보기 모드(`draftMode`)와 서명된 미리보기 링크의 연결
- 리다이렉트 미들웨어 (39, 125번)
- `generateMetadata`용 `seoMetadata(doc)` (124번), `sitemap.ts`, `llms.txt` 경로 (55번)
- `next/image`의 로더와 `remotePatterns` 도우미 (0.8.0의 `imageUrl` 확장 지점)

## 116. 다른 화면 프레임워크의 어드민 (1.0 뒤)

**시기.** 2026-11-26 사용자 결정: 1.0은 React 어드민만으로 내고, 이 항목은 1.0 뒤에 한다. 이 묶음의 기준에서도 뺐다. 0.24.0에서 어드민 코어(`@mainsoft/agent-cms/admin`)와 React 판(`/react`)을 이미 나눠 두어, 아래 1단계의 상당 부분은 끝나 있다.

**무엇을, 왜.** 사용자가 Vue와 Svelte용 어드민을 골랐다. 가장 큰 일이라 맨 뒤에 둔다.

**어떻게.**

1. **먼저 논리를 화면에서 떼어 낸다.** 지금 `registry/cms/use-cms.ts`와 각 부품 안에 React 훅으로 섞여 있는 것(불러오기, 자동 저장, 충돌 병합, 올리기, 권한에 따른 버튼 표시)을 프레임워크와 무관한 `@.../admin-core`(상태 기계와 함수)로 옮긴다. React 부품은 이것을 쓰도록 고친다. 화면은 한 픽셀도 바뀌지 않아야 한다 (스크린샷 비교로 확인).
2. **Vue**: shadcn-vue 위에 같은 부품을 만든다. 레지스트리 `registry/vue`.
3. **Svelte**: shadcn-svelte 위에. `registry/svelte`.
4. 문구는 같은 `cms-messages.ts`를 쓴다.
5. 브라우저 테스트(Playwright)를 프레임워크와 무관하게 써서 세 어드민에 같은 테스트를 돌린다. 이것이 "같은 기능"의 기준이다.

단독 서버(115번)는 미리 빌드한 React 어드민을 내므로, Vue나 Svelte 어드민은 자기 앱에 얹는 사람을 위한 것이다.

**범위.** 묶음 1~5가 만든 화면 전부가 대상이다. 한 번에 다 하지 않고 이 순서로 낸다: 셸과 문서 목록과 편집기, 미디어, 나머지.

## 정해 둔 기본값

| 항목 | 값 | 이유 |
|---|---|---|
| 공개 npm으로 옮기는 때 | 이 묶음 (1.0.0) | 사용자가 당분간 지금처럼 쓰겠다고 함 |
| GitHub Packages | 함께 유지 | 지금 쓰는 앱이 끊기지 않게 |
| 문서의 언어 | 영어가 기본, 한국어는 번역 | 오픈소스의 기본. `TODO.md`와 로드맵 원본은 한국어로 둔다 |
| 문서 사이트 | 이 CMS로 만든다 | 가장 좋은 예제이자 검증 |
| 릴리스 도구 | changesets | 변경 기록을 PR에서 쓰게 한다 |
| 다른 프레임워크 어드민의 순서 | Vue, 그다음 Svelte | shadcn-vue가 React 판과 구조가 가장 가깝다 |
| 어드민 논리의 공유 | `admin-core`로 떼어 냄 | 세 벌을 따로 고치지 않게 |

## 끝났다고 보는 기준

- 토큰 없이 `npm install`과 `npx shadcn add`가 된다 (새 컴퓨터를 흉내 낸 CI 작업으로 확인)
- 문서의 "시작하기"에 적힌 명령을 깨끗한 폴더에서 그대로 실행하면 앱이 뜨고 문서를 만들어 게시할 수 있다
- `agent-cms types --check`가 설정이 바뀌었는데 타입을 다시 만들지 않았을 때 실패한다
- 호환성 표가 CI 결과에서 자동으로 만들어져 README에 있다
- 문서 사이트가 이 CMS의 게시된 문서로 그려지고, API 참조가 OpenAPI와 어긋나지 않는다
- `createTestCms`로 쓴 예제 테스트가 DB 없이 돈다
- CONTRIBUTING대로 따라 하면 처음 온 사람이 테스트를 돌릴 수 있다 (깨끗한 컨테이너에서 확인)

## 이 묶음까지 끝나면

`TODO.md`의 열린 번호가 없어진다. 그때 [README.md](README.md)의 "시안에 없는 화면"과 "확인하지 못한 것"을 다시 읽어, 실제로 어떻게 됐는지를 적고 닫는다. 마지막으로 묶음 1~6의 실제 화면 스크린샷을 시안과 같은 순서로 모아 사용자에게 보여 준다.
