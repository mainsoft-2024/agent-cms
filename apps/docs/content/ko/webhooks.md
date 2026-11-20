---
title: 웹훅, 작업, 플러그인
summary: 서명과 재시도가 있는 웹훅, 그것을 보내는 백그라운드 작업, 컬렉션 훅, 플러그인, 측정.
category: Guides
order: 9
sourceVersion: 1
---
> [!note]
> 0.12.0부터. 이전 버전에서 올라온다면 [0.12로 올리기](/docs/upgrade-0-12)를 먼저 읽으세요.

다른 서비스는 **웹훅**으로 무슨 일이 있었는지 알아요. 문서가 게시되거나, 검토 요청이 오거나, 파일이 올라오면 서명된 POST를 보내요. 키를 설정하기 전에는 꺼져 있고, 예약 게시를 실행하는 cron 호출이 웹훅도 함께 보내요.

```ts
createCms({
  // ...
  cronSecret: process.env.CMS_CRON_SECRET,   // `Authorization: Bearer <시크릿>`으로 POST /api/cms/_cron
  secretsKey: process.env.CMS_SECRETS_KEY,   // 32자 이상: openssl rand -base64 32
});
```

서명 키는 `secretsKey`로 암호화해(AES-256-GCM) 저장해요. 이 키를 바꾸면 저장된 서명 키를 읽을 수 없으니, 오래 쓰는 다른 시크릿과 함께 보관하세요.

관리자가 어드민 화면(`cms-webhooks`)이나 `POST /webhooks`로 웹훅을 만들어요. 이름, https 주소, 이벤트, 컬렉션을 정해요. 서명 키는 만들 때 보이고, 같은 화면에서 다시 볼 수 있어요.

**이벤트:** `doc.created`, `doc.updated`, `doc.published`, `doc.unpublished`, `doc.archived`, `doc.deleted`, `doc.restored`, `review.requested`, `review.approved`, `review.rejected`, `asset.uploaded`, `asset.moved`, `asset.deleted`, `release.published`, `comment.created`. 아무것도 고르지 않으면 전부예요.

**보내는 내용.** 문서 본문은 절대 담지 않아요:

```json
{ "id": "…", "event": "doc.published", "at": "2026-11-21T03:00:00.000Z",
  "actor": { "kind": "user", "id": "u1", "label": "Kim", "agent": null },
  "collection": "posts", "slug": "launch", "version": 3, "url": "https://example.com/posts/launch" }
```

**받는 쪽**은 서명을 확인해요(`X-CMS-Signature: t=<초>,v1=<"t.본문"의 HMAC-SHA256>`, 허용 시간 5분). `verifyWebhook`은 Node 모듈을 쓰지 않아서 edge 런타임에서도 돌아가요:

```ts
import { verifyWebhook } from "@mainsoft/agent-cms/webhooks";

export async function POST(req: Request) {
  const event = await verifyWebhook(req, process.env.CMS_WEBHOOK_SECRET!); // 아니면 WebhookVerifyError
  if (event.event === "doc.published") revalidatePath(`/${event.collection}/${event.slug}`);
  return new Response("ok");
}
```

같은 전송이 두 번 올 수 있어요(응답이 유실되어 CMS가 다시 보낸 경우). `event.id`는 시도마다 같아요.

**전송.** 이벤트를 일으킨 요청 안에서는 아무것도 보내지 않아요. 작업 표에 적어 두었다가 다음 cron 호출 때 보내요. 그래서 지연은 cron 간격만큼이에요. 2xx가 아닌 응답, 리다이렉트, 10초 안에 응답이 없는 경우는 실패로 보고 1분, 5분, 30분, 2시간, 12시간 뒤에 다시 보내요. 연속 20번 실패하면 웹훅을 꺼요(감사 로그에 남고, 화면에 이유가 보이고, "켜기"로 다시 시작해요). 전송 기록은 30일 보관하고 "다시 보내기"가 있어요.

**주소.** 공개 인터넷의 https 주소만 돼요. 사설, 루프백, 링크 로컬 주소는 저장할 때와 보낼 때마다 거절해요. `webhooks: { allowInsecure: true }`는 로컬 개발에서만 쓰세요.

**권한.** 관리자와 `admin` 스코프 키만 다뤄요. 웹훅을 만드는 에이전트 도구는 없어요. 에이전트가 스스로 데이터가 나갈 길을 열 수 없어요.

## 백그라운드 작업

웹훅 전송은 작업의 한 종류예요. 같은 표로 직접 만든 작업도 돌릴 수 있어요:

```ts
cms.jobs.define<{ id: string }>("report.build", { retryAfter: [60, 600], run: async ({ id }) => build(id) });
await cms.jobs.enqueue("report.build", { id: "2026-11" }, { runAt: tomorrow });
```

`POST /_cron`은 예약 게시를 실행하고, 때가 된 작업을 약 20초 동안 실행하고(남은 것은 다음 호출에), 정리 작업을 해요. 두 호출이 동시에 와도 같은 작업을 두 번 실행하지 않아요. cron 서비스가 없으면 `npx @mainsoft/agent-cms cron --watch`가 30초마다 불러요(`AGENT_CMS_URL`, `AGENT_CMS_CRON_SECRET`). `GET /jobs?state=failed`로 포기한 작업을 보고, `POST /jobs/:id/retry`로 다시 시도해요. `doctor`도 실패한 작업이 있으면 알려 줘요.

## 훅, 플러그인, 측정

**컬렉션 훅**은 쓰기 안에서 실행돼요:

```ts
defineCollection({
  slug: "posts",
  hooks: {
    beforeChange: [({ content, prev }) => (prev ? undefined : { keywords: [...content.keywords, "new"] })], // 필드를 돌려주면 바꿔요
    beforePublish: [({ content }) => { if (!content.summary) throw new Error("게시 전에 요약을 써 주세요"); }],
    beforeDelete: [({ slug }) => { if (slug === "home") throw new Error("홈 페이지는 삭제할 수 없어요"); }],
    afterChange: [/* 전과 같아요 */],
  },
});
```

훅이 던지면 쓰기를 `hook_rejected`(422)와 그 메시지로 거절해요. `beforePublish`는 예약, 릴리스, 승인에서도 실행돼요.

**플러그인**은 다른 패키지에서 CMS에 기능을 더해요:

```ts
import { definePlugin } from "@mainsoft/agent-cms";

export const stats = definePlugin({
  name: "stats",                                   // 라우트는 /api/cms/stats/ 아래
  sql: ['CREATE TABLE IF NOT EXISTS "stats_days" (…)'],   // cms.plugins.sql에 모여요. 마이그레이션에 넣으세요
  setup(ctx) {
    ctx.on("doc.published", (e) => ctx.enqueue("rollup", { slug: e.slug }));
    ctx.job("rollup", { run: async (p) => { /* … */ } });
    ctx.route("GET", "summary", ({ actor, cms }) => Response.json({ /* … */ }));   // actor는 이미 확인된 값
    ctx.tool({ name: "stats_summary", description: "…", input: z.object({}), run: () => ({ /* … */ }) });
    ctx.me((actor) => ({ canSee: actor.kind !== "anonymous" }));   // GET /_me → plugins.stats
    ctx.nav({ label: "통계", href: "/admin/stats" });               // 어드민 사이드바에 보여요
  },
});
createCms({ /* … */, plugins: [stats] });
```

`ctx.secrets`로 플러그인이 DB에 넣는 값을 암호화해요(`secretsKey`가 없으면 null).

**측정.** `createCms({ onEvent })`가 모든 요청(`method`, `path`, `status`, `ms`, `actor`, `via`), 이벤트, 작업 실행, cron 호출, CMS가 보고하는 오류를 받아요. 추적 도구에 연결하세요. 기다리지 않고 호출해요.
