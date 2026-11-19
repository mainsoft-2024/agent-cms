import { extractToc, parseMarkdown } from "@mainsoft/agent-cms/markdown";
import type { CmsDoc } from "@mainsoft/agent-cms";
import { FileCode2, History } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "./code-block";
import { Markdown } from "./markdown";
import { collectionFor, docHref, docsNav, publicVersions, publishedDoc, type Lang, type NavGroup, filesOf } from "@/lib/content";

const T = {
  en: { onThisPage: "On this page", copyMd: "Copy as markdown", viewMd: "View as markdown", history: "Version history", updated: "Updated", by: "by", version: "Version", docs: "Docs", agent: "agent" },
  ko: { onThisPage: "이 페이지", copyMd: "마크다운 복사", viewMd: "마크다운으로 보기", history: "버전 기록", updated: "수정", by: "편집", version: "버전", docs: "문서", agent: "에이전트" },
};

function fmtDate(iso: string, lang: Lang) {
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Seoul" }).format(new Date(iso));
}

const SECTION_KO: Record<string, string> = { "Get started": "시작하기", Guides: "가이드", Agents: "에이전트", "Admin screens": "어드민 화면", Reference: "참고", Upgrade: "업그레이드" };
const sectionLabel = (s: string, lang: Lang) => (lang === "ko" ? (SECTION_KO[s] ?? s) : s);

function SideNav({ nav, lang, current }: { nav: NavGroup[]; lang: Lang; current: string }) {
  return (
    <nav aria-label={T[lang].docs} className="text-[14px]">
      {nav.map((g) => (
        <div key={g.section}>
          <p className="label-mono mt-5 mb-2">{sectionLabel(g.section, lang)}</p>
          {g.items.map((it) => (
            <Link
              key={it.slug}
              href={docHref(lang, it.slug)}
              aria-current={it.slug === current ? "page" : undefined}
              className={`-ml-2.5 block rounded-[6px] px-2.5 py-1 ${it.slug === current ? "bg-white font-medium text-black shadow-[var(--hair)]" : "text-[var(--graphite)] hover:text-black"}`}
            >
              {it.title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Who wrote the latest public version. Agents (API keys) get the violet pill. */
function Editor({ doc, lang }: { doc: CmsDoc; lang: Lang }) {
  if (!doc.updatedBy) return null;
  if (doc.updatedByKind === "key")
    return (
      <span className="pill pill-agent">
        <span className="dot" />
        {doc.updatedBy} ({T[lang].agent})
      </span>
    );
  return (
    <span>
      {T[lang].by} {doc.updatedBy}
    </span>
  );
}

export async function DocPage({ lang, slug }: { lang: Lang; slug: string }) {
  const t = T[lang];
  const collection = collectionFor(lang);
  const [doc, nav] = await Promise.all([publishedDoc(collection, slug), docsNav(lang)]);
  if (!doc) notFound();
  const english = lang === "ko" ? await publishedDoc("docs", slug) : null;
  const sourceVersion = Number((doc.fields as { sourceVersion?: number }).sourceVersion ?? 0);
  const stale = english && english.publishedVersion !== null && sourceVersion > 0 && english.publishedVersion > sourceVersion;
  const toc = extractToc(parseMarkdown(doc.body));
  const [versions, files] = await Promise.all([publicVersions(doc), filesOf(doc)]);
  const md = `# ${doc.title}\n\n${doc.summary ? `${doc.summary}\n\n` : ""}${doc.body}\n`;
  const mdHref = `${docHref(lang, slug)}.md`;

  return (
    <div className="mx-auto grid max-w-[1440px] grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)_208px]">
      <aside aria-label={t.docs} className="hidden px-10 pt-2 pb-6 lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-4 pb-6">
          <SideNav nav={nav} lang={lang} current={slug} />
        </div>
      </aside>

      <article className="min-w-0 px-5 pt-2 pb-16 md:px-12">
        <details className="site-card mb-5 px-4 py-2.5 lg:hidden">
          <summary className="cursor-pointer font-medium">
            {doc.category ? sectionLabel(doc.category, lang) : t.docs} / {doc.title}
          </summary>
          <div className="pb-2">
            <SideNav nav={nav} lang={lang} current={slug} />
          </div>
        </details>

        <p className="mono mb-3 text-[12px] text-[var(--charcoal-trace)]">
          {doc.category ? sectionLabel(doc.category, lang) : t.docs} / {slug}
        </p>
        <h1 className="display d32 mb-2">{doc.title}</h1>
        {doc.summary ? <p className="mb-5 max-w-[620px] text-[16px] text-[var(--pencil-gray)]">{doc.summary}</p> : null}

        {stale ? (
          <div className="callout max-w-[640px]" role="note">
            <span className="callout-bar" aria-hidden />
            <p className="!mb-0">
              영어 문서가 더 최신이에요 (영어 v{english.publishedVersion}, 이 번역은 v{sourceVersion} 기준).{" "}
              <Link href={`/docs/${slug}`} className="link">
                영어로 보기
              </Link>
            </p>
          </div>
        ) : null}

        <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-[var(--line)] pt-2.5 pb-4 text-[12px] text-[var(--pencil-gray)]">
          <span>
            {t.updated} {fmtDate(doc.updatedAt, lang)}
          </span>
          <span className="h-3 w-px bg-[var(--line)]" aria-hidden />
          <Editor doc={doc} lang={lang} />
          <span className="h-3 w-px bg-[var(--line)]" aria-hidden />
          <span className="mono">
            {t.version} {doc.publishedVersion}
          </span>
        </div>

        {toc.length > 1 ? (
          <details className="site-card mb-6 px-4 py-2.5 xl:hidden">
            <summary className="cursor-pointer font-medium">{t.onThisPage}</summary>
            <ul className="mt-2 space-y-1 pb-1">
              {toc.map((h) => (
                <li key={h.id} className={h.level === 3 ? "pl-3" : ""}>
                  <a href={`#${h.id}`} className="text-[var(--pencil-gray)] hover:text-black">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="max-w-[720px]">
          <Markdown source={doc.body} lang={lang} files={files} />
        </div>
      </article>

      <aside aria-label={t.onThisPage} className="hidden pt-4 pr-10 xl:block">
        <div className="sticky top-20 text-[13px]">
          {toc.length ? (
            <>
              <p className="label-mono mb-2.5">{t.onThisPage}</p>
              <ul>
                {toc.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className={`block border-l border-[var(--line)] py-[3px] text-[var(--pencil-gray)] hover:text-black ${h.level === 3 ? "pl-6" : "pl-3"}`}>
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="mt-6 flex flex-col items-start gap-2 text-[var(--pencil-gray)]">
            <CopyButton text={md} label={t.copyMd} className="!px-0" />
            <a href={mdHref} className="inline-flex items-center gap-1 text-[12px] hover:text-black">
              <FileCode2 className="size-3.5" aria-hidden /> {t.viewMd}
            </a>
            <details className="text-[12px]">
              <summary className="inline-flex cursor-pointer items-center gap-1 hover:text-black">
                <History className="size-3.5" aria-hidden /> {t.history}
              </summary>
              <ul className="mt-2 space-y-1">
                {versions.map((v) => (
                  <li key={v.version} className="mono">
                    v{v.version} {fmtDate(v.createdAt, lang)} {v.authorLabel}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </aside>
    </div>
  );
}

