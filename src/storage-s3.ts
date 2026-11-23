/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO and others) as a
 * `StorageAdapter`. Requests are signed with `aws4fetch` (no AWS SDK), so it
 * runs anywhere `fetch` and Web Crypto do.
 *
 *   s3Storage({ bucket, region, accessKeyId, secretAccessKey })               // AWS
 *   s3Storage({ bucket, region: "auto", endpoint: "https://<id>.r2.cloudflarestorage.com", …, publicUrl })  // R2
 *
 * The bucket needs a CORS rule that lets your site PUT to it; `agent-cms
 * storage check` prints the rule and tests it.
 */

import { AwsClient } from "aws4fetch";
import type { PutOptions, SignedRequest, StorageAdapter, StorageList, StoragePart, StoredObject } from "./storage";

export interface S3StorageOptions {
  bucket: string;
  /** `auto` for R2. Default `us-east-1`. */
  region?: string;
  /** Leave out for AWS. For others: the S3 API address, without the bucket. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** `https://host/bucket/key` instead of `https://bucket.host/key`. Default: true with `endpoint`, false on AWS. */
  forcePathStyle?: boolean;
  /** Where the bucket's objects are public (a CDN or the bucket's public address), without a trailing slash. */
  publicUrl?: string | null;
  /** Put every key under this folder of the bucket. */
  prefix?: string;
  fetch?: typeof fetch;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly op: string
  ) {
    super(`S3 ${op} failed (${status} ${code}): ${message}`);
    this.name = "S3Error";
  }
}

const unescapeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Text of the first `<tag>` in `xml` (S3 answers are flat enough for this). */
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]) : null;
};
const blocks = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

export function s3Storage(o: S3StorageOptions): StorageAdapter & { readonly options: Readonly<S3StorageOptions> } {
  const region = o.region ?? "us-east-1";
  const pathStyle = o.forcePathStyle ?? !!o.endpoint;
  const endpoint = (o.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
  const root = pathStyle ? `${endpoint}/${o.bucket}` : endpoint.replace(/^(https?:\/\/)/, `$1${o.bucket}.`);
  const prefix = o.prefix ? `${o.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const client = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, sessionToken: o.sessionToken, service: "s3", region, retries: 2 });
  const doFetch = o.fetch ?? fetch;

  const full = (key: string) => prefix + key;
  const enc = (key: string) => full(key).split("/").map(encodeURIComponent).join("/");
  const urlOf = (key: string, query: Record<string, string | number | undefined> = {}) => {
    const u = new URL(`${root}/${enc(key)}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  };
  const putHeaders = (p: PutOptions) => {
    const h: Record<string, string> = { "content-type": p.mime };
    if (p.disposition) h["content-disposition"] = p.disposition;
    if (p.cacheControl) h["cache-control"] = p.cacheControl;
    return h;
  };

  async function call(op: string, url: URL, init: RequestInit = {}, okStatus: number[] = []): Promise<Response> {
    const res = await doFetch(await client.sign(url.toString(), init));
    if (res.ok || okStatus.includes(res.status)) return res;
    const text = await res.text().catch(() => "");
    throw new S3Error(res.status, tag(text, "Code") ?? String(res.status), tag(text, "Message") ?? res.statusText, op);
  }
  /** A URL with the signature in the query string, valid for `expires` seconds. */
  async function presign(method: string, url: URL, expires: number, headers: Record<string, string> = {}): Promise<string> {
    url.searchParams.set("X-Amz-Expires", String(Math.max(1, Math.min(expires, 604800))));
    const signed = await client.sign(url.toString(), { method, headers, aws: { signQuery: true, allHeaders: true } });
    return signed.url;
  }

  return {
    options: o,
    browserOrigins: [new URL(root).origin],
    async presignPut(key, p): Promise<SignedRequest> {
      const headers = putHeaders(p);
      return { url: await presign("PUT", urlOf(key), p.expires, headers), headers };
    },
    async put(key, body, p) {
      await call("put", urlOf(key), { method: "PUT", headers: putHeaders(p), body: body as BodyInit });
    },
    async createMultipart(key, p) {
      const res = await call("createMultipart", urlOf(key, { uploads: "" }), { method: "POST", headers: putHeaders(p) });
      const id = tag(await res.text(), "UploadId");
      if (!id) throw new S3Error(res.status, "NoUploadId", "the storage did not return an upload id", "createMultipart");
      return id;
    },
    presignPart(key, uploadId, partNumber, expires) {
      return presign("PUT", urlOf(key, { partNumber, uploadId }), expires);
    },
    async listParts(key, uploadId) {
      const out: StoragePart[] = [];
      let marker: string | undefined;
      for (let page = 0; page < 20; page++) {
        const xml = await (await call("listParts", urlOf(key, { uploadId, "max-parts": 1000, "part-number-marker": marker }))).text();
        for (const b of blocks(xml, "Part")) out.push({ partNumber: Number(tag(b, "PartNumber")), etag: tag(b, "ETag") ?? "", size: Number(tag(b, "Size") ?? 0) });
        if (tag(xml, "IsTruncated") !== "true") break;
        marker = tag(xml, "NextPartNumberMarker") ?? undefined;
        if (!marker) break;
      }
      return out.sort((a, b) => a.partNumber - b.partNumber);
    },
    async completeMultipart(key, uploadId, parts) {
      const body = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const res = await call("completeMultipart", urlOf(key, { uploadId }), { method: "POST", headers: { "content-type": "application/xml" }, body });
      // S3 can answer 200 with an error in the body.
      const text = await res.text();
      if (/<Error>/.test(text)) throw new S3Error(res.status, tag(text, "Code") ?? "Error", tag(text, "Message") ?? "", "completeMultipart");
    },
    async abortMultipart(key, uploadId) {
      await call("abortMultipart", urlOf(key, { uploadId }), { method: "DELETE" }, [404]);
    },
    async head(key): Promise<StoredObject | null> {
      const res = await call("head", urlOf(key), { method: "HEAD" }, [404]);
      if (res.status === 404) return null;
      return { key, size: Number(res.headers.get("content-length") ?? 0), mime: res.headers.get("content-type"), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") ? new Date(res.headers.get("last-modified")!).toISOString() : null };
    },
    async readStart(key, bytes) {
      // 416: the object is empty.
      const res = await call("read", urlOf(key), { headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` } }, [404, 416]);
      if (res.status === 404) return null;
      if (res.status === 416) return new Uint8Array();
      return new Uint8Array(await res.arrayBuffer()).slice(0, bytes);
    },
    presignGet(key, g) {
      const q: Record<string, string> = {};
      if (g.download) q["response-content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(g.download)}`;
      return presign("GET", urlOf(key, q), g.expires);
    },
    publicUrl(key) {
      return o.publicUrl ? `${o.publicUrl.replace(/\/+$/, "")}/${enc(key)}` : null;
    },
    async copy(from, to) {
      const res = await call("copy", urlOf(to), { method: "PUT", headers: { "x-amz-copy-source": `/${o.bucket}/${enc(from)}` } });
      const text = await res.text();
      if (/<Error>/.test(text)) throw new S3Error(res.status, tag(text, "Code") ?? "Error", tag(text, "Message") ?? "", "copy");
    },
    async delete(key) {
      await call("delete", urlOf(key), { method: "DELETE" }, [404]);
    },
    async list(l = {}): Promise<StorageList> {
      const u = new URL(`${root}/`);
      const q: Record<string, string | number | undefined> = { "list-type": 2, prefix: prefix + (l.prefix ?? ""), delimiter: l.delimiter, "continuation-token": l.cursor ?? undefined, "max-keys": l.limit ?? 1000 };
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
      const xml = await (await call("list", u)).text();
      const strip = (k: string) => (k.startsWith(prefix) ? k.slice(prefix.length) : k);
      return {
        objects: blocks(xml, "Contents").map((b) => ({ key: strip(tag(b, "Key") ?? ""), size: Number(tag(b, "Size") ?? 0), mime: null, etag: tag(b, "ETag"), lastModified: tag(b, "LastModified") })),
        prefixes: blocks(xml, "CommonPrefixes").map((b) => strip(tag(b, "Prefix") ?? "")),
        cursor: tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null,
      };
    },
  };
}

/** The CORS rule a bucket needs so browsers on `origins` can upload to it. */
export function s3CorsRule(origins: readonly string[]) {
  return [{ AllowedOrigins: [...origins], AllowedMethods: ["GET", "HEAD", "PUT"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600 }];
}
