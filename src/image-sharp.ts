/**
 * Image sizes made with sharp (`npm install sharp`). Node only.
 *
 *   import { sharpTransforms } from "@mainsoft/agent-cms/image-sharp";
 *
 *   createCms({
 *     media: {
 *       stores: { ... },
 *       transforms: sharpTransforms({
 *         presets: { thumb: { width: 480 }, card: { width: 800, height: 450, fit: "cover" }, full: { width: 1600 } },
 *       }),
 *     },
 *   });
 *
 * Only the sizes named here exist: `/api/cms/files/<id>/<name>?size=card`.
 * Nobody can ask for an arbitrary width, so nobody can fill the store with
 * copies. A size is made the first time it is asked for and kept in the
 * store under `_cms/derived/`.
 */

import type { ImageFormat, ImageJob, ImagePreset, ImageTransforms } from "./assets";

/** No size may be wider or taller than this. */
export const MAX_IMAGE_SIDE = 4096;

export interface SharpTransformsOptions {
  /** Name → size. Names are lowercase letters, digits, `-` and `_`. */
  presets: Record<string, ImagePreset>;
  /** The first one is the format of sizes that do not name their own. Default `["webp"]`. */
  formats?: readonly ImageFormat[];
  /** Originals above this many bytes are served as they are. Default 40MB. */
  maxInputBytes?: number;
  /** Originals with more pixels than this are served as they are. Default 100 million. */
  maxInputPixels?: number;
  /** Copies made at the same time. Default 4. */
  concurrency?: number;
  /** A request waits this long for a copy, then gets the original. Default 10000. */
  timeoutMs?: number;
}

/** The part of sharp this file uses (its own typings differ between versions). */
interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  rotate(): SharpImage;
  resize(a: number | { width?: number; height?: number; fit?: string; withoutEnlargement?: boolean }, b?: number, c?: { fit?: string }): SharpImage;
  extract(r: { left: number; top: number; width: number; height: number }): SharpImage;
  toFormat(format: string, o?: { quality?: number }): SharpImage;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: { width: number; height: number } }>;
}
type SharpFn = (input: Uint8Array, o?: { limitInputPixels?: number }) => SharpImage;

const FORMATS: readonly ImageFormat[] = ["webp", "avif", "jpeg", "png"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function sharpTransforms(o: SharpTransformsOptions): ImageTransforms {
  const g = globalThis as { EdgeRuntime?: unknown; process?: { env?: Record<string, string | undefined>; versions?: { node?: string } } };
  if (typeof g.EdgeRuntime === "string" || g.process?.env?.NEXT_RUNTIME === "edge" || !g.process?.versions?.node) {
    throw new Error("agent-cms: sharpTransforms() needs the Node.js runtime (sharp does not run on the Edge runtime). Move the CMS route to Node (`export const runtime = \"nodejs\"`) or leave `media.transforms` out there.");
  }
  const format = o.formats?.[0] ?? "webp";
  for (const f of [format, ...(o.formats ?? [])]) if (!FORMATS.includes(f)) throw new Error(`agent-cms: sharpTransforms: unknown format "${f}" (use ${FORMATS.join(", ")})`);
  const side = (name: string, which: string, v: unknown) => {
    if (v === undefined) return;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_IMAGE_SIDE) throw new Error(`agent-cms: sharpTransforms: size "${name}" has ${which} ${String(v)}; use a whole number from 1 to ${MAX_IMAGE_SIDE}`);
  };
  for (const [name, p] of Object.entries(o.presets)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`agent-cms: sharpTransforms: "${name}" is not a size name (lowercase letters, digits, - and _)`);
    side(name, "width", p.width);
    side(name, "height", p.height);
    if (!p.width && !p.height) throw new Error(`agent-cms: sharpTransforms: size "${name}" needs a width or a height`);
    if (p.fit === "cover" && !(p.width && p.height)) throw new Error(`agent-cms: sharpTransforms: size "${name}" uses fit "cover", which needs both a width and a height`);
    if (p.format && !FORMATS.includes(p.format)) throw new Error(`agent-cms: sharpTransforms: size "${name}" has the unknown format "${p.format}"`);
    if (p.quality !== undefined && !(p.quality >= 1 && p.quality <= 100)) throw new Error(`agent-cms: sharpTransforms: size "${name}" has quality ${p.quality}; use 1 to 100`);
  }
  const limitInputPixels = o.maxInputPixels ?? 100_000_000;

  // Loaded on first use, so importing this file costs nothing and its absence is one clear message.
  let lib: Promise<SharpFn> | null = null;
  const load = () =>
    (lib ??= import("sharp").then(
      (m) => (m as unknown as { default?: SharpFn }).default ?? (m as unknown as SharpFn),
      (e) => {
        lib = null;
        throw new Error(`agent-cms: sharpTransforms() could not load "sharp" (npm install sharp): ${e instanceof Error ? e.message : String(e)}`);
      }
    ));

  return {
    presets: { ...o.presets },
    format,
    maxInputBytes: o.maxInputBytes,
    concurrency: o.concurrency,
    timeoutMs: o.timeoutMs,
    async make(bytes: Uint8Array, job: ImageJob) {
      const sharp = await load();
      const meta = await sharp(bytes, { limitInputPixels }).metadata();
      // Phones store photos sideways with a note on how to turn them: sizes are counted after the turn.
      const turned = (meta.orientation ?? 1) >= 5;
      const w = (turned ? meta.height : meta.width) ?? 0;
      const h = (turned ? meta.width : meta.height) ?? 0;
      if (!w || !h) throw new Error("not a picture sharp can read");
      let img = sharp(bytes, { limitInputPixels }).rotate();
      if (job.fit === "cover" && job.width && job.height) {
        // Never enlarge: a picture smaller than the box gives a smaller copy of the same shape.
        const k = Math.min(1, w / job.width, h / job.height);
        const W = Math.max(1, Math.round(job.width * k));
        const H = Math.max(1, Math.round(job.height * k));
        const scale = Math.max(W / w, H / h);
        const rw = Math.max(W, Math.round(w * scale));
        const rh = Math.max(H, Math.round(h * scale));
        // Cut the box out around the focal point (the middle when none is set), staying inside the picture.
        const f = job.focal ?? { x: 0.5, y: 0.5 };
        img = img.resize(rw, rh, { fit: "fill" }).extract({ left: clamp(Math.round(f.x * rw - W / 2), 0, rw - W), top: clamp(Math.round(f.y * rh - H / 2), 0, rh - H), width: W, height: H });
      } else {
        img = img.resize({ width: job.width ?? undefined, height: job.height ?? undefined, fit: "inside", withoutEnlargement: true });
      }
      // Camera data (location, device) is not copied into the result: sharp drops it unless asked to keep it.
      const { data, info } = await img.toFormat(job.format, job.quality ? { quality: job.quality } : {}).toBuffer({ resolveWithObject: true });
      return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
    },
  };
}
