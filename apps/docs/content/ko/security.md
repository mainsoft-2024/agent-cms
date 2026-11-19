---
title: 보안
summary: API 키, 범위, 만료일, 감사 로그.
category: Reference
order: 3
sourceVersion: 1
---
## API 키

키는 `sgk_…` 모양이고 sha256 해시로만 저장돼요. 비밀 값은 만들 때 한 번만 보여 줘요. 키마다 범위가 있고, 필요하면 컬렉션 목록도 정해요.

- `read`: 문서 읽기와 검색
- `write`: 만들기와 고치기(게시는 안 됨)
- `publish`: 게시, 게시 취소, 숨김, 삭제
- `admin`: 키 관리를 포함한 모든 것

키에 만료일을 둘 수 있고, 만료된 키는 `key_expired`로 답해요. 키는 자기보다 넓은 키를 만들 수 없어요(`key_too_wide`).

## 감사 로그

키 변경, 게시, 삭제, 거부된 요청은 `cms_audit`에 남아요. 누가, 어느 통로로(REST, MCP, 도구, CLI), 무엇을 했고 결과가 어땠는지요. **감사 로그** 화면에서 걸러 볼 수 있어요.

## 에이전트에게 주는 글

`read_for_answer`는 섹션을 `<cms-document>` 태그로 감싸서, 모델에게 이 글이 지시가 아니라 참고 자료라고 알려 줘요. [질문에 답하기](/docs/answering)를 보세요.
