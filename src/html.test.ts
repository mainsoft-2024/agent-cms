import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, inspectHtml, isolatedHtml, hasScripts } from "./html";

/** Bypass attempts from the OWASP XSS filter evasion cheat sheet and friends. */
const ATTACKS = [
  `<script>alert(1)</script>`,
  `<SCRIPT SRC=//x.example/x.js></SCRIPT>`,
  `<img src=x onerror=alert(1)>`,
  `<IMG SRC="jav&#x09;ascript:alert('XSS');">`,
  `<img src="javascript:alert(1)">`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>`,
  `<a href="  javascript:alert(1)">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<svg onload=alert(1)><circle r=1></svg>`,
  `<svg><script>alert(1)</script></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<iframe src="https://evil.example/"></iframe>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<body onload=alert(1)>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<div style="width: expression(alert(1))">x</div>`,
  `<object data="javascript:alert(1)"></object>`,
  `<embed src="javascript:alert(1)">`,
  `<form action="javascript:alert(1)"><button>go</button></form>`,
  `<input autofocus onfocus=alert(1)>`,
  `<details open ontoggle=alert(1)>`,
  `<video><source onerror=alert(1)></video>`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<base href="javascript:alert(1)//">`,
  `<link rel=stylesheet href="javascript:alert(1)">`,
  `<style>@import 'javascript:alert(1)';</style>`,
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<img """><script>alert(1)</script>">`,
  `<<script>script>alert(1)<</script>/script>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<a href="#" onclick="alert(1)">x</a>`,
  `<img src=x onerror="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041">`,
  `<template><script>alert(1)</script></template>`,
];

const dangerous = (html: string) =>
  /<script|<svg|<math|<object|<embed|<form|<input|<meta|<base|<link|<style|<body|<template|\son[a-z]+\s*=|javascript:|vbscript:|data:text|srcdoc|expression\(/i.test(html);

test("html: sanitizeHtml turns off every attack in the set", () => {
  for (const a of ATTACKS) {
    const out = sanitizeHtml(a);
    assert.ok(!dangerous(out), `${a}\n→ ${out}`);
  }
  // With style allowed, script-ish values still go.
  for (const a of ATTACKS) assert.ok(!dangerous(sanitizeHtml(a, { allowStyle: true })), a);
});

test("html: what is safe draws as written", () => {
  const html = `<section class="hero"><h2>Hi</h2><p>A <a href="https://example.com" target="_blank">link</a> and <mark>mark</mark>.</p>
<table><tr><td colspan="2">x</td></tr></table><details><summary>More</summary>Text</details>
<img src="asset:abcdefabcdef/pic%20one.png" alt="pic"><iframe src="https://www.youtube-nocookie.com/embed/x"></iframe></section>`;
  const out = sanitizeHtml(html);
  assert.ok(out.includes('<section class="hero">'));
  assert.ok(out.includes('colspan="2"'));
  assert.ok(out.includes("<details>"));
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.ok(out.includes('src="/api/cms/files/abcdefabcdef/pic%20one.png"'), out);
  assert.ok(/<iframe[^>]+sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"/.test(out), out);
  assert.ok(sanitizeHtml(html, {}, { assetUrl: (id) => `https://cdn.example/${id}` }).includes('src="https://cdn.example/abcdefabcdef"'));
  // style is dropped unless allowed; class prefix narrows classes.
  assert.ok(!sanitizeHtml('<p style="color:red">x</p>').includes("style"));
  assert.ok(sanitizeHtml('<p style="color:red">x</p>', { allowStyle: true }).includes("color:red"));
  assert.equal(sanitizeHtml('<p class="cms-a other">x</p>', { classPrefix: "cms-" }), '<p class="cms-a">x</p>');
  assert.ok(sanitizeHtml('<iframe src="https://example.org/x"></iframe>', { iframeHosts: ["example.org"] }).includes("example.org"));
});

test("html: inspectHtml reports what does nothing, by line", () => {
  const html = `<div>\n<button onclick="go()">Go</button>\n<script>track()</script>\n<iframe src="https://evil.example/"></iframe>\n<a href="javascript:x()">x</a>\n<p style="color:red">y</p>\n</div>`;
  const found = inspectHtml(html).map((x) => `${x.line}:${x.kind}:${x.detail}`);
  assert.deepEqual(found, ["2:tag:<button>", "2:event:onclick", "3:script:<script>", "4:iframe:evil.example", '5:url:href="javascript:x()"', "6:style:style"]);
  assert.deepEqual(inspectHtml('<p style="x">y</p>', { allowStyle: true }), []);
  assert.deepEqual(inspectHtml('<iframe src="https://player.vimeo.com/video/1"></iframe><img src="asset:abcdefabcdef/x.png">'), []);
  assert.ok(hasScripts("<img src=x onerror=alert(1)>"));
  assert.ok(!hasScripts("<p>hello</p>"));
  for (const a of ATTACKS) assert.ok(inspectHtml(a).length > 0 || sanitizeHtml(a) === a.replace(/<[^>]*>/g, ""), `not reported: ${a}`);
});

test("html: isolatedHtml keeps the HTML and adds the height report", () => {
  const page = isolatedHtml('<div id="w"></div><script>w.textContent=1</script><img src="asset:abcdefabcdef/a.png">');
  assert.ok(page.includes("<script>w.textContent=1</script>"));
  assert.ok(page.includes("agent-cms:height"));
  assert.ok(page.includes('src="/api/cms/files/abcdefabcdef/a.png"'));
});

test("html: a #### heading is an <h4> with its anchor", async () => {
  const { markdownToHtml } = await import("./html");
  const out = markdownToHtml("## Top\n\n#### Rotate a key {#rotate}\n\n#### Plain four");
  assert.match(out, /<h4 id="rotate">Rotate a key<\/h4>/);
  assert.match(out, /<h4 id="plain-four">Plain four<\/h4>/);
});
