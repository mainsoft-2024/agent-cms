---
title: 렌더링
summary: 문서 본문을 내 컴포넌트로 그려요.
category: Guides
order: 5
sourceVersion: 1
---
`@mainsoft/agent-cms/markdown`은 브라우저와 서버 어디서든 돌아가요. `parseMarkdown`이 작은 블록 트리를 만들고, 그걸 내 컴포넌트로 그려요.

```ts
import { extractToc, parseMarkdown } from "@mainsoft/agent-cms/markdown";

const blocks = parseMarkdown(doc.body);
const toc = extractToc(blocks);
```

## 블록

- `heading`(2단계, 3단계): 앵커용 `id`가 고정돼 있어요
- `p`, `list`(번호 있음, 없음), `hr`
- `quote`: 콜아웃 종류가 붙을 수 있어요(`> [!tip]`, `> [!note]`, `> [!warning]`)
- `code`: 언어와 함께
- `links`: `[[link:key|label]]` 앱 링크 한 줄

인라인은 `text`, `strong`, `code`, `link`, 앱 링크예요.

## 예

이 사이트의 모든 페이지가 이렇게 그려져요. 제목에는 앵커 링크가, 콜아웃에는 노란 메모가, 셸 코드에는 npm, pnpm, yarn, bun 탭이 붙어요.
