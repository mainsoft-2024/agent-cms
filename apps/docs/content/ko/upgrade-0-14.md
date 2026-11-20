---
title: 0.14로 올리기
summary: 스키마는 바뀌지 않습니다. 요청 제한, 키 교체, 보존 기간, 새 훅, 이벤트 스트림은 모두 설정하기 전에는 꺼져 있습니다.
category: Upgrade
order: 7
sourceVersion: 1
---
0.13.x에서. 스키마는 바뀌지 않고, 새 옵션을 설정하기 전에는 동작이 달라지지 않습니다. 자세한 내용은 [요청 제한, 키 교체, 보존 기간, 이벤트](/docs/operations)에 있습니다.

## 1. 화면

```sh
npx @mainsoft/agent-cms add --update     # cms-keys, cms-messages
```

키 화면에 "교체", "분당 요청 수", "허용 주소"가 생깁니다.

## 2. 요청 제한은 설정해야 켜집니다

```ts
createCms({
  rateLimit: { perMinute: 600, anonymousPerMinute: 120 },
});
```

- `perMinute`는 API 키마다 적용되고, 키에 정한 `rateLimit`이 있으면 그것이 우선입니다.
- `anonymousPerMinute`는 키도 세션도 없는 요청을 주소별로 셉니다. 로그인한 사람은 세지 않습니다.
- 한도를 넘으면 429 `rate_limited`와 `Retry-After`(초).
- 횟수는 서버 프로세스마다 따로 셉니다. 서버가 여러 대이거나 서버리스라면 `rateLimit.store`에 함께 쓰는 저장소를 주세요.

주소는 `X-Forwarded-For`의 첫 값, 없으면 `X-Real-IP`에서 읽습니다. 그 헤더를 넣어 주는 프록시 뒤가 아니라면 클라이언트가 헤더를 직접 보낼 수 있으니 `createCmsHandler({ clientIp: (req) => … })`를 주세요.

## 3. 키 교체

`POST /keys/:id/rotate`에 `{ "graceMinutes": 60 }`을 보내면 새 시크릿을 돌려줍니다. 기존 시크릿은 유예 시간이 끝날 때까지 동작하고, `0`이면 바로 끊깁니다.

## 4. 보존 기간은 설정해야 켜집니다

```ts
createCms({ retention: { auditDays: 365, hitsDays: 400, revokedKeysDays: 90 } });
```

cron 호출 때 하루에 한 번만 실행됩니다. 먼저 `npx @mainsoft/agent-cms retention --dry-run`(관리자 키)으로 확인하세요.

## 5. 타입

- `CreateCmsOptions`에 `rateLimit`과 `retention`, `CmsHandlerOptions`에 `clientIp`가 생겼습니다.
- `CmsKey`에 `rateLimit`, `allowedIps`, `revokedReason`, `rotatedTo`가 생겼습니다. `revokedAt`이 미래인 키는 교체되었지만 아직 동작하는 키입니다. 폐기되었다고 하기 전에 지금 시각과 비교하세요.
- 직접 만든 `CmsRepo`에는 `prune(what, before, dryRun)`이 필요하고, `revokeKey`가 미래 시각을 받아야 합니다. `MemoryRepo`와 `DrizzleRepo`는 둘 다 됩니다.
- 컬렉션의 새 훅: `beforeValidate`, `afterPublish`, `afterDelete`, `afterRead`.
- 새 오류 코드: `rate_limited`(429), `forbidden_ip`, `forbidden_admin`, `invalid_ip_range`, `invalid_rate_limit`.
- `retention`, `_events`, `auth`는 예약된 이름이라 컬렉션의 슬러그로 쓸 수 없습니다.
