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

ENTRIES="index http mcp ai client tools agent markdown frontmatter types tables cli diff errors config messages/en messages/ko"

cat > esm.mjs <<EOF
const entries = "$ENTRIES".split(" ");
for (const e of entries) {
  const spec = e === "index" ? "@mainsoft/agent-cms" : "@mainsoft/agent-cms/" + e;
  if (e === "ai") continue; // needs the optional "ai" peer
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
  if (e === "ai") continue;
  const spec = e === "index" ? "@mainsoft/agent-cms" : "@mainsoft/agent-cms/" + e;
  const m = require(spec);
  if (!Object.keys(m).length) throw new Error("empty module: " + spec);
}
console.log("cjs ok");
EOF
node cjs.cjs

npx agent-cms --version
npx agent-cms add --list | grep -q cms-doc-list
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
echo "pack smoke ok"
