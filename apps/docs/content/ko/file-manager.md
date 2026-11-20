---
title: 파일 관리자
summary: 저장소 버킷을 폴더별로 있는 그대로 봐요. CMS로 올리지 않은 파일도 옮기고, 공유하고, 지울 수 있어요.
category: Guides
order: 7
sourceVersion: 1
---
> [!note]
> npm에서는 0.10.0부터 쓸 수 있어요.

[미디어 라이브러리](/docs/media-library)는 CMS가 아는 파일을 보여줘요. 파일 관리자(`npx @mainsoft/agent-cms add cms-files`, `<CmsFiles />`를 둔 페이지)는 버킷을 폴더별로 있는 그대로 보여줘요. 다른 프로그램이 넣은 파일도 보여요. 사이드바의 "파일"은 저장소를 둘러볼 수 있는 사람에게만 보여요. 기본은 그 저장소를 읽을 수 있는 사람이고, 저장소의 `access.browse`로 좁힐 수 있어요.

## CMS가 모르던 파일

- CMS가 모르던 파일은 누가 열거나, 태그를 달거나, 공유하거나, 에이전트가 등록할 때 행이 생겨요. 그때부터 다른 파일처럼 문서에 쓸 수 있어요. `npx @mainsoft/agent-cms storage sync [--store name] [--folder path]`는 한꺼번에 등록하고, CMS는 알지만 버킷에서 사라진 파일을 알려줘요(아무것도 지우지 않아요).
- 여러 파일과 폴더를 한 번에 옮기거나 지울 수 있어요(요청 하나에 1000개까지). 옮기기는 파일을 하나씩 복사하고 지워요. 실패한 파일은 알려주고, 다시 옮기면 남은 것만 옮겨요. 옮길 곳에 같은 이름이 있으면 번호를 붙여요. 덮어쓰는 일은 없어요. 지울 때는 그 파일을 쓰는 문서를 먼저 보여줘요.
- "링크 만들기"는 바깥 사람에게 줄 주소를 만들어요. 비공개 저장소의 링크는 1시간, 24시간, 7일 동안 유효하고 **되돌릴 수 없어요**(서명된 주소라서요). 공개 저장소는 파일의 공개 주소를 줘요. 그 저장소에서 삭제할 권한이 있어야 만들 수 있고, 감사 로그에 남아요.
- CMS가 쓰는 폴더(`_cms/`, 썸네일)는 보이지 않고 건드릴 수 없어요.

## 에이전트

에이전트 도구가 세 개 늘어요. `list_store_files`(read), `register_asset`(write), `create_share_link`(publish)예요.

## REST

`GET /stores/:store/files?folder=`는 폴더 하나를 보여줘요. `POST /stores/:store/files/_register`, `_move`, `_delete`는 키(경로)로 동작해요. 삭제에 `check: true`를 주면 지워질 개수와 그 파일을 쓰는 문서만 세어 줘요. `POST /assets/:id/share`에 `{ ttl: "1h" | "24h" | "7d" }`를 보내면 링크를 만들어요.
