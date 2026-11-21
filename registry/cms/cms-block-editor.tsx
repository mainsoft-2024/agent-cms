"use client";
// agent-cms: the block editor (Notion-style) for the document body.
// Built on BlockNote (MPL-2.0 core packages only). The body is still stored as
// markdown: this editor reads markdown, shows blocks, and writes markdown back
// (see cms-blocks-convert.ts). Opening a document and not touching it never
// changes its text, and parts the editor cannot show stay as "source blocks".
//
// Install: npx @mainsoft/agent-cms add cms-block-editor
// Use: <CmsProvider slots={{ blockEditor: CmsBlockEditor }}> (load it lazily, it is the biggest screen part).

import * as React from "react";
import { BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultStyleSpecs, filterSuggestionItems } from "@blocknote/core";
import { en as bnEn, ko as bnKo } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, type DefaultReactSuggestionItem } from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { blocksToMarkdown, fingerprint, markdownToBlocks, sameMarkdown, type BnBlock } from "./cms-blocks-convert";
import { useCms, type BlockEditorProps } from "./use-cms";

const SOURCE_LABEL: Record<string, string> = { html: "blk_src_html", "html-isolated": "blk_src_html_isolated", columns: "blk_src_columns", callout: "blk_src_callout", table: "blk_src_table", media: "blk_src_media", links: "blk_src_links" };

/** A part kept as markdown text: HTML, columns, callouts, aligned tables... */
function SourceBlockView({ md, kind, editable, onChange }: { md: string; kind: string; editable: boolean; onChange: (md: string) => void }) {
  const { t } = useCms();
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [text, setText] = React.useState(md);
  React.useEffect(() => setText(md), [md]);
  // Grow with the text.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  const label = SOURCE_LABEL[kind] ? t(SOURCE_LABEL[kind] as "blk_src_html") : t("blk_src_raw");
  return (
    <div contentEditable={false} data-cms-source={kind} className="my-1 w-full rounded-md border border-dashed bg-muted/40" style={{ width: "100%" }}>
      <div className="flex items-center gap-2 border-b border-dashed px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="rounded bg-background px-1.5 py-0.5 font-medium text-foreground">{label}</span>
        <span className="truncate">{t("blk_src_hint")}</span>
      </div>
      <textarea
        ref={ref}
        aria-label={label}
        value={text}
        readOnly={!editable}
        spellCheck={false}
        dir="ltr"
        className="block w-full resize-none bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-5 outline-none"
        // Keys belong to this box, not to the editor around it.
        onKeyDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== md && onChange(text)}
      />
    </div>
  );
}

const SourceBlock = createReactBlockSpec(
  { type: "cmsSource", propSchema: { md: { default: "" }, kind: { default: "raw" } }, content: "none" },
  {
    render: ({ block, editor }) => (
      <SourceBlockView md={block.props.md} kind={block.props.kind} editable={editor.isEditable} onChange={(md) => editor.updateBlock(block, { props: { md } })} />
    ),
  }
);

const { paragraph, quote, bulletListItem, numberedListItem, checkListItem, toggleListItem, codeBlock, table, image, divider } = defaultBlockSpecs;
const { bold, italic, strike, code } = defaultStyleSpecs;

// Only blocks and marks that markdown can hold: no colours, no underline, no video or file blocks.
const schema = BlockNoteSchema.create({
  // Markdown here has two heading levels (## and ###); the page title is the first.
  blockSpecs: { paragraph, heading: createHeadingBlockSpec({ levels: [2, 3] }), quote, bulletListItem, numberedListItem, checkListItem, toggleListItem, codeBlock, table, image, divider, cmsSource: SourceBlock() },
  styleSpecs: { bold, italic, strike, code },
});

type Editor = typeof schema.BlockNoteEditor;

function useDark(): boolean {
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    const o = new MutationObserver(read);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

export default function CmsBlockEditor({ value, onChange, readOnly, uploadFile, resolveFileUrl, onPickMedia, insertRef, id, describedBy }: BlockEditorProps) {
  const { t, locale } = useCms();
  const dark = useDark();
  const loaded = React.useMemo(() => markdownToBlocks(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const sources = React.useRef<Record<string, { fp: string; md: string }>>({});
  const emitted = React.useRef(value);
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: loaded.blocks.length ? (loaded.blocks as never) : undefined,
      dictionary: locale.startsWith("ko") ? { ...bnKo, placeholders: { ...bnKo.placeholders, emptyDocument: t("blk_placeholder"), default: t("blk_placeholder_line") } } : { ...bnEn, placeholders: { ...bnEn.placeholders, emptyDocument: t("blk_placeholder"), default: t("blk_placeholder_line") } },
      uploadFile: uploadFile ? (file: File) => uploadFile(file) : undefined,
      resolveFileUrl: resolveFileUrl ? async (url: string) => resolveFileUrl(url) : undefined,
      tables: { headers: true },
    },
    []
  ) as Editor;

  // What each untouched block looked like when loaded, with its original text.
  const remember = React.useCallback((src: Record<string, string>) => {
    const map: Record<string, { fp: string; md: string }> = {};
    for (const b of editor.document as unknown as BnBlock[]) if (b.id && src[b.id] !== undefined) map[b.id] = { fp: fingerprint(b), md: src[b.id] };
    sources.current = map;
  }, [editor]);
  React.useEffect(() => remember(loaded.sources), [remember, loaded]);

  const toMd = React.useCallback(() => {
    const keep = (b: BnBlock) => {
      const s = b.id ? sources.current[b.id] : undefined;
      return s && s.fp === fingerprint(b) ? s.md : undefined;
    };
    return blocksToMarkdown(editor.document as unknown as BnBlock[], keep);
  }, [editor]);

  // The text changed from outside (an agent's edit, a restore, a merge): load it.
  React.useEffect(() => {
    if (value === emitted.current || sameMarkdown(value, toMd())) return;
    const next = markdownToBlocks(value);
    emitted.current = value;
    editor.replaceBlocks(editor.document, (next.blocks.length ? next.blocks : [{ type: "paragraph" }]) as never);
    remember(next.sources);
  }, [value, editor, toMd, remember]);

  // The screen can put markdown (a picked file) where the cursor is.
  React.useEffect(() => {
    if (!insertRef) return;
    insertRef.current = (md: string) => {
      const blocks = markdownToBlocks(md).blocks;
      if (!blocks.length) return;
      const at = editor.getTextCursorPosition().block;
      editor.insertBlocks(blocks as never, at, "after");
    };
    return () => {
      insertRef.current = null;
    };
  }, [editor, insertRef]);

  const items = React.useCallback(
    async (query: string) => {
      const insertSource = (md: string, kind: string) => {
        const at = editor.getTextCursorPosition().block;
        const block = { type: "cmsSource", props: { md, kind } } as never;
        // An empty line becomes the block; otherwise it goes below.
        if (Array.isArray(at.content) && at.content.length === 0) editor.replaceBlocks([at], [block]);
        else editor.insertBlocks([block], at, "after");
      };
      const own: DefaultReactSuggestionItem[] = [
        { title: t("blk_slash_callout"), subtext: t("blk_slash_callout_text"), aliases: ["callout", "note", "tip", "알림"], group: t("blk_group_cms"), onItemClick: () => insertSource("> [!note]\n> ", "callout") },
        { title: t("blk_slash_columns"), subtext: t("blk_slash_columns_text"), aliases: ["columns", "2", "단"], group: t("blk_group_cms"), onItemClick: () => insertSource(":::columns\n:::col\n\n:::col\n\n:::", "columns") },
        { title: t("blk_slash_html"), subtext: t("blk_slash_html_text"), aliases: ["html", "embed", "iframe"], group: t("blk_group_cms"), onItemClick: () => insertSource(":::html\n\n:::", "html") },
      ];
      if (onPickMedia)
        own.unshift({
          title: t("blk_slash_media"),
          subtext: t("blk_slash_media_text"),
          aliases: ["image", "media", "file", "이미지", "파일"],
          group: t("blk_group_cms"),
          onItemClick: () => {
            void onPickMedia().then((md) => {
              if (!md) return;
              const at = editor.getTextCursorPosition().block;
              editor.insertBlocks(markdownToBlocks(md).blocks as never, at, "after");
            });
          },
        });
      // The editor's own items for blocks this schema has (no video, audio, emoji...).
      const builtin = getDefaultReactSlashMenuItems(editor as never).filter((i) => !/emoji|video|audio|file|page/i.test(String((i as { key?: string }).key ?? "")));
      return filterSuggestionItems([...builtin, ...own], query);
    },
    [editor, onPickMedia, t]
  );

  return (
    <div className="cms-blocks relative flex min-h-[360px] flex-1 flex-col py-3" id={id} aria-describedby={describedBy}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={dark ? "dark" : "light"}
        slashMenu={false}
        onChange={() => {
          const md = toMd();
          if (sameMarkdown(md, emitted.current)) return;
          emitted.current = md;
          onChange(md);
        }}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={items} />
      </BlockNoteView>
    </div>
  );
}
