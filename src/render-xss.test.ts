/**
 * 73: the renderer XSS contract. Screens get a block tree, never an HTML string (HTML blocks go
 * through `sanitizeHtml`). These hostile fixtures must not produce a link, image or attribute that
 * runs script or leaves the site in disguise, in the tree or in `markdownToHtml`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { markdownToHtml } from "./html";

const HOSTILE = [
  "[a](javascript:alert(1))",
  "[a](JaVaScRiPt:alert(1))",
  "[a]( javascript:alert(1))",
  "[a](java\tscript:alert(1))",
  "[a](&#106;avascript:alert(1))",
  "[a](%6Aavascript:alert(1))",
  "[a](vbscript:msgbox(1))",
  "[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[a](DATA:text/html,<script>alert(1)</script>)",
  "[a](//evil.example/x)",
  "[a](/\\evil.example/x)",
  "[a](/\\/evil.example)",
  "[a](\\\\evil.example)",
  "[a](file:///etc/passwd)",
  "[[a](javascript:alert(1))](https://ok.example)",
  "[a](https://ok.example \"x\" onclick=\"alert(1)\")",
  "![x](javascript:alert(1))",
  "![x\" onerror=\"alert(1)](https://ok.example/a.png)",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "`<script>alert(1)</script>`",
  "**<svg onload=alert(1)>**",
  "[a](https://ok.example/\"><script>alert(1)</script>)",
  "> [a](javascript:alert(1))",
  "- [ ] [a](javascript:alert(1))",
  "| h |\n|---|\n| [a](javascript:alert(1)) |",
];

const ALLOWED = /^(https?:\/\/|mailto:|\/(?![/\\])|#|cms-link:)/i;

function walk(blocks: Block[], fn: (i: Inline) => void) {
  const inl = (xs: Inline[] | undefined) => xs?.forEach((x) => {
    fn(x);
    inl((x as { kids?: Inline[] }).kids);
  });
  for (const b of blocks) {
    const anyB = b as unknown as Record<string, unknown>;
    inl(anyB.inline as Inline[] | undefined);
    inl(anyB.text as Inline[] | undefined);
    for (const it of (anyB.items as { inline?: Inline[] }[] | undefined) ?? []) inl(Array.isArray(it) ? (it as Inline[]) : it.inline);
    for (const row of [anyB.head, ...((anyB.rows as unknown[]) ?? [])] as unknown[]) if (Array.isArray(row)) for (const cell of row) inl(cell as Inline[]);
    for (const k of ["blocks", "cols"]) {
      const v = anyB[k];
      if (Array.isArray(v)) for (const sub of v) walk(Array.isArray(sub) ? (sub as Block[]) : [sub as Block], fn);
    }
  }
}

test("renderer contract: hostile links and markup never become a link, image or attribute that runs script", () => {
  for (const src of HOSTILE) {
    const blocks = parseMarkdown(src);
    walk(blocks, (i) => {
      if (i.t === "link") assert.match(i.href, ALLOWED, `${src} → link ${i.href}`);
      if (i.t === "link") assert.doesNotMatch(i.href, /[<>"\s]/, `${src} → ${i.href}`);
    });
    const html = markdownToHtml(src);
    // Text may say "javascript:" (it is shown, escaped); tags and attributes may not carry it.
    assert.doesNotMatch(html.replace(/="[^"]*"/g, '=""'), /<script|<[a-z][^>]*\son[a-z]+=/i, `${src} → ${html}`);
    assert.doesNotMatch(html, /(href|src)="\s*(javascript:|vbscript:|data:|\/\/|\/\\|\\\\)/i, `${src} → ${html}`);
  }
});

test("renderer contract: safe links still work", () => {
  const html = markdownToHtml("[a](https://ok.example/x?y=1&z=2) [b](/docs/start) [c](#top) [d](mailto:a@b.example)");
  for (const href of ['href="https://ok.example/x?y=1&amp;z=2"', 'href="/docs/start"', 'href="#top"', 'href="mailto:a@b.example"']) assert.ok(html.includes(href), `${href} in ${html}`);
});
