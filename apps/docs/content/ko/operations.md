---
title: 요청 제한, 키 교체, 보존 기간, 이벤트
summary: 키와 로그인하지 않은 사람의 분당 요청 수, 키를 쓸 수 있는 주소, 끊김 없이 새 시크릿으로 바꾸기, 로그를 얼마나 둘지, 일어나는 일을 실시간으로 받기.
category: Guides
order: 12
sourceVersion: 1
---
> [!note]
> 0.14.0부터. 여기 있는 것은 모두 설정하기 전에는 꺼져 있습니다. [0.14로 올리기](/docs/upgrade-0-14)를 보세요.

## 요청 제한

```ts
createCms({
  rateLimit: { perMinute: 600, anonymousPerMinute: 120 },
});
```

| 누구 | 세는 기준 | 한도 |
|---|---|---|
| API 키 | 키 | 키에 정한 `rateLimit`, 없으면 `perMinute` |
| 키도 세션도 없는 요청 | 보낸 쪽 주소 | `anonymousPerMinute` |
| 로그인한 사람 | 세지 않음 | 없음 |

한도를 넘으면 429와 함께 `Retry-After`(초)가 옵니다.

```json
{ "error": "rate_limited", "message": "요청이 너무 많아요. 42초 뒤에 다시 해 주세요", "params": { "retryAfter": 42, "limit": 60 } }
```

1분은 고정된 구간입니다. 시계의 분이 바뀌면 다시 0부터 셉니다. 횟수는 서버 프로세스 안에 둡니다. 서버가 여러 대이거나 서버리스라면 함께 쓰는 저장소를 주세요. 메서드 하나면 됩니다.

```ts
rateLimit: {
  perMinute: 600,
  store: {
    hit: async (bucket, ttlMs) => {
      const n = await redis.incr(bucket);
      if (n === 1) await redis.pexpire(bucket, ttlMs);
      return n;
    },
  },
}
```

주소는 `X-Forwarded-For`의 첫 값, 없으면 `X-Real-IP`에서 읽습니다. 그 헤더를 넣어 주는 프록시 뒤에 있지 않은 서버라면 주소를 어디서 읽을지 알려 주세요: `createCmsHandler({ clientIp: (req) => … })`.

## 키마다 다른 한도와 허용 주소

키 화면에서, 또는:

```ts
await cms.createKey(admin, { name: "deploy", scopes: ["read", "write"], rateLimit: 60, allowedIps: ["203.0.113.0/24", "2001:db8::/32"] });
```

다른 주소에서 쓰면 403 `forbidden_ip`로 답합니다. 주소나 범위를 50개까지, IPv4와 IPv6 모두 됩니다.

## 키 교체

키 화면의 "교체", 또는 `POST /keys/:id/rotate`에 `{ "graceMinutes": 60 }`:

- 이름, 범위, 컬렉션, 만료, 제한이 같은 새 시크릿을 만듭니다. 한 번만 보여 줍니다.
- 기존 시크릿은 유예 시간(기본 60분, 최대 7일, `0`이면 바로 중단) 동안 계속 동작해서 끊김 없이 바꿀 수 있습니다.
- 목록에는 기존 키가 "…까지 동작"으로, 그 뒤에는 "교체됨"으로 보입니다.

`DELETE /keys/:id?reason=leaked`는 폐기한 키에 이유를 남깁니다.

## 보존 기간

```ts
createCms({
  retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90, deliveriesDays: 14 },
});
```

| 옵션 | 지워지는 것 |
|---|---|
| `auditDays` | 이보다 오래된 감사 로그 |
| `hitsDays` | 이보다 오래된 조회 수 (대시보드는 길어야 30일을 읽습니다) |
| `revokedKeysDays` | 폐기한 지 이보다 오래된 키 |
| `deliveriesDays` | 웹훅 전송 기록 (없으면 30일 동안 둡니다) |

cron 호출이 하루에 한 번만 규칙을 적용하고, 지운 것이 있으면 감사 로그에 한 줄을 남깁니다. 문서, 문서의 버전(컬렉션의 `versions.max`), 휴지통(`trash.days`)은 여기에 들어가지 않습니다.

실행하기 전에 먼저 보기:

```sh
npx @mainsoft/agent-cms retention --dry-run     # 관리자 키가 필요합니다
```

```json
{ "dryRun": true, "items": [{ "what": "audit", "days": 365, "before": "2025-11-21T00:00:00.000Z", "rows": 1204 }] }
```

## 일어나는 일을 바로 받기

```ts
const es = new EventSource("/api/cms/_events?collections=posts");
es.addEventListener("doc.published", (e) => refresh(JSON.parse(e.data).slug));
es.addEventListener("resync", (e) => JSON.parse(e.data).documents.forEach((d) => refresh(d.slug)));
```

`GET /_events`는 웹훅이 싣는 것과 같은 이벤트(`doc.created`, `doc.updated`, `doc.published`, …)를 Server-Sent Events로 흘려보냅니다.

- 컬렉션에 쓸 수 있는 사람은 그 문서에 관한 모든 것을 받습니다.
- 공개 컬렉션의 방문자 같은 읽기만 하는 쪽은 공개된 내용이 바뀌는 것만 받습니다: 게시, 게시 취소, 보관, 삭제, 복원.
- 컬렉션이 없는 이벤트(파일, 릴리스)는 관리자에게 갑니다.
- 메시지마다 id(시각)가 있습니다. 브라우저가 다시 연결하면 그 id를 돌려보내고, 첫 메시지로 그 뒤에 저장된 문서 목록(200개까지)을 담은 `resync`를 한 번 받습니다. `?since=<ISO 시각>`으로 직접 할 수도 있습니다.

> [!warning]
> 스트림은 응답하는 그 서버 프로세스가 채웁니다. 서버가 여러 대면 다른 서버를 거친 변경은 실시간이 아니라 다음 `resync` 때 옵니다. 긴 응답을 끊는 호스트(서버리스)는 제한 시간이 되면 스트림을 끝내고, `EventSource`가 알아서 다시 연결합니다.

코드에서는 `const stop = cms.subscribe((event) => …)`.

## 더 많은 훅

```ts
defineCollection({
  slug: "posts",
  hooks: {
    beforeValidate: [({ input, prev }) => (!prev && !input.slug && input.title ? { slug: slugify(input.title) } : undefined)],
    afterPublish: [(doc) => revalidatePath(`/blog/${doc.slug}`)],
    afterDelete: [(doc) => searchIndex.remove(doc.id)],
    afterRead: [(doc, { actor }) => (actor.kind === "anonymous" ? { ...doc, fields: { ...doc.fields, internalNote: undefined } } : undefined)],
  },
});
```

| 훅 | 언제 | 동작을 막을 수 있나 |
|---|---|---|
| `beforeValidate` | 입력을 검사하기 전. 필드를 돌려주면 바뀝니다 | 예, 오류를 던져서 |
| `beforeChange`, `beforePublish`, `beforeDelete` | 저장, 게시, 삭제 전 (0.12) | 예 |
| `afterChange`, `afterPublish`, `afterDelete` | 일이 끝난 뒤 | 아니요. 오류는 `onError`로 갑니다 |
| `afterRead` | 문서 하나가 `get`에서 나가기 전 (목록과 검색은 아님) | 예, 오류를 던져서 |

`afterPublish`는 예약 게시와 릴리스 게시에서도 실행됩니다.
