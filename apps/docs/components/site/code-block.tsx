"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[12px] text-[var(--pencil-gray)] hover:text-black ${className}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={done ? "Copied" : label}
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {done ? "Copied" : label}
    </button>
  );
}

const MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
type Manager = (typeof MANAGERS)[number];

/** `npm i x` / `npx y` in the other package managers. */
function convert(cmd: string, to: Manager): string {
  if (to === "npm") return cmd;
  return cmd
    .split("\n")
    .map((line) => {
      const install = /^npm (?:i|install)(?: (.*))?$/.exec(line.trim());
      if (install) {
        const args = install[1] ?? "";
        if (!args) return to === "yarn" ? "yarn" : `${to} install`;
        const dev = /(^| )(-D|--save-dev)( |$)/.test(args);
        const pkgs = args.replace(/(^| )(-D|--save-dev)( |$)/, " ").trim();
        if (to === "yarn") return `yarn add${dev ? " -D" : ""} ${pkgs}`;
        if (to === "bun") return `bun add${dev ? " -d" : ""} ${pkgs}`;
        return `pnpm add${dev ? " -D" : ""} ${pkgs}`;
      }
      const npx = /^npx (?:--yes )?(.*)$/.exec(line.trim());
      if (npx) return to === "pnpm" ? `pnpm dlx ${npx[1]}` : to === "yarn" ? `yarn dlx ${npx[1]}` : `bunx ${npx[1]}`;
      return line;
    })
    .join("\n");
}

/** Shell commands that start with npm/npx get package-manager tabs. */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const managed = (lang === "sh" || lang === "bash" || lang === "") && /^(npm|npx) /m.test(code) && code.split("\n").every((l) => !l.trim() || /^(npm|npx) /.test(l.trim()));
  const [pm, setPm] = useState<Manager>("npm");
  const shown = managed ? convert(code, pm) : code;
  return (
    <div className="code">
      <div className="code-bar">
        {managed ? (
          <div role="tablist" aria-label="Package manager" className="flex gap-1">
            {MANAGERS.map((m) => (
              <button key={m} role="tab" type="button" aria-selected={pm === m} className="code-tab" onClick={() => setPm(m)}>
                {m}
              </button>
            ))}
          </div>
        ) : (
          <span className="mono">{lang || "text"}</span>
        )}
        <CopyButton text={shown} className="ml-auto" />
      </div>
      <pre tabIndex={0}>
        <code>{shown}</code>
      </pre>
    </div>
  );
}
