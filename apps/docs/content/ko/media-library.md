---
title: 미디어 라이브러리
summary: 사진, 영상, 파일을 내 버킷에 둬요. 올릴 때는 브라우저에서 저장소로 바로 보내요.
category: Guides
order: 6
sourceVersion: 1
---
> [!note]
> 0.8.0부터 쓸 수 있어요. `createCms`에 `media`를 넣지 않으면 기능이 꺼져 있고 아무것도 달라지지 않아요.

문서에 이미지, 영상, 파일을 넣을 수 있어요. 파일은 내 저장소 버킷에 있고, CMS는 파일마다 행 하나만 가져요. 브라우저는 서명된 주소를 받아 저장소로 바로 올려요. 앱 서버를 거치지 않으니 서버리스 호스트에서도 5GB 영상을 올릴 수 있어요.

## 설정

```ts
import { s3Storage } from "@mainsoft/agent-cms/storage-s3";

const s3 = (bucket: string, publicUrl?: string) =>
  s3Storage({ bucket, region: "auto", endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET!, publicUrl });

export const cms = createCms({
  // …
  media: {
    stores: {
      // The first store is the default. `public`: anyone with the address can read.
      public: { label: "Public", visibility: "public", adapter: s3("site-media", "https://media.example.com") },
      // `private`: opened through the CMS after a permission check, with a link that works for 5 minutes.
      private: { label: "Private", visibility: "private", adapter: s3("site-private"), accept: ["application/pdf"], maxFileSize: 100 * 1024 ** 2 },
    },
    // accept: ["image/*", "video/*", ".pdf"],   // what every store takes; default below
    // maxFileSize: 5 * 1024 ** 3,               // default 5GB
    imageUrl: ({ url, width }) => `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=75`,
  },
});
```

`s3Storage`는 AWS S3(`endpoint`는 빼고 `region`을 넣어요), Cloudflare R2(`region: "auto"`와 계정의 S3 endpoint), MinIO를 비롯한 S3 호환 서버에서 동작해요. 요청 서명을 직접 하므로(`aws4fetch`) AWS SDK를 설치하지 않아요. 다른 종류의 저장소는 `StorageAdapter`(`./storage`)를 구현해 연결해요.

## CORS

버킷에는 사이트가 `PUT`할 수 있게 하는 CORS 규칙이 있어야 해요. `agent-cms.config.ts`에 같은 `media` 객체를 넣고 실행하세요.

```
npx agent-cms storage check --origin https://your-site.example
```

모든 저장소에 시험 파일을 실제로 올리고, 읽고, 옮기고, 지워요. 조각으로 나눠 올리기와 브라우저 방식의 서명 주소도 확인해요. CORS 규칙을 시험하고, 버킷에 붙여 넣을 규칙을 출력하고, 저장소마다 받는 형식을 보여줘요. `npx agent-cms storage cleanup`은 시작만 하고 끝내지 않은 업로드를 지워요. 그런 업로드가 있으면 `doctor`가 알려줘요.

## 올릴 수 있는 파일

무엇을 받을지는 세 단계로 정해요. 앱 전체는 `media.accept`, 저장소 하나는 `stores.<name>.accept`(앱 전체 목록을 대신해요), 필드 하나는 `admin.fields.<field>.accept`(그 저장소의 목록을 더 좁혀요)예요. 항목은 MIME 형식(`image/png`), 묶음(`image/*`), 확장자(`.pdf`)로 쓰고, `["*/*"]`는 무엇이든 받아요. 정하지 않으면 기본값(`DEFAULT_ACCEPT`)이 이미지, 영상, 소리, PDF, 오피스 문서, 텍스트, ZIP을 받아요. 웹 페이지와 프로그램은 목록에 직접 넣었을 때만 받아요. `maxFileSize`도 같은 세 단계예요.

서버는 업로드를 시작할 때 이름과 선언한 형식을 확인하고, 끝날 때 실제로 도착한 파일의 앞부분을 확인해요. 이름만 `photo.png`인 웹 페이지는 다시 지워요(`asset_type_mismatch`).

## 직접 하는 검사

`media.scan`은 파일이 도착할 때마다 한 번 불려요. 브라우저 업로드가 끝났을 때, 서버가 파일을 가져오거나 저장했을 때, 버킷에 이미 있던 파일을 등록할 때예요. 바이러스 검사나 콘텐츠 정책을 여기에 넣어요.

```ts
media: {
  stores: { /* … */ },
  scan: async ({ url, bytes, name, mime, size }) => {
    // `url`: a signed address that works for 10 minutes. `bytes` instead when the CMS holds the file in memory.
    const verdict = await myScanner.check(url ?? bytes);
    return verdict.clean ? true : { ok: false, reason: verdict.name };
  },
},
```

거부한 파일은 저장소에서 지워지고 쓸 수 없어요(등록하려던 파일은 있던 자리에 그대로 둬요). 호출한 쪽은 `asset_rejected`를 받고, 감사 로그에 이유가 남아요. 검사 함수가 오류를 던져도 거부예요.

## 문서 안에서

파일은 id로 가리켜요. 그래서 옮기거나 이름을 바꿔도 페이지가 깨지지 않아요.

```md
![The new dashboard](asset:8k2m4x9pq1zt/dashboard.png "Caption under the picture")

Read [the full report](asset:r7w2k9m4x1pa/report-2026.pdf).
```

한 줄을 통째로 차지한 이미지 문법은 미디어 블록이에요. 파일 형식에 따라 사진, 영상 플레이어, 다운로드 카드가 돼요. `![alt](https://…)`는 바깥 이미지를 보여줘요. 필드에는 `image`나 `file` 위젯을 쓰고, 값은 파일의 id예요.

```ts
import { assetId } from "@mainsoft/agent-cms";

fields: z.object({ cover: assetId().optional(), brochure: assetId().optional() }),
admin: { fields: { cover: { widget: "image" }, brochure: { widget: "file", accept: [".pdf"], maxFileSize: 20 * 1024 ** 2 } } },
media: { requireAlt: true },   // an image without alt text stops a save (default: a warning)
```

저장할 때 문서가 가리키는 파일을 확인해요. 없는 파일이거나 필드와 종류가 맞지 않으면 오류예요. 대체 텍스트가 없거나 공개 문서에 비공개 파일이 있으면 경고예요.

## 내 페이지에서

문서가 쓰는 파일을 받아서, 전처럼 블록 트리를 그리면 돼요.

```ts
const doc = await cms.get(anon, "posts", slug);
const files = await cms.assetsFor(doc);        // { [id]: { url, width, height, alt, kind, mime, … } }
const cover = files[doc.fields.cover];
<img src={cms.imageUrl(cover, { width: 1200 })} width={cover.width} height={cover.height} alt={cover.alt} />
```

`parseMarkdown`은 `{ t: "media", asset, alt, caption }` 블록을 줘요. `asset`을 `files`에서 찾으세요. CMS는 원본만 보관해요. 크기 바꾸기는 `media.imageUrl`을 통해 프레임워크나 CDN이 맡아요.

## 누가 무엇을 할 수 있나

파일 목록 보기와 비공개 파일 열기는 로그인한 사람과 키가 할 수 있어요. 올리기, 가져오기, 대체 텍스트, 태그, 새 폴더는 관리자와 `write` 키가 해요. 옮기기, 이름 바꾸기, 삭제는 관리자와 `publish` 키가 해요. 저장소의 `access: { read, write, delete }`로 셋 중 무엇이든 바꿀 수 있어요. 문서가 쓰고 있는 파일을 지우려 하면 `asset_in_use`와 문서 목록이 돌아오고, 확인해야 지워져요. 올리기, 옮기기, 삭제는 감사 로그에 남아요.

파일 경로는 `GET /api/cms/files/<id>/<name>`이에요. 권한을 확인한 뒤 공개 주소나 잠깐만 유효한 서명 주소(`media.linkTtlSeconds`, 기본 300초)로 보내요. 핸들러가 `/api/cms`가 아닌 곳에 있으면 `media.filesUrl`을 정하세요.

## 어드민에서

화면을 추가하고(`npx agent-cms add cms-media`) 페이지를 만들어요. 앱에 라이브러리가 있으면 사이드바에 "미디어"가 저절로 보여요.

```tsx
// app/admin/media/page.tsx
"use client";
import { CmsMedia } from "@/components/cms/cms-media";
export default function MediaPage() {
  return <CmsMedia />;
}
```

브라우저는 파일을 저장소로 바로 보내요. 큰 파일은 조각 네 개씩 보내고, 실패한 조각은 세 번까지 다시 시도해요. "다시 시도"는 아직 못 보낸 조각만 보내요. 이미지와 영상은 라이브러리에 쓸 작은 그림(480px, WebP)도 만들고, 너비와 높이와 길이를 읽어요. "URL에서 가져오기"는 공개 https 주소의 파일을 열려 있는 폴더로 가져와요(내부망 주소는 에이전트와 똑같이 거부해요). 파일 패널의 연필은 이름을 바꿔요. 확장자는 그대로라서 형식이 바뀌지 않아요. 자세한 것은 [미디어 화면](/components/cms-media)에 있어요.

## 에이전트와 CLI

앱에 미디어 라이브러리가 있으면 에이전트 도구가 여섯 개 늘어요. `list_assets`, `get_asset`(read), `import_asset`(https 주소의 파일을 라이브러리로 가져와요. 내부망 주소는 거부해요), `update_asset`(write), `move_asset`, `delete_asset`(publish)이에요. 터미널에서는 이렇게 올려요.

```
npx agent-cms upload ./hero.png ./talk.mp4 --folder launch --alt "The launch screen" --tag launch
```

## 버킷 전체

라이브러리는 CMS가 아는 파일을 보여줘요. [파일 관리자](/docs/file-manager)는 버킷을 있는 그대로 보여줘요.
