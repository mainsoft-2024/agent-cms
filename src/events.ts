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
 * Since 0.17.0 the stream follows the change log (`cms_changes`), so it carries what every server
 * did, not only this one. Each message's id is its number in the log; a client that reconnects
 * sends it back (`Last-Event-ID`, or `?since=`) and first gets every event it missed, in order.
 * When the log no longer reaches that far back (it keeps 7 days), or for an old time-based id, it
 * gets one `resync` message instead (the documents saved since then, or `reset: true`: reload
 * everything). Serverless hosts cut long responses: `EventSource` reconnects by itself.
 */
import type { CmsCore, FeedEvent } from "./cms";
import { PUBLIC_EVENTS } from "./changes";
import type { OutEvent } from "./outbox";
import type { Actor } from "./types";

export interface EventStreamOptions {
  /** Only these collections. Default: every collection the caller may read. */
  collections?: string[];
  /** The last event id (a number in the change log), or an ISO time: start with what came after it. */
  since?: string | null;
  /** Ends the stream (the request's `signal`). */
  signal?: AbortSignal;
  /**
   * The request itself, held for as long as the stream is open. Node's
   * `Request` keeps the controller behind `request.signal` alive only while
   * the request object lives; without this a collected request never aborts
   * and the listener would stay subscribed after the client left.
   */
  request?: Request;
  /** A comment line this often keeps proxies from closing a quiet stream (ms). Default 25000. */
  heartbeatMs?: number;
}

const RESYNC_MAX = 200;
const REPLAY_MAX = 500;

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

/**
 * What `actor` hears of `e`, or null. In a collection whose rules decide per document who may
 * read or edit it, people who are not admins hear that something changed in the collection,
 * not which document, who did it or where it lives: the event goes out before anyone could
 * check that document's rules for them, and a delete or unpublish leaves nothing to check.
 * They reload what they show, and reads apply the rules (0.18.0).
 */
export function hearAs<E extends OutEvent>(core: CmsCore, actor: Actor, e: E, only?: readonly string[]): E | null {
  if (!mayHear(core, actor, e, only)) return null;
  if (!e.collection || actor.kind === "system" || core.isAdmin(actor) || !core.rulesPerDocument(e.collection)) return e;
  return { ...e, slug: null, version: null, url: null, actor: null, detail: undefined };
}

const frame = (event: string, id: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Without an id frame line, so the client's last id stays the last real event. */
const note = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const publicEvent = ({ seq: _s, remote: _r, ...e }: FeedEvent) => e;

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
      // Events that arrive while the missed ones are being replayed wait here, so the order holds.
      let queue: FeedEvent[] | null = [];
      let lastSent = 0;
      const replayed = new Set<number>();
      const deliver = (e: FeedEvent) => {
        const heard = hearAs(core, actor, e, o.collections);
        if (!heard) return;
        e = heard;
        if (e.seq !== undefined) {
          if (replayed.has(e.seq)) return; // already sent from the log
          lastSent = Math.max(lastSent, e.seq);
        }
        send(frame(e.event, e.seq !== undefined ? String(e.seq) : new Date().toISOString(), publicEvent(e)));
      };
      const unsubscribe = core.subscribe((e) => {
        if (queue) queue.push(e);
        else deliver(e);
      });
      const beat = setInterval(() => send(": keep-alive\n\n"), o.heartbeatMs ?? 25_000);
      (beat as { unref?: () => void }).unref?.();
      let held: Request | undefined = o.request;
      stop = () => {
        if (!open) return;
        open = false;
        held = undefined;
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
      const raw = o.since?.trim() || null;
      try {
        if (raw && /^\d+$/.test(raw)) {
          const seq = Number(raw);
          const missed = await core.changes.since(actor, seq, { collections: o.collections, limit: REPLAY_MAX, hear: (e) => hearAs(core, actor, e, o.collections) });
          if (!missed) send(note("resync", { since: raw, documents: [], more: true, reset: true }));
          else {
            for (const c of missed.changes) {
              lastSent = c.seq;
              replayed.add(c.seq);
              const { seq: id, at: _at, ...rest } = c;
              send(frame(c.event, String(id), rest));
            }
            lastSent = Math.max(lastSent, missed.last);
            if (missed.more) send(note("resync", { since: raw, documents: [], more: true, reset: true }));
          }
        } else if (raw && !Number.isNaN(Date.parse(raw))) {
          const since = new Date(Date.parse(raw)).toISOString();
          const docs = await core.changedSince(actor, since, { collections: o.collections, limit: RESYNC_MAX });
          send(note("resync", { since, documents: docs, more: docs.length >= RESYNC_MAX }));
        }
      } catch (e) {
        core.telemetry({ type: "error", where: "events resync", message: e instanceof Error ? e.message : String(e) });
      }
      // Where the log stands, read before live delivery starts: never a number past an event not sent yet.
      if (!lastSent) lastSent = await core.changes.last().catch(() => 0);
      const waiting = queue;
      queue = null;
      for (const e of waiting) deliver(e);
      send(frame("ready", String(lastSent), { collections: o.collections ?? null, last: lastSent }));
      void held;
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
