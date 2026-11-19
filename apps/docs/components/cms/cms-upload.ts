// agent-cms registry: cms-media-picker (0.8.0). Copied into your app by `npx agent-cms add`; edit freely.
//
// Uploads without a framework: files go from the browser straight to the
// storage with the signed addresses the CMS hands out. Files above the part
// size go up in parts, four at a time; a part that fails is tried three more
// times, and `retry` sends only the parts that are still missing.
import type { AssetView as Asset, RestClient } from "@mainsoft/agent-cms/client";

export type UploadTarget = { store?: string | null; folder?: string | null; field?: { collection: string; path: string } | null };
export type UploadState = "waiting" | "sending" | "done" | "failed";

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** Bytes that have arrived. */
  sent: number;
  state: UploadState;
  /** A message from the CMS (already translated), or null for a network failure. */
  error?: string | null;
  asset?: Asset;
}

/** PUT `body` to `url`, reporting bytes sent. Rejects on a non-2xx answer. */
export type SendFn = (url: string, body: Blob, o: { headers?: Record<string, string>; onProgress: (sent: number) => void; signal: AbortSignal }) => Promise<void>;

export interface UploaderOptions {
  client: RestClient;
  onChange?: (items: UploadItem[]) => void;
  /** A file is in the library. */
  onDone?: (asset: Asset) => void;
  send?: SendFn;
  /** Width, height, duration and a small picture of the file. Default: read in the browser. */
  describe?: (file: Blob, name: string) => Promise<MediaFacts>;
  partsInParallel?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface MediaFacts {
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  thumb?: Blob | null;
}

const xhrSend: SendFn = (url, body, { headers, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    for (const [k, v] of Object.entries(headers ?? {})) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`HTTP ${x.status}`)));
    x.onerror = () => reject(new Error("network"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => x.abort());
    x.send(body);
  });

const THUMB_SIDE = 480;

function loaded<T extends HTMLImageElement | HTMLVideoElement>(el: T, event: string, ms = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    el.addEventListener(event, () => (clearTimeout(timer), resolve(el)), { once: true });
    el.addEventListener("error", () => (clearTimeout(timer), reject(new Error("unreadable"))), { once: true });
  });
}

function shrink(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const k = Math.min(1, THUMB_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", 0.8));
}

/** Size, length and a 480px picture of an image or a video (its frame at one second). Never throws. */
export async function describeMedia(file: Blob, name: string): Promise<MediaFacts> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return {};
  const type = file.type || "";
  const url = URL.createObjectURL(file);
  try {
    if (type.startsWith("image/") && type !== "image/svg+xml") {
      const img = new Image();
      img.src = url;
      await loaded(img, "load");
      return { width: img.naturalWidth, height: img.naturalHeight, thumb: await shrink(img, img.naturalWidth, img.naturalHeight) };
    }
    if (type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name)) {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      v.src = url;
      await loaded(v, "loadedmetadata");
      const facts: MediaFacts = { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : null };
      v.currentTime = Math.min(1, (facts.duration ?? 0) / 2);
      await loaded(v, "seeked", 8000);
      return { ...facts, thumb: v.videoWidth ? await shrink(v, v.videoWidth, v.videoHeight) : null };
    }
    if (type.startsWith("audio/")) {
      const a = document.createElement("audio") as unknown as HTMLVideoElement;
      a.preload = "metadata";
      a.src = url;
      await loaded(a, "loadedmetadata");
      return { duration: Number.isFinite(a.duration) ? a.duration : null };
    }
  } catch {
    // A file the browser cannot read is still a file: upload it without a picture.
  } finally {
    URL.revokeObjectURL(url);
  }
  return {};
}

interface Job {
  item: UploadItem;
  file: File;
  target: UploadTarget;
  id?: string;
  abort: AbortController;
}

export interface Uploader {
  items(): UploadItem[];
  add(files: Iterable<File>, target?: UploadTarget): void;
  /** Send what is still missing of a failed upload. */
  retry(key: string): void;
  /** Stop an upload and drop it from the list. */
  remove(key: string): void;
  /** Drop finished uploads from the list. */
  clear(): void;
}

export function createUploader(o: UploaderOptions): Uploader {
  const { client } = o;
  const send = o.send ?? xhrSend;
  const describe = o.describe ?? describeMedia;
  const jobs: Job[] = [];
  let running = false;
  let seq = 0;
  const changed = () => o.onChange?.(jobs.map((j) => ({ ...j.item })));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function sendWithRetries(url: () => Promise<string>, body: Blob, headers: Record<string, string> | undefined, job: Job, onProgress: (n: number) => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(await url(), body, { headers, onProgress, signal: job.abort.signal });
      } catch (e) {
        onProgress(0);
        if (job.abort.signal.aborted || attempt >= (o.retries ?? 3)) throw e;
        await wait((o.retryDelayMs ?? 500) * 2 ** attempt);
      }
    }
  }

  async function run(job: Job) {
    const { item, file } = job;
    item.state = "sending";
    item.error = undefined;
    changed();
    let done: number[] = [];
    let partSize = 0;
    let partCount = 0;
    if (!job.id) {
      const r = await client.requestUpload({ name: file.name, mime: file.type || null, size: file.size, ...job.target });
      job.id = r.asset.id;
      if (r.upload.kind === "single") {
        const single = r.upload;
        await sendWithRetries(async () => single.url, file, single.headers, job, (n) => ((item.sent = n), changed()));
      } else ({ partSize, partCount } = r.upload);
    } else {
      // Retry: ask which parts arrived. A small file simply starts over.
      const s = await client.uploadStatus(job.id).catch(() => null);
      if (!s || s.partCount <= 1) {
        job.id = undefined;
        return run(job);
      }
      ({ partSize, partCount, done } = s);
    }
    if (partCount) {
      const id = job.id;
      const have = new Set(done);
      const progress = new Map<number, number>();
      const report = () => {
        let n = 0;
        for (const p of have) n += p === partCount ? file.size - (partCount - 1) * partSize : partSize;
        for (const v of progress.values()) n += v;
        item.sent = Math.min(file.size, n);
        changed();
      };
      report();
      const todo = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !have.has(n));
      const worker = async () => {
        for (let n = todo.shift(); n !== undefined; n = todo.shift()) {
          const part = n;
          const body = file.slice((part - 1) * partSize, Math.min(part * partSize, file.size));
          await sendWithRetries(async () => (await client.uploadPartUrls(id, [part]))[0].url, body, undefined, job, (sent) => (progress.set(part, sent), report()));
          progress.delete(part);
          have.add(part);
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(o.partsInParallel ?? 4, todo.length) }, worker));
    }
    item.sent = file.size;
    changed();
    const facts = await describe(file, file.name);
    let asset = await client.completeUpload(job.id, { width: facts.width, height: facts.height, duration: facts.duration });
    if (facts.thumb) asset = await client.setAssetThumb(asset.id, facts.thumb).catch(() => asset);
    item.asset = asset;
    item.state = "done";
    changed();
    o.onDone?.(item.asset);
  }

  async function pump() {
    if (running) return;
    running = true;
    for (let job = jobs.find((j) => j.item.state === "waiting"); job; job = jobs.find((j) => j.item.state === "waiting")) {
      try {
        await run(job);
      } catch (e) {
        if (!jobs.includes(job)) continue;
        job.item.state = "failed";
        // The CMS explains refusals (wrong type, too large); anything else is the connection.
        job.item.error = e instanceof Error && "code" in e && e.code !== "network" && e.code !== "http" ? e.message : null;
        changed();
      }
    }
    running = false;
  }

  return {
    items: () => jobs.map((j) => ({ ...j.item })),
    add(files, target = {}) {
      for (const file of files) jobs.push({ file, target, abort: new AbortController(), item: { key: `u${++seq}`, name: file.name, size: file.size, sent: 0, state: "waiting" } });
      changed();
      void pump();
    },
    retry(key) {
      const job = jobs.find((j) => j.item.key === key);
      if (!job || job.item.state !== "failed") return;
      job.abort = new AbortController();
      job.item.state = "waiting";
      changed();
      void pump();
    },
    remove(key) {
      const i = jobs.findIndex((j) => j.item.key === key);
      if (i < 0) return;
      const [job] = jobs.splice(i, 1);
      job.abort.abort();
      if (job.id && job.item.state !== "done") void client.abortUpload(job.id).catch(() => {});
      changed();
    },
    clear() {
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].item.state === "done") jobs.splice(i, 1);
      changed();
    },
  };
}

/** "532MB", "1.4GB": the way sizes are shown next to files. */
export function fileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) (n /= 1024), u++;
  return `${u === 0 || n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}${units[u]}`;
}
