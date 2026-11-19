"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SearchButton } from "./search-dialog";

/** GitHub mark (lucide dropped brand icons). */
function Github({ className }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export const GITHUB_URL = "https://github.com/mainsoft-2024/agent-cms";

const NAV = [
  { href: "/docs", ko: "/ko/docs", label: "Docs", labelKo: "문서" },
  { href: "/components", ko: "/components", label: "Components", labelKo: "화면" },
  { href: "/agents", ko: "/agents", label: "Agents", labelKo: "에이전트" },
  { href: "/changelog", ko: "/changelog", label: "Changelog", labelKo: "변경 기록" },
];

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold text-black">
      <span aria-hidden className="mono grid size-[22px] place-items-center rounded-[4px] border-[1.5px] border-black text-[10px] font-medium tracking-[-0.04em]">
        ac
      </span>
      agent-cms
    </Link>
  );
}

/** The other language's address for the current page (docs only; other pages are English). */
function swapLang(path: string, to: "en" | "ko") {
  if (to === "ko") return path.startsWith("/docs") ? `/ko${path}` : "/ko/docs";
  return path.startsWith("/ko/") ? path.slice(3) : path;
}

export function SiteHeader() {
  const path = usePathname();
  const lang = path.startsWith("/ko") ? "ko" : "en";
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  const isOn = (href: string) => path === href || path.startsWith(`${href}/`) || (href === "/docs" && path.startsWith("/ko/docs"));

  return (
    <header className="sticky top-0 z-30 bg-[var(--drafting-gray)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1440px] items-center gap-7 px-5 py-4 md:px-10">
        <Logo />
        <nav aria-label="Main" className="hidden gap-[22px] text-[var(--pencil-gray)] md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={lang === "ko" ? n.ko : n.href} aria-current={isOn(n.href) ? "page" : undefined} className={isOn(n.href) ? "font-medium text-black" : "hover:text-black"}>
              {lang === "ko" ? n.labelKo : n.label}
            </Link>
          ))}
        </nav>
        <span className="flex-1" />
        <div className="hidden md:block">
          <SearchButton lang={lang} />
        </div>
        <div className="hidden gap-0.5 rounded-[6px] bg-white p-0.5 text-[13px] shadow-[var(--hair)] md:flex" role="group" aria-label="Language">
          <Link href={swapLang(path, "en")} aria-current={lang === "en" ? "true" : undefined} className={`rounded-[4px] px-2 py-0.5 ${lang === "en" ? "bg-black text-white" : "text-[var(--pencil-gray)]"}`}>
            EN
          </Link>
          <Link href={swapLang(path, "ko")} aria-current={lang === "ko" ? "true" : undefined} className={`rounded-[4px] px-2 py-0.5 ${lang === "ko" ? "bg-black text-white" : "text-[var(--pencil-gray)]"}`}>
            KO
          </Link>
        </div>
        <a href={GITHUB_URL} className="hidden size-8 place-items-center text-[var(--pencil-gray)] hover:text-black md:grid" aria-label="GitHub">
          <Github className="size-5" aria-hidden />
        </a>
        <div className="flex items-center md:hidden">
          <SearchButton lang={lang} compact />
          <button type="button" className="grid size-8 place-items-center" aria-label={menu ? "Close menu" : "Open menu"} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            {menu ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>
      </div>
      {menu ? <MobileMenu lang={lang} path={path} /> : null}
    </header>
  );
}

function MobileMenu({ lang, path }: { lang: "en" | "ko"; path: string }) {
  return (
    <div className="fixed inset-x-0 top-[64px] bottom-0 z-40 overflow-y-auto bg-[var(--drafting-gray)] px-5 pb-10 md:hidden">
      <nav aria-label="Menu" className="flex flex-col">
        {NAV.map((n) => (
          <Link key={n.href} href={lang === "ko" ? n.ko : n.href} className="display d32 border-b border-[var(--line)] py-4">
            {lang === "ko" ? n.labelKo : n.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6 flex items-center gap-3">
        <div className="flex gap-0.5 rounded-[6px] bg-white p-0.5 text-[13px] shadow-[var(--hair)]">
          <Link href={swapLang(path, "en")} className={`rounded-[4px] px-3 py-1 ${lang === "en" ? "bg-black text-white" : "text-[var(--pencil-gray)]"}`}>
            EN
          </Link>
          <Link href={swapLang(path, "ko")} className={`rounded-[4px] px-3 py-1 ${lang === "ko" ? "bg-black text-white" : "text-[var(--pencil-gray)]"}`}>
            KO
          </Link>
        </div>
        <a href={GITHUB_URL} className="btn btn-outline">
          <Github className="size-4" aria-hidden /> GitHub
        </a>
      </div>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[var(--line)]">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-6 text-[13px] text-[var(--pencil-gray)] md:px-10">
        <span>agent-cms, MIT license</span>
        <a href="https://www.npmjs.com/package/@mainsoft/agent-cms" className="hover:text-black">
          npm
        </a>
        <a href={GITHUB_URL} className="hover:text-black">
          GitHub
        </a>
        <Link href="/llms.txt" className="hover:text-black">
          llms.txt
        </Link>
        <span className="flex-1" />
        <span>These pages are agent-cms documents.</span>
      </div>
    </footer>
  );
}
