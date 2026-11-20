---
title: 자동화, 역할, 대시보드
summary: 무슨 일이 생긴 뒤에 실행되는 규칙, 컬렉션마다 누가 쓰고 게시할 수 있는지, 콘텐츠의 숫자를 한 화면에.
category: Guides
order: 10
sourceVersion: 1
---
> [!note]
> 0.13.0부터. 이전 버전에서 올라온다면 [0.13으로 올리기](/docs/upgrade-0-13)를 먼저 읽으세요.

## 자동화

자동화는 관리자가 화면에서 만드는 규칙입니다. **언제** 무슨 일이 생기면, **조건**이 맞을 때, **동작**을 차례로 합니다.

| 부분 | 고를 수 있는 것 |
|---|---|
| 언제 | 문서가 만들어짐, 수정됨, 게시됨, 게시 취소됨, 삭제됨. 검토 요청됨. 파일이 올라옴. 매일. 매주 월요일. |
| 조건 | `category`, `actor`(`person` 또는 `agent`), `title`, 또는 `fields.tags` 같은 필드: 같음, 다름, 포함, 비어 있음, 비어 있지 않음 |
| 동작 | 웹훅 보내기. 검색어 추가. 필드 값 넣기. 릴리스에 담기. 앱의 함수 부르기. |

```ts
createCms({
  cronSecret: process.env.CRON_SECRET,        // 자동화는 cron 호출 때 실행됩니다
  automations: {
    actions: {
      // 화면의 "앱 함수 부르기"에 이 이름들이 나옵니다.
      notifySales: async ({ automation, doc, event }) => {
        await slack.send(`${automation.name}: ${doc?.title}`);
      },
    },
  },
});
```

실행되는 방식:

- 조건에 맞는 이벤트는 백그라운드 작업이 됩니다. 일은 그 이벤트를 만든 요청 안에서가 아니라 다음 `POST /_cron` 때 합니다. cron 서비스가 없으면 `npx @mainsoft/agent-cms cron --watch`.
- 자동화가 바꾼 것은 "automation: <이름>"이 쓴 새 버전으로 저장되어 버전 기록에 보입니다.
- 자동화가 만든 변경은 다른 자동화를 깨우지 않습니다.
- 실행 기록은 30일 동안 남습니다: 성공, 건너뜀(조건이 맞지 않음), 실패. 동작마다 한 줄씩 적힙니다.
- 화면에서 새로 만든 자동화는 꺼진 채로 시작합니다. API로 만든 것은 `enabled: false`를 보내지 않으면 켜져 있습니다.

화면의 "시험 실행"이나 `POST /automations/:id/test`에 `{ collection, slug }`를 보내면, 문서 하나를 조건에 대 보고 실행될 동작을 알려 줍니다. 아무것도 바뀌지 않습니다.

```sh
curl -X POST https://app.example.com/api/cms/automations \
  -H "authorization: Bearer $AGENT_CMS_KEY" -H "content-type: application/json" \
  -d '{"name":"News keyword","trigger":{"event":"doc.published","collection":"posts"},
       "conditions":[{"field":"category","op":"is","value":"News"}],
       "actions":[{"type":"add_keyword","name":"news"}]}'
```

자동화는 관리자(또는 `admin` 범위의 키)만 만들 수 있고, 에이전트 도구로는 만들 수 없습니다.

## 역할

역할은 컬렉션마다 그 역할의 사람이 **쓰기**, **게시**, **삭제**를 할 수 있는지 정합니다. 관리자 역할은 키, 웹훅, 자동화, 역할까지 전부 할 수 있습니다.

CMS는 이 순서로 판단합니다.

1. 시스템 (cron, 자동화).
2. 코드에 적은 컬렉션의 `access` 함수. 코드가 정한 동작은 역할 화면에 "코드에서 정함"으로 보이고 화면에서 바꿀 수 없습니다.
3. 역할.
4. 기본값: 관리자만.

역할을 하나도 만들지 않은 앱은 0.13 이전과 똑같이 동작합니다.

사람은 `resolveUser`가 돌려주는 id로 역할에 넣습니다. 화면에서 이름으로 찾게 하려면:

```ts
createCms({
  users: {
    search: async (q) => (await findUsers(q)).map((u) => ({ id: u.id, label: u.name })),
    get: async (id) => { const u = await findUser(id); return u ? { id: u.id, label: u.name } : null; },
  },
});
```

`users`가 없으면 id를 직접 입력해 넣습니다. 역할 이름은 한 번만 쓸 수 있고 두 번째는 `name_taken`으로 거절됩니다. 나를 관리자로 만들어 주는 역할은 지우거나, 거기서 나가거나, 관리자 표시를 뺄 수 없습니다(`role_last_admin`). 이 화면에 다시 들어올 수 없게 되기 때문입니다.

API 키는 역할과 따로입니다. 키는 자기 범위와 컬렉션을 갖습니다.

## 대시보드

`GET /_stats?days=7|14|30`과 `cms-dashboard` 화면:

- **문서, 게시됨, 검토 대기, 예약됨**: 목록의 숫자와 같습니다.
- **변경**: 날마다 저장된 버전 수를 사람과 에이전트로 나눠 보여 줍니다.
- **많이 읽은 문서**: 조회 수 기록이 필요합니다 (`cms.recordHits`, [검색](/docs/search) 참고).
- **최근 활동**: 게시, 예약, 삭제, 검토, 올리기.

읽을 수 있는 컬렉션만 보이고, 누가 무엇을 했는지는 관리자만 봅니다.
