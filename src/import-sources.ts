/**
 * Content from somewhere else, turned into the files `import` reads: a JSON list, a CSV sheet
 * or a WordPress export (WXR). Each becomes `collection/slug.md` with frontmatter, so the
 * import itself (dry run, diff, conflicts, drafts) is the same as for an agent-cms export.
 * HTML bodies become markdown here, without a DOM, so it runs in the CLI and on a server.
 */
import { docToMarkdown } from "./frontmatter";
import type { TransferFile } from "./transfer";

export const IMPORT_SOURCES = ["json", "csv", "wordpress", "notion"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface SourceDoc {
  collection?: string;
  slug?: string;
  title?: string;
  summary?: string;
  /** Markdown. */
  body?: string;
  /** HTML, converted when there is no `body`. */
  html?: string;
  category?: string | null;
  keywords?: string[];
  fields?: Record<string, unknown>;
  /** "published" documents can be published by the import (`--publish`). */
  status?: string;
  updatedAt?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (raw: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(raw);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const safeUrl = (u: string | null): string | null => (u && /^(https?:\/\/|\/|#|mailto:|asset:)/i.test(u.trim()) ? u.trim().replace(/\s/g, "%20").replace(/\)/g, "%29") : null);

/**
 * HTML → the markdown this CMS stores. Headings, paragraphs, lists, links, images, quotes,
 * code, tables, rules, bold and italics survive; scripts, styles, frames and forms do not.
 * Text without block tags (WordPress classic editor) is split into paragraphs at blank lines.
 */
export function htmlToMarkdown(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|form|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\r\n?/g, "\n");
  const bufs: string[] = [""];
  const lists: { ordered: boolean; n: number }[] = [];
  const links: (string | null)[] = [];
  const rows: string[][] = [];
  let row: string[] | null = null;
  let pre = false;
  const top = () => bufs[bufs.length - 1];
  const put = (s: string) => (bufs[bufs.length - 1] += s);
  const block = () => {
    const cur = top().replace(/[ \t]+$/, "");
    bufs[bufs.length - 1] = cur === "" ? "" : cur.replace(/\n*$/, "\n\n");
  };
  const text = (raw: string) => {
    if (pre) return put(decodeEntities(raw));
    const inCell = row !== null;
    raw.split(/\n[ \t]*\n/).forEach((part, i) => {
      if (i > 0 && !lists.length && !inCell) block();
      const t = decodeEntities(part.replace(/\s+/g, " "));
      if (!t.trim()) {
        if (t && top() && !/\s$/.test(top())) put(" ");
        return;
      }
      put(/(^|\n)$/.test(top()) ? t.replace(/^ /, "") : t);
    });
  };

  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    const raw = m[3];
    if (pre && !(tag === "pre" && close)) {
      if (tag !== "code" && tag !== "span") put(m[0]);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      block();
      if (!close) put(`${"#".repeat(Number(tag[1]))} `);
    } else if (["p", "div", "section", "article", "figure", "figcaption", "header", "footer", "main", "aside", "address"].includes(tag)) block();
    else if (tag === "br") put(row ? " " : "\n");
    else if (tag === "hr") {
      block();
      put("---");
      block();
    } else if (tag === "strong" || tag === "b") put("**");
    else if (tag === "em" || tag === "i") put("*");
    else if (tag === "del" || tag === "s" || tag === "strike") put("~~");
    else if (tag === "code") put("`");
    else if (tag === "a") {
      if (!close) {
        links.push(safeUrl(attr(raw, "href")));
        if (links[links.length - 1]) put("[");
      } else {
        const href = links.pop();
        if (href) put(`](${href})`);
      }
    } else if (tag === "img") {
      const url = safeUrl(attr(raw, "src"));
      if (url && /^(https:\/\/|asset:)/i.test(url)) put(`![${(attr(raw, "alt") ?? "").replace(/[\[\]]/g, "")}](${url})`);
    } else if (tag === "ul" || tag === "ol") {
      if (!close) {
        if (!lists.length) block();
        lists.push({ ordered: tag === "ol", n: 0 });
      } else {
        lists.pop();
        if (!lists.length) block();
      }
    } else if (tag === "li") {
      if (!close && lists.length) {
        const l = lists[lists.length - 1];
        l.n++;
        const cur = top().replace(/[ \t]+$/, "");
        bufs[bufs.length - 1] = cur && !cur.endsWith("\n") ? `${cur}\n` : cur;
        put(`${"  ".repeat(lists.length - 1)}${l.ordered ? `${l.n}.` : "-"} `);
      }
    } else if (tag === "blockquote") {
      if (!close) {
        block();
        bufs.push("");
      } else if (bufs.length > 1) {
        const inner = bufs.pop()!.trim();
        put(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        block();
      }
    } else if (tag === "pre") {
      if (!close) {
        block();
        const lang = /language-([\w-]+)/.exec(raw + (/<code\b([^>]*)>/i.exec(src.slice(last, last + 200))?.[1] ?? ""))?.[1] ?? "";
        put(`\`\`\`${lang}\n`);
        pre = true;
      } else {
        pre = false;
        bufs[bufs.length - 1] = `${top().replace(/\n+$/, "")}\n\`\`\``;
        block();
      }
    } else if (tag === "table") {
      if (!close) {
        block();
        rows.length = 0;
      } else if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|").trim()).join(" | ")} |`;
        put([line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n"));
        rows.length = 0;
        block();
      }
    } else if (tag === "tr") {
      if (!close) row = [];
      else if (row) {
        rows.push(row);
        row = null;
      }
    } else if (tag === "td" || tag === "th") {
      if (!close) bufs.push("");
      else if (bufs.length > 1) {
        const cell = bufs.pop()!.replace(/\s+/g, " ").trim();
        row?.push(cell);
      }
    }
  }
  if (last < src.length) text(src.slice(last));
  while (bufs.length > 1) {
    const inner = bufs.pop()!;
    put(inner);
  }
  return bufs[0]
    .replace(/\*\*\s*\*\*|~~\s*~~|(?<!`)``(?!`)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A title or a foreign address as a slug this CMS accepts. "" when nothing usable is left (Korean titles). */
export function slugify(s: string): string {
  let t = s;
  try {
    t = decodeURIComponent(s);
  } catch {
    // not percent-encoded
  }
  return t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/, "");
}

/** Documents from anywhere as import files. Slugs are made usable and unique; over-long values are cut to the limits. */
export function filesFromDocs(docs: SourceDoc[], o: { collection?: string } = {}): TransferFile[] {
  const used = new Set<string>();
  const files: TransferFile[] = [];
  docs.forEach((d, i) => {
    const collection = d.collection ?? o.collection ?? "";
    const base = slugify(d.slug ?? "") || slugify(d.title ?? "") || `doc-${i + 1}`;
    let slug = base;
    for (let n = 2; used.has(`${collection}/${slug}`); n++) slug = `${base.slice(0, 116)}-${n}`;
    used.add(`${collection}/${slug}`);
    const body = d.body ?? (d.html ? htmlToMarkdown(d.html) : "");
    const text = docToMarkdown(
      {
        slug,
        title: (d.title ?? slug).trim().slice(0, 200) || slug,
        summary: d.summary ? d.summary.replace(/\s+/g, " ").trim().slice(0, 300) : undefined,
        body: body.endsWith("\n") || !body ? body : `${body}\n`,
        category: d.category ?? undefined,
        keywords: d.keywords?.map((k) => String(k).trim()).filter((k) => k && k.length <= 40).slice(0, 30),
        fields: d.fields && Object.keys(d.fields).length ? d.fields : undefined,
      },
      { status: d.status, updatedAt: d.updatedAt }
    );
    files.push({ path: collection ? `${collection}/${slug}.md` : `${slug}.md`, text });
  });
  return files;
}

const KNOWN = new Set(["collection", "slug", "title", "summary", "body", "html", "content", "category", "keywords", "tags", "fields", "status", "updatedAt", "updated_at"]);
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? v.split(/[,;|]/).map((x) => x.trim()).filter(Boolean) : undefined);
function fromRecord(r: Record<string, unknown>): SourceDoc {
  const str = (v: unknown) => (v == null || v === "" ? undefined : String(v));
  const extra = Object.fromEntries(Object.entries(r).filter(([k, v]) => !KNOWN.has(k) && v !== "" && v != null));
  const content = str(r.content);
  const looksHtml = !!content && /<\/?[a-z][^>]*>/i.test(content);
  return {
    collection: str(r.collection),
    slug: str(r.slug),
    title: str(r.title),
    summary: str(r.summary),
    body: str(r.body) ?? (looksHtml ? undefined : content),
    html: str(r.html) ?? (looksHtml ? content : undefined),
    category: str(r.category),
    keywords: list(r.keywords) ?? list(r.tags),
    fields: { ...(r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, unknown>) : {}), ...extra },
    status: str(r.status),
    updatedAt: str(r.updatedAt) ?? str(r.updated_at),
  };
}

/** `[{ slug, title, body | html | content, … }]` or `{ documents: [...] }`. Keys this CMS does not know become fields. */
export function docsFromJson(text: string): SourceDoc[] {
  const data = JSON.parse(text) as unknown;
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? ((data as { documents?: unknown; items?: unknown; posts?: unknown }).documents ?? (data as { items?: unknown }).items ?? (data as { posts?: unknown }).posts) : null;
  if (!Array.isArray(rows)) throw new Error("expected a JSON array of documents, or { documents: [...] }");
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)).map(fromRecord);
}

/** RFC 4180: quoted cells, doubled quotes, line breaks inside quotes; a leading byte-order mark is dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) out.push(row);
  return out;
}

/** The first row names the columns: slug, title, summary, body (or html, content), category, keywords (or tags), status. Other columns become fields. */
export function docsFromCsv(text: string): SourceDoc[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const names = head.map((h) => h.trim());
  if (!names.includes("title") && !names.includes("slug")) throw new Error('the first row needs a "title" or "slug" column');
  return rows.map((r) => fromRecord(Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""]))));
}

const cdata = (s: string) => decodeEntities(s).trim();
function xml(item: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(item);
  if (!m) return undefined;
  const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return c ? c[1] : cdata(m[1]);
}

/**
 * A WordPress export file (Tools → Export, "WXR"). Posts and pages become documents; attachments,
 * menus and revisions are left out. Categories and tags become keywords; the address is the post's
 * slug. `types` picks other post types.
 */
export function docsFromWordpress(text: string, o: { types?: string[] } = {}): SourceDoc[] {
  const types = o.types ?? ["post", "page"];
  const docs: SourceDoc[] = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const type = xml(item, "wp:post_type") ?? "post";
    const status = xml(item, "wp:status") ?? "publish";
    if (!types.includes(type) || ["trash", "auto-draft", "inherit"].includes(status)) continue;
    const terms = [...item.matchAll(/<category\b[^>]*domain="(category|post_tag)"[^>]*>([\s\S]*?)<\/category>/g)].map((c) => cdata(c[2].replace(/^<!\[CDATA\[|\]\]>$/g, "")));
    const date = xml(item, "wp:post_modified_gmt") ?? xml(item, "wp:post_date_gmt");
    const iso = date && !date.startsWith("0000") ? `${date.replace(" ", "T")}Z` : undefined;
    const excerpt = xml(item, "excerpt:encoded");
    docs.push({
      slug: xml(item, "wp:post_name") || undefined,
      title: xml(item, "title"),
      summary: excerpt ? htmlToMarkdown(excerpt).replace(/\s+/g, " ") : undefined,
      html: xml(item, "content:encoded") ?? "",
      keywords: [...new Set(terms.filter((t) => t && t.toLowerCase() !== "uncategorized"))],
      status: status === "publish" ? "published" : "draft",
      updatedAt: iso && !Number.isNaN(Date.parse(iso)) ? iso : undefined,
    });
  }
  return docs;
}

/** Read a source file into import files. */
export function filesFromSource(source: Exclude<ImportSource, "notion">, text: string, o: { collection?: string; types?: string[] } = {}): TransferFile[] {
  const docs = source === "json" ? docsFromJson(text) : source === "csv" ? docsFromCsv(text) : docsFromWordpress(text, o);
  return filesFromDocs(docs, o);
}

/** A file from a Notion export with what the import needs to upload it. */
export interface NotionAsset {
  /** A stand-in id (12 characters) the body points at (`asset:<id>`) until the file is uploaded. */
  id: string;
  /** Path inside the export. */
  path: string;
  name: string;
  data: Uint8Array;
}

const NOTION_ID = /\s+[0-9a-f]{32}$/i;
const stripNotionId = (s: string) => s.replace(NOTION_ID, "").trim();
const safeUri = (s: string) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

/**
 * A Notion export ("Markdown & CSV", unzipped entries): each page is `Title <id>.md`, its images
 * sit in a folder `Title <id>/`. Pages become documents (title from the first `# ` heading, the
 * property lines under it become fields), images become files to upload; the body points at them
 * as `asset:<path>` and the import swaps in the real ids. Database CSVs are read as tables of
 * properties for the pages they list.
 */
export function docsFromNotion(entries: { name: string; data: Uint8Array }[]): { docs: SourceDoc[]; assets: NotionAsset[]; skipped: string[] } {
  const dec = new TextDecoder();
  const byPath = new Map(entries.map((e) => [e.name.normalize("NFC"), e]));
  const docs: SourceDoc[] = [];
  const assets = new Map<string, NotionAsset>();
  const skipped: string[] = [];
  const used = new Set<string>();
  for (const e of entries) {
    const path = e.name.normalize("NFC");
    if (!/\.md$/i.test(path)) {
      if (!/\.(csv|html)$/i.test(path) && !byPath.has(path.replace(/\/[^/]+$/, "") + ".md") && !/\.(png|jpe?g|gif|webp|svg|avif|pdf|mp4|mov|zip)$/i.test(path)) skipped.push(path);
      continue;
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const base = path.slice(dir.length).replace(/\.md$/i, "");
    let text = dec.decode(e.data).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    let title = stripNotionId(base);
    const h1 = /^# (.+)\n/.exec(text);
    if (h1) {
      title = h1[1].trim();
      text = text.slice(h1[0].length);
    }
    // Property lines right under the title ("Status: Done", "Tags: a, b").
    const fields: Record<string, unknown> = {};
    let category: string | null = null;
    let keywords: string[] | undefined;
    const props = /^\n*((?:[A-Za-z\u00C0-\uFFFF][^:\n]{0,40}: [^\n]*\n)+)\n/.exec(text);
    if (props) {
      for (const line of props[1].trim().split("\n")) {
        const at = line.indexOf(": ");
        const k = line.slice(0, at).trim();
        const val = line.slice(at + 2).trim();
        const key = k.toLowerCase();
        if (key === "tags" || key === "keywords") keywords = val.split(",").map((x) => x.trim()).filter(Boolean);
        else if (key === "category" || key === "type") category = val || null;
        else fields[k.replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase())] = val;
      }
      text = text.slice(props[0].length);
    }
    // Images and files next to the page.
    text = text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang: string, label: string, href: string) => {
      if (/^[a-z]+:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return all;
      const rel = safeUri(href).normalize("NFC");
      const target = (dir + rel).split("/").reduce<string[]>((acc, seg) => (seg === ".." ? acc.slice(0, -1) : seg === "." ? acc : [...acc, seg]), []).join("/");
      const file = byPath.get(target);
      if (!file) return bang ? `${label || "image"} (missing: ${rel})` : label;
      if (/\.md$/i.test(target)) {
        // A link to another page: to its slug (same collection).
        return `[${label}](/${slugify(stripNotionId(target.slice(target.lastIndexOf("/") + 1).replace(/\.md$/i, "")))})`;
      }
      const name = target.slice(target.lastIndexOf("/") + 1);
      const have = assets.get(target);
      const id = have?.id ?? `ntn${assets.size.toString(36).padStart(9, "0")}`;
      if (!have) assets.set(target, { id, path: target, name, data: file.data });
      const alt = (label || name).replace(/[[\]]/g, "");
      return bang ? `![${alt}](asset:${id}/${encodeURIComponent(name)})` : `[${alt}](asset:${id}/${encodeURIComponent(name)})`;
    });
    let slug = slugify(title) || slugify(stripNotionId(base)) || "page";
    for (let n = 2; used.has(slug); n++) slug = `${slugify(title)}-${n}`;
    used.add(slug);
    // Pages in a Notion export are finished pages: `--publish` publishes them.
    docs.push({ slug, title, status: "published", body: `${text.trim()}\n`, ...(category ? { category } : {}), ...(keywords ? { keywords } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  return { docs, assets: [...assets.values()], skipped };
}
