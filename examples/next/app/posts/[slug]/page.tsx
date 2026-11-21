import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isCmsError } from "@mainsoft/agent-cms";
import { CmsPreviewComments } from "@/components/cms/cms-preview-comments";
import { PostBody } from "@/components/post-body";
import { cms, seed } from "@/lib/cms";

export const dynamic = "force-dynamic";

type Props = { params: { slug: string }; searchParams: { cms_preview?: string } };

/** The draft a preview link shows, only on the page it was made for (a token for post A never shows on /posts/b). */
async function previewFor(slug: string, token: string | undefined) {
  if (!token) return null;
  const p = await cms.readPreview(token);
  return p.collection === "posts" && p.slug === slug ? p : null;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  await seed();
  try {
    const preview = await previewFor(params.slug, searchParams.cms_preview).catch(() => null);
    const doc = preview ? preview.doc : await cms.get({ kind: "anonymous" }, "posts", params.slug);
    const files = await cms.assetsFor({ collection: "posts", body: "", fields: doc.fields });
    const cover = typeof doc.fields.cover === "string" ? files[doc.fields.cover] : null;
    // Crawlers fetch og:image without cookies: only a public, absolute address works there.
    const image = cover && cover.visibility === "public" && /^https?:\/\//.test(cms.imageUrl(cover, { size: "card" })) ? cms.imageUrl(cover, { size: "card" }) : undefined;
    return {
      title: doc.title,
      description: doc.summary || undefined,
      openGraph: { title: doc.title, description: doc.summary || undefined, images: image ? [{ url: image, alt: cover?.alt || doc.title }] : undefined },
      // A draft preview is for the people who got the link, not for search engines.
      robots: preview ? { index: false, follow: false } : undefined,
      referrer: preview ? "no-referrer" : undefined,
    };
  } catch {
    return {};
  }
}

// The public page. A draft preview link adds ?cms_preview=<token>.
export default async function Post({ params, searchParams }: Props) {
  await seed();
  try {
    const token = searchParams.cms_preview;
    const preview = await previewFor(params.slug, token);
    const doc = preview ? preview.doc : await cms.get({ kind: "anonymous" }, "posts", params.slug);
    const files = await cms.assetsFor({ collection: "posts", body: doc.body, fields: doc.fields });
    const cover = typeof doc.fields.cover === "string" ? files[doc.fields.cover] : null;
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-8">
        {preview ? (
          <p role="status" className="rounded bg-amber-100 px-3 py-2 text-sm">
            Draft preview
          </p>
        ) : null}
        <h1 className="text-3xl font-semibold">{doc.title}</h1>
        {doc.summary ? <p className="text-muted-foreground">{doc.summary}</p> : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {cover ? <img data-cover="" src={cms.imageUrl(cover, { size: "card" })} alt={cover.alt} width={800} height={450} className="aspect-video h-auto w-full rounded object-cover" style={cover.focal ? { objectPosition: `${cover.focal.x * 100}% ${cover.focal.y * 100}%` } : undefined} /> : null}
        <PostBody body={doc.body} files={files} imageSrc={(f) => cms.imageUrl(f, { size: "full" })} />
        {/* A preview link made with "Allow comments" lets the reader comment without an account. */}
        {token && preview?.comments ? <CmsPreviewComments token={token} /> : null}
      </main>
    );
  } catch (e) {
    if (isCmsError(e) && (e.kind === "not_found" || e.kind === "unauthorized")) notFound();
    throw e;
  }
}
