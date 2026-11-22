/**
 * Passkeys (WebAuthn level 3), server side, without a dependency: the
 * options a browser passes to `navigator.credentials.create/get`, and the
 * checks on what it sends back. Signatures: ES256, RS256 and EdDSA.
 *
 * Attestation is not used (`attestation: "none"`): a CMS has no list of
 * approved authenticators to compare against, so the attestation statement
 * is not read and the key is trusted on first use, like every consumer site.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "node:crypto";

export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string) => Buffer.from(s, "base64url");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- CBOR

type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/** Reads one CBOR item (RFC 8949): what authenticators send. Returns it and where it ended. */
export function cborDecode(buf: Uint8Array, at = 0): { value: Cbor; end: number } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = (pos: number): { value: Cbor; end: number } => {
    if (pos >= b.length) throw new Error("cbor: truncated");
    const head = b[pos];
    const major = head >> 5;
    const info = head & 31;
    let len: number;
    let p = pos + 1;
    if (info < 24) len = info;
    else if (info === 24) (len = b[p]), (p += 1);
    else if (info === 25) (len = b.readUInt16BE(p)), (p += 2);
    else if (info === 26) (len = b.readUInt32BE(p)), (p += 4);
    else if (info === 27) {
      const big = b.readBigUInt64BE(p);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: too large");
      len = Number(big);
      p += 8;
    } else if (major === 7 && info === 31) throw new Error("cbor: break");
    else throw new Error("cbor: indefinite lengths are not supported");
    switch (major) {
      case 0:
        return { value: len, end: p };
      case 1:
        return { value: -1 - len, end: p };
      case 2:
        if (p + len > b.length) throw new Error("cbor: truncated");
        return { value: new Uint8Array(b.subarray(p, p + len)), end: p + len };
      case 3:
        if (p + len > b.length) throw new Error("cbor: truncated");
        return { value: b.subarray(p, p + len).toString("utf8"), end: p + len };
      case 4: {
        const arr: Cbor[] = [];
        for (let i = 0; i < len; i++) {
          const r = read(p);
          arr.push(r.value);
          p = r.end;
        }
        return { value: arr, end: p };
      }
      case 5: {
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < len; i++) {
          const k = read(p);
          const v = read(k.end);
          map.set(k.value, v.value);
          p = v.end;
        }
        return { value: map, end: p };
      }
      case 6:
        return read(p); // a tag: keep the value
      default:
        if (info === 20) return { value: false, end: p };
        if (info === 21) return { value: true, end: p };
        if (info === 22) return { value: null, end: p };
        if (info === 23) return { value: undefined, end: p };
        throw new Error("cbor: unsupported simple value");
    }
  };
  return read(at);
}

/** Writes CBOR (for tests and software authenticators). */
export function cborEncode(v: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) {
      const x = Buffer.alloc(3);
      x[0] = (major << 5) | 25;
      x.writeUInt16BE(n, 1);
      return x;
    }
    const x = Buffer.alloc(5);
    x[0] = (major << 5) | 26;
    x.writeUInt32BE(n, 1);
    return x;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  return Buffer.from([0xf6]);
}

// ---------------------------------------------------------------- keys

export const ALG = { ES256: -7, EdDSA: -8, RS256: -257 } as const;

/** A COSE public key (from the authenticator) as a JWK Node can read. */
export function coseToJwk(cose: Map<Cbor, Cbor>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (k: number) => {
    const x = cose.get(k);
    if (!(x instanceof Uint8Array)) throw new Error(`cose: missing ${k}`);
    return b64url(x);
  };
  if (kty === 2 && alg === ALG.ES256) {
    if (cose.get(-1) !== 1) throw new Error("cose: only P-256");
    return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, alg };
  }
  if (kty === 3 && alg === ALG.RS256) return { jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, alg };
  if (kty === 1 && alg === ALG.EdDSA) {
    if (cose.get(-1) !== 6) throw new Error("cose: only Ed25519");
    return { jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, alg };
  }
  throw new Error(`cose: key type ${String(kty)} / alg ${String(alg)} not supported`);
}

export function verifyWith(jwk: JsonWebKey, alg: number, data: Uint8Array, sig: Uint8Array): boolean {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (alg === ALG.ES256) return verifySig("sha256", data, { key, dsaEncoding: "der" }, sig);
  if (alg === ALG.RS256) return verifySig("sha256", data, key, sig);
  if (alg === ALG.EdDSA) return verifySig(null, data, key, sig);
  return false;
}

// ---------------------------------------------------------------- authenticator data

export interface AuthData {
  rpIdHash: Buffer;
  /** User present. */
  up: boolean;
  /** User verified (PIN, fingerprint, face). */
  uv: boolean;
  /** Backup eligible / backed up: a synced passkey. */
  be: boolean;
  bs: boolean;
  signCount: number;
  credential?: { id: Buffer; jwk: JsonWebKey; alg: number; aaguid: string };
}

export function parseAuthData(raw: Uint8Array): AuthData {
  const b = Buffer.from(raw);
  if (b.length < 37) throw new Error("authData too short");
  const flags = b[32];
  const out: AuthData = { rpIdHash: b.subarray(0, 32), up: !!(flags & 1), uv: !!(flags & 4), be: !!(flags & 8), bs: !!(flags & 16), signCount: b.readUInt32BE(33) };
  if (flags & 64) {
    const aaguid = b.subarray(37, 53).toString("hex");
    const len = b.readUInt16BE(53);
    const id = b.subarray(55, 55 + len);
    if (id.length !== len) throw new Error("authData: credential id cut short");
    const key = cborDecode(b, 55 + len);
    if (!(key.value instanceof Map)) throw new Error("authData: no public key");
    const { jwk, alg } = coseToJwk(key.value);
    out.credential = { id: Buffer.from(id), jwk, alg, aaguid };
  }
  return out;
}

// ---------------------------------------------------------------- ceremonies

export interface RelyingParty {
  /** The site's host name (no port), e.g. "cms.example.com". */
  id: string;
  name: string;
  /** Pages allowed to use passkeys, e.g. ["https://cms.example.com"]. */
  origins: string[];
}

export function newChallenge(): string {
  return b64url(randomBytes(32));
}

export interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "preferred" };
  excludeCredentials: { type: "public-key"; id: string; transports?: string[] }[];
  hints?: string[];
}

export function registrationOptions(rp: RelyingParty, user: { id: string; email: string; name: string | null }, challenge: string, exclude: { id: string; transports?: string[] }[]): RegistrationOptions {
  return {
    challenge,
    rp: { id: rp.id, name: rp.name },
    user: { id: b64url(Buffer.from(user.id)), name: user.email, displayName: user.name || user.email },
    pubKeyCredParams: [ALG.ES256, ALG.EdDSA, ALG.RS256].map((alg) => ({ type: "public-key" as const, alg })),
    timeout: 300_000,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    excludeCredentials: exclude.map((c) => ({ type: "public-key" as const, id: c.id, ...(c.transports ? { transports: c.transports } : {}) })),
  };
}

export function loginOptions(rp: RelyingParty, challenge: string) {
  // No allowCredentials: the browser offers the passkeys it has for this site (no email typed first).
  return { challenge, rpId: rp.id, timeout: 300_000, userVerification: "preferred" as const, allowCredentials: [] as never[] };
}

export class PasskeyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function checkClientData(json: Buffer, type: string, challenge: string, rp: RelyingParty) {
  let c: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    c = JSON.parse(json.toString("utf8"));
  } catch {
    throw new PasskeyError("client data is not JSON");
  }
  if (c.type !== type) throw new PasskeyError("wrong ceremony");
  if (c.challenge !== challenge) throw new PasskeyError("challenge does not match");
  if (!c.origin || !rp.origins.includes(c.origin)) throw new PasskeyError(`origin ${c.origin ?? "missing"} is not allowed`);
  if (c.crossOrigin) throw new PasskeyError("cross-origin frame");
}

export interface RegistrationResponse {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface VerifiedRegistration {
  credentialId: string;
  jwk: JsonWebKey;
  alg: number;
  signCount: number;
  aaguid: string;
  backedUp: boolean;
  userVerified: boolean;
  transports: string[];
}

export function verifyRegistration(r: RegistrationResponse, o: { challenge: string; rp: RelyingParty; requireUserVerification?: boolean }): VerifiedRegistration {
  if (r.type !== "public-key") throw new PasskeyError("not a public key credential");
  checkClientData(fromB64url(r.response.clientDataJSON), "webauthn.create", o.challenge, o.rp);
  let att: Cbor;
  try {
    att = cborDecode(fromB64url(r.response.attestationObject)).value;
  } catch {
    throw new PasskeyError("attestation is not CBOR");
  }
  if (!(att instanceof Map)) throw new PasskeyError("attestation is not a map");
  const authData = att.get("authData");
  if (!(authData instanceof Uint8Array)) throw new PasskeyError("no authenticator data");
  let a: AuthData;
  try {
    a = parseAuthData(authData);
  } catch (e) {
    throw new PasskeyError(e instanceof Error ? e.message : "bad authenticator data");
  }
  if (!a.rpIdHash.equals(sha256(Buffer.from(o.rp.id)))) throw new PasskeyError("made for another site");
  if (!a.up) throw new PasskeyError("user not present");
  if (o.requireUserVerification && !a.uv) throw new PasskeyError("user not verified");
  if (!a.credential) throw new PasskeyError("no credential in the response");
  if (b64url(a.credential.id) !== r.id) throw new PasskeyError("credential id does not match");
  return { credentialId: r.id, jwk: a.credential.jwk, alg: a.credential.alg, signCount: a.signCount, aaguid: a.credential.aaguid, backedUp: a.bs, userVerified: a.uv, transports: (r.response.transports ?? []).filter((t) => /^[a-z-]{2,20}$/.test(t)).slice(0, 6) };
}

export interface AssertionResponse {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export function verifyAssertion(r: AssertionResponse, o: { challenge: string; rp: RelyingParty; jwk: JsonWebKey; alg: number; signCount: number; userId: string; requireUserVerification?: boolean }): { signCount: number; userVerified: boolean; backedUp: boolean } {
  if (r.type !== "public-key") throw new PasskeyError("not a public key credential");
  const clientData = fromB64url(r.response.clientDataJSON);
  checkClientData(clientData, "webauthn.get", o.challenge, o.rp);
  const raw = fromB64url(r.response.authenticatorData);
  let a: AuthData;
  try {
    a = parseAuthData(raw);
  } catch (e) {
    throw new PasskeyError(e instanceof Error ? e.message : "bad authenticator data");
  }
  if (!a.rpIdHash.equals(sha256(Buffer.from(o.rp.id)))) throw new PasskeyError("made for another site");
  if (!a.up) throw new PasskeyError("user not present");
  if (o.requireUserVerification && !a.uv) throw new PasskeyError("user not verified");
  if (r.response.userHandle && fromB64url(r.response.userHandle).toString("utf8") !== o.userId) throw new PasskeyError("passkey belongs to someone else");
  const ok = verifyWith(o.jwk, o.alg, Buffer.concat([raw, sha256(clientData)]), fromB64url(r.response.signature));
  if (!ok) throw new PasskeyError("signature does not match");
  // A counter that does not go up means a copied authenticator (synced passkeys always send 0).
  if ((a.signCount > 0 || o.signCount > 0) && a.signCount <= o.signCount) throw new PasskeyError("signature counter went back");
  return { signCount: a.signCount, userVerified: a.uv, backedUp: a.bs };
}
