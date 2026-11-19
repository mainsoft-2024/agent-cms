"use client";

import { FileText, Hash, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Hit {
  collection: string;
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  heading: string;
  anchor: string;
}

const T = {
  en: { button: "Search docs", placeholder: "Search the docs", empty: "Nothing found. We note the question so the docs can answer it.", hint: "Type to search. Results are sections of published pages.", open: "open", move: "move" },
  ko: { button: "문서 검색", placeholder: "문서 검색", empty: "찾지 못했어요. 이 질문은 문서를 보완하는 데 쓰여요.", hint: "검색어를 입력하세요. 게시된 문서의 섹션 단위로 찾아요.", open: "열기", move: "이동" },
};

function hrefOf(h: Hit) {
  const base = h.collection === "docs-ko" ? `/ko/docs/${h.slug}` : h.collection === "components" ? `/components/${h.slug}` : h.collection === "changelog" ? `/changelog` : `/docs/${h.slug}`;
  return h.anchor ? `${base}#${h.anchor}` : base;
}

/** Highlight the query words in a line (no HTML injection: React text only). */
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="hit">{p}</mark> : p))}</>;
}

/** ⌘K search over the CMS's own search (`GET /api/cms/search`). */
export function SearchButton({ lang, compact = false }: { lang: "en" | "ko"; compact?: boolean }) {
  const t = T[lang];
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // The header mounts a desktop and a phone button; only one owns the shortcut.
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const cols = lang === "ko" ? "docs-ko,docs" : "docs,components,changelog";
      const res = await fetch(`/api/cms/search?q=${encodeURIComponent(query)}&collections=${cols}&limit=10&miss=1`);
      if (!res.ok) return setHits([]);
      const body = (await res.json()) as { hits: Hit[] };
      setHits(body.hits);
      setActive(0);
    }, 180);
  }, [q, lang]);

  const go = (h: Hit) => {
    setOpen(false);
    setQ("");
    router.push(hrefOf(h));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={compact ? t.button : undefined}
        aria-keyshortcuts="Control+K Meta+K"
        className={compact ? "grid size-8 place-items-center text-[var(--pencil-gray)]" : "flex w-60 items-center gap-2 rounded-[6px] bg-white px-2.5 py-1.5 text-left text-[var(--charcoal-trace)] shadow-[var(--hair)]"}
      >
        <Search className="size-4" aria-hidden />
        {compact ? null : (
          <>
            <span className="flex-1">{t.button}</span>
            <span className="kbd" aria-hidden>⌘K</span>
          </>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">{t.button}</DialogTitle>
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
            <Search className="size-4 text-[var(--pencil-gray)]" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (!hits?.length) return;
                if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
                if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
                if (e.key === "Enter") (e.preventDefault(), go(hits[active]));
              }}
              placeholder={t.placeholder}
              aria-label={t.placeholder}
              role="combobox"
              aria-expanded={!!hits?.length}
              aria-controls="search-results"
              className="flex-1 bg-transparent text-[15px] outline-none"
            />
            <span className="kbd">esc</span>
          </div>
          <div id="search-results" role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
            {hits === null ? (
              <p className="px-3 py-6 text-center text-[var(--pencil-gray)]">{t.hint}</p>
            ) : hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-[var(--pencil-gray)]">{t.empty}</p>
            ) : (
              hits.map((h, i) => (
                <button
                  key={`${h.collection}/${h.slug}#${h.anchor}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`flex w-full items-start gap-3 rounded-[6px] px-3 py-2.5 text-left ${i === active ? "bg-[var(--drafting-gray)]" : ""}`}
                >
                  {h.anchor ? <Hash className="mt-0.5 size-4 shrink-0 text-[var(--charcoal-trace)]" aria-hidden /> : <FileText className="mt-0.5 size-4 shrink-0 text-[var(--charcoal-trace)]" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      <Marked text={h.heading && h.heading !== h.title ? `${h.title} › ${h.heading}` : h.title} q={q} />
                    </span>
                    {h.summary ? (
                      <span className="block truncate text-[13px] text-[var(--pencil-gray)]">
                        <Marked text={h.summary} q={q} />
                      </span>
                    ) : null}
                    <span className="mono mt-0.5 block text-[11px] text-[var(--charcoal-trace)]">
                      cms://{h.collection}/{h.slug}
                      {h.anchor ? `#${h.anchor}` : ""}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="flex gap-4 border-t border-[var(--line)] px-4 py-2 text-[12px] text-[var(--pencil-gray)]">
            <span>
              <span className="kbd">↵</span> {t.open}
            </span>
            <span>
              <span className="kbd">↑↓</span> {t.move}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
