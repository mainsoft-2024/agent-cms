#!/usr/bin/env bash
# Install the admin screens the way a new user would: a fresh Next.js app,
# `shadcn init`, then `npx shadcn add <registry-url>/<item>.json` against the
# registry built by `build-registry --base-url`, served locally. The package
# itself comes from the packed tarball (not yet on npm when this runs in a PR).
# Then type-check and build the app. Run after `npm run build`.
#
#   bash scripts/shadcn-smoke.sh            # registry from this checkout
#   REGISTRY_URL=https://site/r bash scripts/shadcn-smoke.sh   # a deployed registry
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
PORT="${PORT:-4199}"
# shadcn's component library: base (Base UI, the shadcn default) or radix.
BASE="${BASE:-base}"
ITEMS="${ITEMS:-cms-shell cms-doc-list cms-doc-editor cms-versions cms-keys cms-audit cms-command cms-redirects cms-forms cms-form}"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; [ -z "${KEEP:-}" ] && rm -rf "$WORK"; [ -n "${TARBALL:-}" ] && rm -f "$TARBALL"; }
trap cleanup EXIT

cd "$ROOT"
TARBALL="$ROOT/$(npm pack --silent | tail -n 1)"

if [ -z "${REGISTRY_URL:-}" ]; then
  REGISTRY_URL="http://127.0.0.1:$PORT/r"
  npx tsx scripts/build-registry.ts --base-url "$REGISTRY_URL" --out "$WORK/site/r" --range "file:$TARBALL"
  node -e '
    const http = require("http"), fs = require("fs"), path = require("path");
    const root = process.argv[1];
    http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      fs.createReadStream(p).pipe(res);
    }).listen(Number(process.argv[2]), "127.0.0.1");
  ' "$WORK/site" "$PORT" &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -sf "$REGISTRY_URL/registry.json" >/dev/null && break; sleep 0.1; done
fi
curl -sf "$REGISTRY_URL/registry.json" >/dev/null

cd "$WORK"
npx --yes create-next-app@latest app --ts --tailwind --app --no-eslint --no-src-dir --import-alias "@/*" --use-npm --yes --skip-install >/dev/null
cd app
npm install --no-audit --no-fund >/dev/null
# The tarball first, so `shadcn add` finds the package already installed.
npm install --no-audit --no-fund "$TARBALL" drizzle-orm zod >/dev/null
# stdin from /dev/null: init must never wait on a prompt.
npx --yes shadcn@latest init --yes --base "$BASE" --preset nova --force </dev/null >/dev/null

for item in $ITEMS; do
  npx --yes shadcn@latest add --yes --overwrite "$REGISTRY_URL/$item.json" </dev/null
done

for f in use-cms.ts cms-messages.ts cms-parts.tsx cms-shell.tsx cms-doc-list.tsx cms-empty.tsx cms-doc-editor.tsx cms-merge.tsx cms-field-form.tsx; do
  test -f "components/cms/$f" || { echo "missing components/cms/$f"; exit 1; }
done

# A page that uses the screens, so `next build` compiles them.
mkdir -p app/admin
cat > app/admin/page.tsx <<'EOF'
"use client";

import { useState } from "react";
import { CmsCommand } from "@/components/cms/cms-command";
import { CmsDocEditor } from "@/components/cms/cms-doc-editor";
import { CmsDocList } from "@/components/cms/cms-doc-list";
import { CmsShell } from "@/components/cms/cms-shell";
import { CmsProvider } from "@/components/cms/use-cms";

export default function Admin() {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  return (
    <CmsProvider baseUrl="/api/cms">
      <CmsShell title="Smoke" onSearch={() => setOpen(true)}>
        {slug ? (
          <CmsDocEditor collection="posts" slug={slug} onBack={() => setSlug(null)} />
        ) : (
          <CmsDocList collection="posts" onOpenDocument={(_c, s) => setSlug(s)} />
        )}
      </CmsShell>
      <CmsCommand open={open} onOpenChange={setOpen} onOpenDocument={(_c, s) => setSlug(s)} />
    </CmsProvider>
  );
}
EOF

npx next typegen >/dev/null 2>&1 || true
npx tsc --noEmit
npx next build >/dev/null
echo "shadcn smoke ok (base $BASE, next $(node -p 'require("next/package.json").version'), registry $REGISTRY_URL)"
