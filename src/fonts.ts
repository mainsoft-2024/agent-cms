/**
 * 0.22.2: the default fonts of the admin. Wanted Sans (Korean and Latin in one family) and
 * Geist Mono, both under the SIL Open Font License 1.1, both from jsDelivr.
 *
 * `npx @mainsoft/agent-cms init` writes `CMS_FONTS_CSS` to `cms-fonts.css`; the admin layout imports
 * it. 0.24.1: the built-in admin (`serve`, `dev`) loads the same two style sheets (`CMS_FONT_URLS`)
 * and rules (`CMS_FONT_RULES`); its Content-Security-Policy allows `CMS_FONT_ORIGIN` for them.
 *
 * The rules only apply while an admin screen is on the page (`.cms-root`, set by CmsShell), so the
 * app's own pages keep their fonts. Dialogs and menus are portalled to `<body>`, hence `body:has`.
 * To use other fonts, change the two variables.
 */
export const CMS_FONT_SANS = '"Wanted Sans Variable", "Wanted Sans", ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const CMS_FONT_MONO = '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** The one origin the font style sheets and files come from. */
export const CMS_FONT_ORIGIN = "https://cdn.jsdelivr.net";

/** The font style sheets (pinned versions). */
export const CMS_FONT_URLS = [
  `${CMS_FONT_ORIGIN}/gh/wanteddev/wanted-sans@v1.0.3/packages/wanted-sans/fonts/webfonts/variable/split/WantedSansVariable.min.css`,
  `${CMS_FONT_ORIGIN}/npm/@fontsource-variable/geist-mono@5.2.7/index.css`,
] as const;

/** The rules that put the fonts on the admin (no imports). */
export const CMS_FONT_RULES = `body:has(.cms-root),
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

export const CMS_FONTS_CSS = `/* agent-cms admin fonts (0.24.1). Wanted Sans and Geist Mono, SIL Open Font License 1.1, from jsDelivr.
   Applies only while an admin screen is on the page; change the two variables to use other fonts. */
${CMS_FONT_URLS.map((u) => `@import url("${u}");`).join("\n")}

${CMS_FONT_RULES}`;

/** The `<head>` lines the built-in admin adds for its fonts. */
export function cmsFontHead(): string {
  return `${CMS_FONT_URLS.map((u) => `<link rel="stylesheet" href="${u}" crossorigin="anonymous">`).join("\n")}\n<style>${CMS_FONT_RULES}</style>\n`;
}
