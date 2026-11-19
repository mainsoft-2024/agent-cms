import { ArrowRight, ChevronRight, GitMerge, PanelsTopLeft, Plug } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/site/code-block";
import { listPublished } from "@/lib/content";

const INSTALL = "npm i @mainsoft/agent-cms";

/** The headline: rotating first word, "Serverless" in ink gradient, typed "agents", highlighted "humans". */
function Headline() {
  return (
    <div className="hero-grid mt-11 mb-6">
      <span className="marks" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <h1 className="display d48 hl hero-title" aria-label="Lightweight, feature-rich, all-in-one serverless CMS for agents and humans">
        <span aria-hidden>
          <span className="ln rot">
            <span className="rot-track">
              <span>Lightweight</span>
              <span>Feature-rich</span>
              <span>All-In-One</span>
              <span>Lightweight</span>
            </span>
          </span>
          <span className="ln">
            <span className="grad">Serverless</span> CMS for
          </span>
          <span className="ln">
            <span className="ag">
              <span className="typed">agents</span>
            </span>{" "}
            and <span className="hi">humans</span>
          </span>
        </span>
      </h1>
    </div>
  );
}

/** A still picture of the admin editor with an agent change waiting for review. */
function EditorShot({ compact = false }: { compact?: boolean }) {
  return (
    <div className="site-card overflow-hidden text-[13px]" role="img" aria-label="The agent-cms editor: a block written by docs-bot waits for Accept or Revert">
      <div className={compact ? "flex flex-col" : "grid h-[430px] grid-cols-[180px_1fr]"}>
        {compact ? null : (
          <div className="flex flex-col gap-0.5 bg-[var(--drafting-gray)] px-2.5 py-3.5">
            <div className="mb-2 flex px-2 py-1 font-semibold">Docs admin</div>
            {[
              ["Docs", "24", true],
              ["Docs (KO)", "24", false],
              ["Changelog", "12", false],
              ["API keys", "", false],
              ["Audit log", "", false],
            ].map(([l, n, on]) => (
              <div key={String(l)} className={`flex rounded-[6px] px-2 py-1.5 ${on ? "bg-white font-medium shadow-[var(--hair)]" : "text-[var(--graphite)]"}`}>
                {l}
                <span className="mono ml-auto text-[11px] text-[var(--charcoal-trace)]">{n}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] px-4 py-3">
            <span className="text-[var(--pencil-gray)]">Get started /</span>
            <b>Install</b>
            <span className="pill pill-white">
              <span className="dot" />
              Published
            </span>
            <span className="pill pill-agent">
              <span className="dot" />2 agent changes
            </span>
            {compact ? null : (
              <>
                <span className="flex-1" />
                <span className="btn btn-outline !px-3 !py-1 text-[13px]">Accept all</span>
                <span className="btn btn-primary !px-3 !py-1 text-[13px]">Publish</span>
              </>
            )}
          </div>
          <div className={compact ? "" : "grid flex-1 grid-cols-2"}>
            <div className={`mono px-4 py-4 text-[12.5px] leading-[1.75] text-[var(--graphite)] ${compact ? "" : "border-r border-[var(--line)]"}`}>
              ## Install
              <br />
              <br />
              npm i @mainsoft/agent-cms
              <br />
              npx agent-cms init
              <div className="agent-block -mx-2 my-1.5 px-2 py-1.5">
                Peer dependencies: drizzle-orm, zod
                <br />
                (^3.25 or ^4), and ai for ./ai.
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5" style={{ fontFamily: "var(--site-sans)" }}>
                  <span className="pill pill-agent">
                    <span className="dot" />
                    docs-bot, 2 min ago
                  </span>
                  <span className="btn btn-outline !px-3 !py-0.5 text-[12px]">Accept</span>
                  <span className="px-1 text-[12px] text-[var(--pencil-gray)]">Revert</span>
                </div>
              </div>
              {compact ? null : (
                <>
                  ## Tables
                  <br />
                  npx agent-cms migrate check
                </>
              )}
            </div>
            {compact ? null : (
              <div className="px-5 py-4">
                <p className="mb-1.5 text-[18px] font-semibold">Install</p>
                <p className="text-[var(--graphite)]">
                  Run <code className="inline-code">npx agent-cms init</code>. It writes the config, the route and a schema re-export.
                </p>
                <p className="mt-3.5 mb-1 font-semibold">Peer dependencies</p>
                <p className="text-[var(--graphite)]">
                  <mark className="hit">drizzle-orm, zod (^3.25 or ^4)</mark>, and ai for ./ai.
                </p>
                <p className="mt-3.5 mb-1 font-semibold">Tables</p>
                <p className="text-[var(--pencil-gray)]">migrate check prints what is missing as SQL.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function Home() {
  const latest = (await listPublished("changelog")).sort((a, b) => String((b.fields as { date?: string }).date).localeCompare(String((a.fields as { date?: string }).date)))[0];
  return (
    <>
      <section className="px-5 pt-10 text-center md:px-10">
        {latest ? (
          <Link href={`/changelog#${latest.slug}`} className="inline-flex items-center gap-2 rounded-[6px] bg-black px-3 py-1.5 text-[13px] font-medium text-white">
            {latest.title}
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
        <Headline />
        <p className="mx-auto mb-7 max-w-[560px] text-[16px] text-[var(--pencil-gray)]">
          Add it to your Next.js app and Postgres. People edit in the admin screens; agents edit the same documents through MCP, AI SDK tools, the CLI and REST.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <span className="mono inline-flex items-center gap-2 rounded-[6px] bg-white py-1.5 pr-1.5 pl-3.5 text-[13px] shadow-[var(--hair)]">
            <span className="text-[var(--charcoal-trace)]">$</span> {INSTALL}
            <CopyButton text={INSTALL} label="Copy" />
          </span>
          <Link href="/docs" className="btn btn-primary">
            Get started <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </section>

      <div className="relative mx-auto mt-12 hidden max-w-[1040px] px-5 md:block lg:px-0">
        <EditorShot />
        <div className="absolute top-[120px] -right-10 flex w-[300px] flex-col gap-3 max-xl:right-4">
          <div className="callnote">
            <h3>See what agents changed</h3>
            <p>Every block an agent wrote waits for a person to accept or revert it.</p>
          </div>
          <div className="callnote">
            <h3>This site runs on it</h3>
            <p>These docs are agent-cms documents, edited the same way.</p>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-[560px] space-y-3 px-5 md:hidden">
        <EditorShot compact />
        <div className="callnote">
          <h3>See what agents changed</h3>
          <p>Every block an agent wrote waits for a person to accept or revert it.</p>
        </div>
      </div>

      <section className="mx-auto mt-20 grid max-w-[1040px] gap-4 px-5 pb-20 md:grid-cols-3 lg:px-0" aria-label="Features">
        <div className="site-card p-6">
          <Plug className="size-5 text-[var(--indigo-ink)]" aria-hidden />
          <h2 className="mt-3 mb-1.5 text-[16px] font-semibold">Four ways in for agents</h2>
          <p className="text-[var(--pencil-gray)]">One tool list, scoped by API key.</p>
          <div className="mono mt-3.5 grid grid-cols-2 gap-1.5 text-[12px]">
            {["MCP", "AI SDK", "CLI", "REST"].map((w) => (
              <span key={w} className="rounded-[6px] bg-[var(--drafting-gray)] px-2 py-1.5">
                {w}
              </span>
            ))}
          </div>
        </div>
        <div className="site-card p-6">
          <PanelsTopLeft className="size-5 text-[var(--indigo-ink)]" aria-hidden />
          <h2 className="mt-3 mb-1.5 text-[16px] font-semibold">Admin screens you own</h2>
          <p className="text-[var(--pencil-gray)]">Copy nine screens into your app with shadcn, then change anything.</p>
          <div className="mono mt-3.5 text-[12px]">
            <Link href="/components" className="block rounded-[6px] bg-[var(--drafting-gray)] px-2 py-1.5">
              npx shadcn add …/r/cms-shell.json
            </Link>
          </div>
        </div>
        <div className="site-card p-6">
          <GitMerge className="size-5 text-[var(--indigo-ink)]" aria-hidden />
          <h2 className="mt-3 mb-1.5 text-[16px] font-semibold">No lost edits</h2>
          <p className="text-[var(--pencil-gray)]">Versions, line-by-line merge, autosave and draft preview links.</p>
          <div className="mono mt-3.5 grid grid-cols-2 gap-1.5 text-[12px]">
            {["If-Match", "merge3"].map((w) => (
              <span key={w} className="rounded-[6px] bg-[var(--drafting-gray)] px-2 py-1.5">
                {w}
              </span>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
