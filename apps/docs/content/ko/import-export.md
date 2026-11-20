---
title: 내보내기와 가져오기
summary: 문서를 마크다운 파일로. 두 설치 사이에서, 또는 WordPress, CSV, JSON에서. 가져오기는 하기 전에 무엇을 할지 먼저 보여 줍니다.
category: Guides
order: 11
sourceVersion: 1
---
> [!note]
> 0.13.0부터.

문서는 frontmatter가 붙은 마크다운 파일로 오갑니다. 문서 하나에 파일 하나입니다.

```
content/
  guide/getting-started.md
  posts/hello-world.md
  _meta.json               # 버전, 시각, 개수
  _assets/manifest.json    # 문서가 쓰는 파일 목록
  _assets/<id>/<name>      # 파일 자체 (--with-files)
```

## 명령줄에서

```sh
export AGENT_CMS_URL=https://app.example.com/api/cms AGENT_CMS_KEY=sgk_…
npx @mainsoft/agent-cms export ./content                     # 게시된 내용
npx @mainsoft/agent-cms export ./content --drafts            # 키가 쓸 수 있는 곳은 작업 중인 내용
npx @mainsoft/agent-cms export ./content --collection guide,posts --with-files

npx @mainsoft/agent-cms import ./content --dry-run --diff    # 파일마다 한 줄, 바뀌는 줄까지
npx @mainsoft/agent-cms import ./content
npx @mainsoft/agent-cms import ./content --publish           # 내보낼 때 공개였던 것은 게시
npx @mainsoft/agent-cms put guide ./guide                    # 폴더 하나를 컬렉션 하나로
```

가져오기가 하는 일:

- 아무것도 지우지 않습니다.
- 없는 주소는 초안으로 만듭니다. 있는 주소는 새 버전이 되고, 공개된 내용은 누가 게시할 때까지 그대로입니다.
- `--on-conflict file-wins`(기본)는 파일을 저장하고, `db-wins`는 이미 있는 문서를 건너뛰고, `newest`는 더 나중에 바뀐 쪽을 따릅니다.
- 컬렉션의 검사를 통과하지 못한 파일은 이유와 함께 알려 주고 나머지는 계속합니다.
- 폴더에 `_assets/`가 있으면, 받는 쪽에 없는 파일을 먼저 올리고 문서 안의 `asset:ID`를 새 id로 바꿉니다. 다시 실행해도 두 번 올리지 않습니다.

## 어드민에서

`cms-transfer` 화면(관리자)은 내보낸 파일(`.json`)이나 마크다운 파일을 받아, 파일마다 무엇을 할지 표로 보여 주고, 뺄 파일을 고르게 한 뒤, 나머지를 초안으로 가져옵니다. 내보내기 탭은 묶음을 내려받습니다.

## 다른 곳에서

```sh
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts --dry-run
npx @mainsoft/agent-cms import ./wordpress.xml --from wordpress --collection posts --publish
npx @mainsoft/agent-cms import ./rows.csv --from csv --collection guide
npx @mainsoft/agent-cms import ./items.json --from json --collection guide
```

| 원본 | 읽는 것 |
|---|---|
| `wordpress` | WordPress 내보내기 파일(도구 → 내보내기). 글과 페이지(`--types post,page,…`로 다른 종류). HTML은 마크다운으로, 카테고리와 태그는 검색어로, 글의 슬러그는 주소로. 공개된 글은 `--publish`로 게시할 수 있습니다. 첨부 파일, 메뉴, 수정 기록은 빠집니다. |
| `csv` | 첫 줄이 열 이름입니다: `slug`, `title`, `summary`, `body`(또는 `html`, `content`), `category`, `keywords`(또는 `tags`), `status`. 다른 열은 필드가 됩니다. |
| `json` | 같은 키를 가진 객체의 배열, 또는 `{ "documents": [...] }`. CMS가 모르는 키는 필드가 됩니다. |

주소는 쓸 수 있는 형태(영어 소문자, 숫자, 하이픈)로 바꾸고 겹치지 않게 합니다. 한글 제목처럼 그런 글자가 없으면 `doc-1`, `doc-2`가 되니 가져온 뒤에 바꿔 주세요.

코드에서:

```ts
import { filesFromSource, htmlToMarkdown } from "@mainsoft/agent-cms";

const files = filesFromSource("wordpress", xml, { collection: "posts" });
const report = await cms.transfer.import(actor, files, { dryRun: true });
```

WordPress 글 안의 그림은 옛 사이트를 그대로 가리킵니다(`https` 주소만 남습니다). `import_asset` 도구나 미디어 화면의 "URL에서 가져오기"로 미디어 라이브러리에 넣으세요.

## REST

- `GET /export?collections=a,b&drafts=1&download=1` → `{ files, documents }`
- `POST /import`에 `{ files, dryRun, diff, publish, onConflict, collection, only, assetMap }` → `{ items, applied }`

요청 하나에 파일 2000개까지이고, CLI는 100개씩 나눠 보냅니다.
