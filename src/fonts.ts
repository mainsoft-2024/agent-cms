/**
 * 0.22.2: the default fonts of the copied admin screens. Wanted Sans (Korean and Latin in one
 * family) and Geist Mono, both under the SIL Open Font License 1.1.
 *
 * `npx @mainsoft/agent-cms init` writes this CSS to `cms-fonts.css`; the admin layout imports it.
 * It only applies while an admin screen is on the page (`.cms-root`, set by CmsShell), so the
 * app's own pages keep their fonts. Dialogs and menus are portalled to `<body>`, hence `body:has`.
 * To use other fonts, change the two variables.
 */
export const CMS_FONT_SANS = '"Wanted Sans Variable", "Wanted Sans", ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const CMS_FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const CMS_FONTS_CSS = `/* agent-cms admin fonts (0.22.2). Wanted Sans and Geist Mono, SIL Open Font License 1.1.
   Applies only while an admin screen is on the page; change the two variables to use other fonts. */
@import url("https://cdn.jsdelivr.net/gh/wanteddev/wanted-sans@v1.0.3/packages/wanted-sans/fonts/webfonts/variable/split/WantedSansVariable.min.css");
@import url("https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400..600&display=swap");

body:has(.cms-root),
.cms-root {
  --cms-font-sans: ${CMS_FONT_SANS};
  --cms-font-mono: ${CMS_FONT_MONO};
  font-family: var(--cms-font-sans);
}
body:has(.cms-root) .font-sans,
.cms-root .font-sans {
  font-family: var(--cms-font-sans);
}
body:has(.cms-root) :is(.font-mono, code, kbd, pre, samp),
.cms-root :is(.font-mono, code, kbd, pre, samp) {
  font-family: var(--cms-font-mono);
}
`;
