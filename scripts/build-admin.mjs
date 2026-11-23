// Builds the admin that `serve` and `dev` hand out: dist/admin/{index.html, app-<hash>.js, app-<hash>.css, chunks}.
// The registry screens (registry/cms) with the ui parts in admin/components/ui.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist/admin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// "@/components/cms/x" → registry/cms/x, "@/components/ui/x" → admin/components/ui/x, "@/lib/utils" → admin/lib/utils.
const alias = {
  name: "alias",
  setup(b) {
    b.onResolve({ filter: /^@\/components\/cms\// }, (a) => ({ path: resolveTs(join(root, "registry/cms", a.path.slice("@/components/cms/".length))) }));
    b.onResolve({ filter: /^@\/(components\/ui|lib)\// }, (a) => ({ path: resolveTs(join(root, "admin", a.path.slice(2))) }));
    b.onResolve({ filter: /^@mainsoft\/agent-cms\/client$/ }, () => ({ path: join(root, "src/client.ts") }));
    b.onResolve({ filter: /^@mainsoft\/agent-cms\/(markdown|html-inspect|diff|types)$/ }, (a) => ({ path: join(root, `src/${a.path.split("/").pop()}.ts`) }));
    b.onResolve({ filter: /^@mainsoft\/agent-cms\/messages\/(en|ko)$/ }, (a) => ({ path: join(root, `src/messages/${a.path.split("/").pop()}.ts`) }));
  },
};
function resolveTs(p) {
  for (const ext of [".tsx", ".ts", "/index.ts"]) {
    try {
      if (statSync(p + ext).isFile()) return p + ext;
    } catch {}
  }
  return p;
}

await build({
  entryPoints: { app: join(root, "admin/main.tsx") },
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: out,
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  minify: true,
  sourcemap: false,
  target: "es2020",
  jsx: "automatic",
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [alias],
  logLevel: "warning",
});

// Tailwind reads the screens and writes the styles.
const cssTmp = join(out, "app.css");
execFileSync(join(root, "node_modules/.bin/tailwindcss"), ["-c", join(root, "admin/tailwind.config.ts"), "-i", join(root, "admin/app.css"), "-o", cssTmp, "--minify"], { cwd: root, stdio: "pipe" });
const css = readFileSync(cssTmp);
const cssName = `app-${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
renameSync(cssTmp, join(out, cssName));

const js = readdirSync(out).find((f) => /^app-.*\.js$/.test(f));
writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin</title>
<link rel="stylesheet" href="./${cssName}">
<!--settings-->
<script>try{var t=localStorage.getItem("cms-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="./${js}"></script>
</body>
</html>
`
);
let total = 0;
for (const f of readdirSync(out)) total += statSync(join(out, f)).size;
console.log(`[agent-cms] admin: ${readdirSync(out).length} files, ${(total / 1024).toFixed(0)} KB in dist/admin`);
