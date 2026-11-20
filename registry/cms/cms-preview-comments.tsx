// agent-cms registry: cms-preview-comments (0.10.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// For your public page when it shows a draft through a preview link that
// was made with "Allow comments": the comments on that draft, and a box for
// someone without an account to add one. It needs no <CmsProvider>.
//
//   {token && preview.comments ? <CmsPreviewComments token={token} /> : null}
"use client";

import * as React from "react";
import { createRestClient, type CommentThread } from "@mainsoft/agent-cms/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createT, errorMessage, type CmsMessages } from "./cms-messages";

export interface CmsPreviewCommentsProps {
  /** The preview token (`?cms_preview=...`). */
  token: string;
  /** Where the CMS routes are mounted. Default "/api/cms". */
  baseUrl?: string;
  /** UI text; pass `ko` for Korean. */
  messages?: Partial<CmsMessages>;
  className?: string;
}

const NAME_KEY = "cms-preview-name";

export function CmsPreviewComments({ token, baseUrl = "/api/cms", messages, className }: CmsPreviewCommentsProps) {
  const client = React.useMemo(() => createRestClient({ url: baseUrl }), [baseUrl]);
  const t = React.useMemo(() => createT(messages), [messages]);
  const [threads, setThreads] = React.useState<CommentThread[] | null>(null);
  const [name, setName] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  const load = React.useCallback(() => {
    client.previewComments(token).then(setThreads, (e) => setError(errorMessage(e, t)));
  }, [client, token, t]);
  React.useEffect(load, [load]);
  React.useEffect(() => {
    try {
      setName(window.localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const open = (threads ?? []).filter((x) => !x.resolvedAt);
  const who = (c: { authorAgent: string | null; authorLabel: string | null }) => c.authorAgent ?? c.authorLabel ?? "";

  return (
    <section aria-labelledby={`${id}-h`} className={cn("flex flex-col gap-4 rounded-lg border p-4 text-sm", className)}>
      <h2 id={`${id}-h`} className="text-base font-semibold">
        {open.length ? t("comments_n", { n: open.length }) : t("comments")}
      </h2>
      {open.length ? (
        <ul className="flex flex-col gap-3">
          {open.map((th) => (
            <li key={th.id} className="flex flex-col gap-1.5 border-b pb-3 last:border-b-0 last:pb-0">
              <span className="font-medium">{who(th)}</span>
              {th.quote ? <span className="truncate border-l-2 pl-2 font-mono text-[12.5px] text-muted-foreground">{th.quote}</span> : null}
              <p className="whitespace-pre-wrap break-words">{th.body}</p>
              {th.replies.length ? (
                <ul className="ml-3 flex flex-col gap-1.5 border-l pl-3">
                  {th.replies.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">{who(r)}</span>
                      <p className="whitespace-pre-wrap break-words">{r.body}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = body.trim();
          if (!text) return;
          setBusy(true);
          setError(null);
          client.addPreviewComment(token, { name: name.trim() || null, body: text }).then(
            () => {
              try {
                window.localStorage.setItem(NAME_KEY, name.trim());
              } catch {
                /* private mode */
              }
              setBody("");
              setBusy(false);
              load();
            },
            (err) => (setBusy(false), setError(errorMessage(err, t)))
          );
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>{t("name")}</Label>
          <Input id={`${id}-name`} maxLength={60} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-body`}>{t("comment_write")}</Label>
          <Textarea id={`${id}-body`} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="self-end" disabled={busy || !body.trim()}>
          {t("comment_add")}
        </Button>
      </form>
    </section>
  );
}
