---
title: 0.11로 올리기
summary: 스키마는 버전 5예요. 파일 표에 열 세 개가 늘어요. 편집기가 창 높이를 채우게 바뀌었어요. Vercel Blob과 이미지 크기는 켜야 동작해요.
category: Upgrade
order: 4
sourceVersion: 1
---
0.10.x에서 올리는 경우예요. 없어진 것도, 뜻이 바뀐 호출도 없어요. 스키마 단계 하나와 복사한 화면의 배치 변경 하나가 있어요.

## 1. 스키마 버전 5

```sh
npx agent-cms migrate check
npx agent-cms migrate apply    # 또는 `migrate print`로 SQL을 받아 직접 실행
```

`cms_assets`에 열 세 개를 더해요. 두 번 실행해도 괜찮아요. `focal_x`, `focal_y`는 사진의 초점이고 처음에는 비어 있어요. `rev`는 파일을 바꾼 횟수이고 처음에는 0이에요. 시작할 때 표를 스스로 만드는 앱은 따로 할 일이 없어요.

`CmsAsset`에 `focalX`, `focalY`, `rev`가 생겼고, `assetsFor`가 돌려주는 `AssetInfo`에 `focal`이 생겼어요. `CmsAsset`을 손으로 만드는 코드(직접 만든 `CmsRepo`, 테스트 데이터)는 이 값을 채워야 해요.

## 2. 복사한 화면 갱신

```sh
npx agent-cms add --update
```

`cms-doc-editor`에 새 파일(`cms-body-tools.tsx`)이 생겼어요. `cms-upload.ts`, `cms-media.tsx`, `cms-media-picker.tsx`, `cms-parts.tsx`, `cms-messages.ts`가 바뀌었어요.

> [!warning]
> **편집기의 높이.** 넓은 화면에서 편집기는 내용만큼 길어지고 페이지와 함께 스크롤됐어요. 이제는 창 높이를 채우고 안에서 스크롤돼요. 글과 미리보기가 함께 움직이려면 이렇게 되어야 해요. 어드민에 편집기 위쪽 막대가 있다면 남는 높이를 주세요: `<CmsDocEditor className="md:h-[calc(100dvh-4rem)]" />`. 폰 화면은 그대로예요.

## 3. 새 기능, 켜야 동작해요

- **Vercel Blob:** `npm install @vercel/blob` 뒤에 저장소의 어댑터로 [`vercelBlobStorage`](/ko/docs/media-library#vercel-blob)를 주세요.
- **이미지 크기:** `npm install sharp` 뒤에 [`media.transforms`](/ko/docs/media-library#이미지-크기)를 주세요. Node 런타임에서만 돌아가요.
- **카메라 정보 지우기:** `media.stripMetadata: true`.
- 파일 바꾸기, 초점, 새로 고친 뒤 이어 올리기는 설정이 없어요. 2번을 하면 미디어 화면에 나타나요.

## 4. 저장소 어댑터를 직접 만들었다면

할 일이 없어요. `StorageAdapter`에 선택 항목 세 개가 생겼어요. `multipart`는 저장소가 조각을 받지 못할 때 `false`로 둬요(그러면 CMS가 모든 파일을 요청 하나로 보내요). `settle(key, options)`는 브라우저가 올린 파일이 검사를 통과한 뒤 한 번 불려요. `presignPut` 옵션의 `size`는 올리는 쪽이 밝힌 크기예요.

바꾼 파일은 주소가 그대로예요. CMS가 내주는 주소에는 `?v=<rev>`가 붙어요. 공개 버킷 앞의 CDN이 옛 내용을 얼마나 오래 들고 있는지는 CDN 설정에 달려 있어요.
