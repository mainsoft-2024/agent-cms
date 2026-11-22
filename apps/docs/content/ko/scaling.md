---
title: 여러 서버, 캐시, 여러 사이트
summary: 변경 로그가 서버 사이에 이벤트를 나르고, 읽기 캐시, DB에서 하는 페이지 나누기, 드라이버, Edge, 여러 사이트, 지표를 씁니다.
category: Guides
order: 16
sourceVersion: 1
---
0.17.0(스키마 9)부터 모든 변경이 번호가 붙은 **변경 로그**(`cms_changes`)에 기록됩니다. 서버마다 이 로그를 따라 읽으므로, 이벤트 스트림·읽기 캐시·검색 색인이 어느 서버에서 일어난 변경이든 알게 됩니다.

## 다른 서버 따라가기

설정할 것은 없습니다. 듣는 쪽(열린 이벤트 스트림, 캐시)이 있는 서버는 2초마다 로그를 봅니다. 바로 알게 하려면 신호를 줍니다.

```ts
import { connectPostgres } from "@mainsoft/agent-cms/db";
import { memoryCache } from "@mainsoft/agent-cms/changes";

const { repo, signal } = await connectPostgres(process.env.DATABASE_URL!); // pg, postgres.js: LISTEN/NOTIFY
const cms = createCms({ repo, collections, cache: memoryCache({ max: 2000 }), changes: { signal, keepDays: 7 } });
```

서버리스 호스트에는 오래 듣는 연결이 없어 폴링으로 따라갑니다. 클라이언트도 `GET /api/cms/_changes?since=<last>`로 폴링할 수 있고, 답은 `{ changes, last, more, reset }`입니다. `reset: true`는 로그가 그만큼 거슬러 올라가지 않는다는 뜻이니 전부 다시 읽으면 됩니다.

이벤트 스트림(`/_events`)의 메시지 id도 같은 번호입니다. 다시 연결한 브라우저는 마지막 id를 보내고 놓친 것만 정확히 받습니다.

0.18부터 번호는 커밋 순서대로 붙습니다(쓰기마다 끝에 로그에 짧은 잠금). 그래서 재개 지점이 아직 커밋 중인 변경을 건너뛰지 않습니다. 직접 만든 저장소는 `changesInCommitOrder: true`로 알리고, 그렇지 않으면 CMS가 빈 번호에서 최대 15초 기다립니다.

## 읽기 캐시

`cache`에는 `memoryCache()`나 `get(key)`, `set(key, value, ttlMs)`가 있는 저장소(Redis, Upstash, Next 캐시)를 줍니다. 독자가 받는 문서와 목록을 캐시하고, 편집자는 캐시를 거치지 않습니다. 게시·게시 취소·보관·삭제·복원이 있으면 그 컬렉션의 캐시를 이 서버에서는 바로, 다른 서버에서는 다음 폴링 안에 비웁니다. `access.read` 규칙이 있는 컬렉션은 캐시하지 않습니다.

## 페이지 나누기와 색인

목록은 DB에서 거르고 정렬하고 자릅니다. 커서는 마지막 행(`k.…`)이라 새 문서가 생겨도 페이지가 겹치거나 빠지지 않습니다. `doctor`는 스키마 9가 더하는 색인 11개를 확인하고, `doctor --fix`는 사라진 문서를 가리키는 행(버전, 파일 사용처, 댓글)을 지웁니다.

## 드라이버

`connectPostgres(url, { driver })`: `pg`, `postgres-js`, `neon-serverless`(WebSocket, 트랜잭션), `neon-http`(트랜잭션 없음: 변경을 문장 하나씩 실행하고, 버전 확인으로 덮어쓰기는 막음), `pglite`(`memory:`나 폴더).

## Edge

코어와 REST 핸들러는 Node 내장 모듈이 필요 없습니다. Vercel Edge나 Cloudflare Workers에서 거기서 되는 드라이버(`neon-http`, `neon-serverless`)와 함께 돌립니다. 웹훅은 봉인한 시크릿 때문에 Node의 crypto가 필요합니다(Workers는 `nodejs_compat`).

웹훅 주소는 보낼 때마다 내부망 주소가 아닌지 확인합니다. `node:dns`가 없는 곳(Edge)에서는 `https://cloudflare-dns.com/dns-query`에 DNS over HTTPS로 묻기 때문에, 웹훅이 부르는 호스트 이름이 그곳에 전달됩니다. 그래서는 안 되는 곳이라면 전달은 Node에서 돌리거나 Edge에서는 웹훅을 끄세요.

## 여러 사이트

```ts
import { createTenantHandler, migrateTenant, tenantTables } from "@mainsoft/agent-cms/tenants";

export const handler = createTenantHandler({
  resolve: (req) => new URL(req.url).hostname.split(".")[0],
  create: async (site) => {
    await migrateTenant(db, site);
    const cms = createCms({ repo: new DrizzleRepo(db, { tables: tenantTables(site) }), collections });
    return createCmsHandler({ cms, resolveUser });
  },
});
```

사이트마다 Postgres 스키마(`tenant_<id>`)가 따로라 쿼리가 섞일 수 없고, 사이트 하나만 덤프하거나 지울 수 있습니다.

## 지표

단독 서버에 `server.metricsToken`(또는 `CMS_METRICS_TOKEN`)을 주면 `GET /metrics`가 켜집니다(Prometheus 텍스트, Bearer 토큰). 직접 만든 앱에서는 `const m = createMetrics(); createCms({ onEvent: m.onEvent })`로 모으고 `m.text()`를 내보냅니다. 경로는 묶어서 셉니다(`/collections/:c/:slug`).

## 측정

저장소에서 `npm run bench -- --docs 10000`으로 읽기, 목록, 검색, 저장, 게시 시간을 잽니다(PGlite, 또는 `DATABASE_URL`).
