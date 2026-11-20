/**
 * `GET /_events`: what happens in the CMS as a stream (Server-Sent Events), so an app can refresh
 * a page when its content changes instead of asking again and again.
 *
 *   const es = new EventSource("/api/cms/_events?collections=posts");
 *   es.addEventListener("doc.published", (e) => revalidate(JSON.parse(e.data).slug));
 *
 * Who hears what:
 * - someone who may write in a collection hears everything about its documents;
 * - a reader (a stranger on a public collection, a read key) hears only what changes the public
 *   copy: published, unpublished, archived, deleted, restored;
 * - events without a collection (files, releases) go to admins.
 *
 * The stream is fed by this server process. Each message has an id (its time); a client that
 * reconnects sends it back (`Last-Event-ID`, or `?since=`) and first gets one `resync` message
 * listing the documents saved since then, by any process. Serverless hosts cut long responses:
 * `EventSource` reconnects by itself, and `resync` covers the gap.
 */
import type { CmsCore } from "./cms";
import type { OutEvent } from "./outbox";
import type { Actor } from "./types";

export interface EventStreamOptions {
  /** Only these collections. Default: every collection the caller may read. */
  collections?: string[];
  /** An ISO time (or the last event id): start with a `resync` of what was saved after it. */
  since?: string | null;
  /** Ends the stream (the request's `signal`). */
  signal?: AbortSignal;
  /** A comment line this often keeps proxies from closing a quiet stream (ms). Default 25000. */
  heartbeatMs?: number;
}

const PUBLIC_EVENTS = new Set(["doc.published", "doc.unpublished", "doc.archived", "doc.deleted", "doc.restored"]);
const RESYNC_MAX = 200;

/** Whether `actor` may be told about `e`. */
export function mayHear(core: CmsCore, actor: Actor, e: OutEvent, only?: readonly string[]): boolean {
  if (!e.collection) return !only?.length && core.isAdmin(actor);
  if (only?.length && !only.includes(e.collection)) return false;
  try {
    if (core.can(actor, e.collection, "write")) return true;
    return PUBLIC_EVENTS.has(e.event) && core.can(actor, e.collection, "read");
  } catch {
    return false; // a collection this CMS does not have
  }
}

const frame = (event: string, id: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function eventStream(core: CmsCore, actor: Actor, o: EventStreamOptions = {}): Response {
  for (const c of o.collections ?? []) {
    // An unknown or unreadable collection is refused up front rather than silently never firing.
    core.assertCan(actor, c, "read");
  }
  const enc = new TextEncoder();
  let stop: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = core.subscribe((e) => {
        if (mayHear(core, actor, e, o.collections)) send(frame(e.event, new Date().toISOString(), e));
      });
      const beat = setInterval(() => send(": keep-alive\n\n"), o.heartbeatMs ?? 25_000);
      (beat as { unref?: () => void }).unref?.();
      stop = () => {
        if (!open) return;
        open = false;
        clearInterval(beat);
        unsubscribe();
        o.signal?.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      o.signal?.addEventListener("abort", stop);
      if (o.signal?.aborted) return stop();
      // How long the browser waits before it reconnects.
      send("retry: 3000\n\n");
      const since = o.since && !Number.isNaN(Date.parse(o.since)) ? new Date(Date.parse(o.since)).toISOString() : null;
      if (since) {
        try {
          const docs = await core.changedSince(actor, since, { collections: o.collections, limit: RESYNC_MAX });
          send(frame("resync", new Date().toISOString(), { since, documents: docs, more: docs.length >= RESYNC_MAX }));
        } catch (e) {
          core.telemetry({ type: "error", where: "events resync", message: e instanceof Error ? e.message : String(e) });
        }
      }
      send(frame("ready", new Date().toISOString(), { collections: o.collections ?? null }));
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
