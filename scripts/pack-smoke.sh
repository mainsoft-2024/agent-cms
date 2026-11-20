#!/usr/bin/env bash
# Install the packed tarball into a fresh project and use it the way an app
# would: every entry point in ESM and CJS, the CLI, and `add` against the
# shipped registry. Run after `npm run build`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
TARBALL="$ROOT/$(npm pack --silent | tail -n 1)"
trap 'rm -rf "$WORK" "$TARBALL"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm i --no-audit --no-fund "$TARBALL" drizzle-orm@0.45 zod@3.25 >/dev/null

ENTRIES="index http mcp client tools storage storage-s3 storage-vercel-blob image-sharp agent markdown frontmatter types tables cli diff errors config messages/en messages/ko"

cat > esm.mjs <<EOF
const entries = "$ENTRIES".split(" ");
for (const e of entries) {
  const spec = e === "index" ? "@mainsoft/agent-cms" : "@mainsoft/agent-cms/" + e;
  const m = await import(spec);
  if (!Object.keys(m).length) throw new Error("empty module: " + spec);
}
const { createCms, defineCollection, MemoryRepo } = await import("@mainsoft/agent-cms");
const cms = createCms({ repo: new MemoryRepo(), collections: [defineCollection({ slug: "posts", label: "Posts", visibility: "public" })] });
const admin = { kind: "user", id: "u", label: "a", isAdmin: true };
await cms.create(admin, "posts", { slug: "hello", title: "Hello" }, { publish: true });
console.log("esm ok");
EOF
node esm.mjs

cat > cjs.cjs <<EOF
for (const e of "$ENTRIES".split(" ")) {
  const spec = e === "index" ? "@mainsoft/agent-cms" : "@mainsoft/agent-cms/" + e;
  const m = require(spec);
  if (!Object.keys(m).length) throw new Error("empty module: " + spec);
}
console.log("cjs ok");
EOF
node cjs.cjs

# The command the docs give (the full name) and the bin by its own name: both must be the copy
# installed above, not a download.
WANT="$(node -p "require('./node_modules/@mainsoft/agent-cms/package.json').version")"
test "$(npx @mainsoft/agent-cms --version)" = "$WANT"
test "$(npx agent-cms --version)" = "$WANT"
npx @mainsoft/agent-cms add --list | grep -q cms-doc-list
test -f node_modules/@mainsoft/agent-cms/dist/registry/registry.json

# `init` + `add` into a bare shadcn-style app.
mkdir -p app/components/ui app/lib && cd app
echo '{"aliases":{"components":"@/components","ui":"@/components/ui","utils":"@/lib/utils"}}' > components.json
echo '{"compilerOptions":{"paths":{"@/*":["./*"]}}}' > tsconfig.json
npx --prefix .. agent-cms init >/dev/null
npx --prefix .. agent-cms add cms-doc-list >/dev/null
test -f components/cms/cms-doc-list.tsx
test -f agent-cms.json
npx --prefix .. agent-cms migrate print | grep -q 'cms_audit'

# Without the peer dependencies (yarn 1, or peers switched off): the version still prints, and a
# command says which package is missing instead of a Node stack trace.
# (Its own folder, not one under $WORK: Node would find the packages installed there.)
BARE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$TARBALL" "$BARE"' EXIT
cd "$BARE"
npm init -y >/dev/null
npm i --no-audit --no-fund --legacy-peer-deps "$TARBALL" >/dev/null
test ! -d node_modules/drizzle-orm
test "$(./node_modules/.bin/agent-cms --version)" = "$WANT"
if OUT="$(./node_modules/.bin/agent-cms add --list 2>&1)"; then echo "expected a failure without drizzle-orm"; exit 1; fi
echo "$OUT" | grep -q 'is not installed. The CLI needs drizzle-orm and zod'
if echo "$OUT" | grep -q 'node:internal'; then echo "a stack trace leaked: $OUT"; exit 1; fi
echo "pack smoke ok"
