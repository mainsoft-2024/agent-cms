---
title: 0.12로 올리기
summary: 스키마는 버전 6이에요. 작업과 웹훅 표 세 개가 늘어요. cron 호출이 웹훅도 보내요. 웹훅은 secretsKey를 설정해야 켜져요.
category: Upgrade
order: 5
sourceVersion: 1
---
## 1. 스키마 버전 6

표 세 개가 늘어요: `cms_jobs`, `cms_webhooks`, `cms_webhook_deliveries`. 기존 표는 바뀌지 않아요.

```sh
npx @mainsoft/agent-cms migrate check
npx @mainsoft/agent-cms migrate apply     # 또는 `migrate print`로 SQL을 받아 직접 실행
```

Drizzle 스키마 파일에서 표를 다시 내보내고 있다면 `cmsJobs`, `cmsWebhooks`, `cmsWebhookDeliveries`를 추가하세요(새로 `init`하면 들어 있어요).

## 2. cron 호출이 하는 일이 늘었어요

`POST /_cron`은 예약 게시와 휴지통 비우기를 했어요. 이제 백그라운드 작업도 실행하고, 웹훅이 이때 나가요. 응답에 `jobs` 필드(`{ran, ok, retried, failed, waiting}`)가 생겼고 기존 필드는 그대로예요. 하루 한 번 부르면 웹훅도 하루 한 번 나가요. 웹훅을 쓴다면 1분쯤 간격으로 부르세요. cron 서비스가 없으면 `npx @mainsoft/agent-cms cron --watch`를 쓰세요.

## 3. 웹훅은 켜야 동작해요

`secretsKey`(32자 이상)를 설정하고 관리자가 웹훅을 만들기 전에는 아무것도 보내지 않아요. 화면은 `npx @mainsoft/agent-cms add cms-webhooks`로 받고 `/admin/webhooks` 페이지를 만드세요.

## 4. 화면

`npx @mainsoft/agent-cms add --update`가 `cms-shell`(웹훅 메뉴, 플러그인 메뉴)과 `cms-messages`를 가져와요. 다른 화면은 그대로예요.

## 5. 타입

- `CollectionConfig.hooks`에 `beforeChange`, `beforePublish`, `beforeDelete`가 생겼어요.
- `CreateCmsOptions`에 `secretsKey`, `webhooks`, `plugins`, `onEvent`가 생겼어요.
- 직접 만든 `CmsRepo`는 작업과 웹훅 메서드(`insertJob`, `claimJobs`, … `failWebhook`, `pruneDeliveries`)가 필요해요. `MemoryRepo`와 `DrizzleRepo`에는 들어 있어요.
- 새 오류 코드: `webhook_not_found`, `delivery_not_found`, `forbidden_webhooks`, `secrets_key_missing`, `webhook_url_blocked`, `webhook_event_unknown`, `hook_rejected`.
