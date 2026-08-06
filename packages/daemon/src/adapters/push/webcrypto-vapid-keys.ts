import { join } from 'node:path';
import { z } from 'zod';
import { PushError, type FileSystemPort, type FoundationPaths, type VapidKeyPort } from '../../lib/index.ts';

/**
 * THIS DAEMON'S APPLICATION-SERVER IDENTITY, kept in its own file in the state home.
 *
 * ONE PAIR PER DAEMON, NOT PER DEVICE. The pair is how a push service knows which application server
 * is asking it to wake a browser, and every subscription this daemon holds was created against the
 * same public half — so minting one per pairing would produce a daemon that can only reach the last
 * browser to enrol, and rotating it would silently orphan every enrolment at once.
 *
 * MINTED, NEVER CONFIGURED, for the reason the vault key is: a private key in a configuration document
 * is a private key in a backup, in a dotfile repository and in a screen share. It is created the first
 * time anybody asks for the public half and read on every open after that.
 *
 * THE PRIVATE HALF LEAVES THIS FILE ONLY AS A SIGNATURE. `publicKey` is the whole surface the domain
 * gets; `sign` is handed to the transport and to nothing else. There is no accessor for the key
 * material, no path that renders it and no error that carries it — the same use-without-read shape the
 * secret store has.
 *
 * P-256 comes from the specification, not from taste: Web Push identification is ES256 over prime256v1
 * and nothing else, and Bun's WebCrypto ships it, so this needs no dependency.
 */

const VAPID_MODE = 0o600;

/** Uncompressed EC point: one tag byte, then the two 32-byte coordinates. */
const COORDINATE_BYTES = 32;
const UNCOMPRESSED_TAG = 0x04;

const JsonWebKeySchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  /** The private scalar. The one field that must never be read by anything above this file. */
  d: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
});

const VapidDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privateKeyJwk: JsonWebKeySchema,
});

/** What the transport is allowed to ask of the key pair, and the complete list of it. */
export interface VapidSigner {
  /** The base64url uncompressed point that goes in the `k` parameter of a VAPID authorization. */
  publicKey(): Promise<string>;
  /** One ES256 signature over the signing input, as the raw `r || s` pair a JWS carries. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

interface VapidIdentity {
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}

/**
 * WebCrypto rejects a `SharedArrayBuffer`-backed view, so every buffer handed to it is copied into one
 * over a plain `ArrayBuffer`. A cast would satisfy the compiler while saying something untrue about
 * where the bytes live.
 */
function owned(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string, field: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== COORDINATE_BYTES)
    throw new PushError('corrupt_store', `the notification signing key has a malformed ${field} coordinate`);
  return owned(bytes);
}

/** The public point, derived from the stored coordinates rather than stored a second time beside them. */
function uncompressedPoint(x: string, y: string): string {
  const point = new Uint8Array(1 + COORDINATE_BYTES * 2);
  point[0] = UNCOMPRESSED_TAG;
  point.set(fromBase64Url(x, 'x'), 1);
  point.set(fromBase64Url(y, 'y'), 1 + COORDINATE_BYTES);
  return base64Url(point);
}

export class StateVapidKeys implements VapidKeyPort, VapidSigner {
  private readonly path: string;
  private identity: VapidIdentity | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'>,
    private readonly generate: () => Promise<CryptoKeyPair> = async () =>
      await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ) {
    this.path = join(paths.state, 'push-vapid.json');
  }

  async publicKey(): Promise<string> {
    return (await this.open()).publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      (await this.open()).privateKey,
      owned(message),
    );
    return new Uint8Array(signature);
  }

  /**
   * The pair, minting one on first use.
   *
   * SERIALIZED, because two concurrent enrolments would otherwise both find no file, both generate,
   * and one would overwrite the other's key — invalidating a subscription that had just been created
   * against it. The first caller through mints; everyone else reads what it wrote.
   */
  private async open(): Promise<VapidIdentity> {
    const operation = this.queue.then(async () => {
      this.identity ??= await this.load();
      return this.identity;
    });
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  private async load(): Promise<VapidIdentity> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return await this.mint();
    const document = VapidDocumentSchema.safeParse(parseDocument(raw));
    if (!document.success)
      throw new PushError('corrupt_store', 'the notification signing key is not a usable P-256 key');
    return await this.adopt(document.data.privateKeyJwk);
  }

  private async mint(): Promise<VapidIdentity> {
    const pair = await this.generate();
    const jwk = JsonWebKeySchema.parse(await crypto.subtle.exportKey('jwk', pair.privateKey));
    await this.files.writeTextAtomic(this.path, `${JSON.stringify({ schemaVersion: 1, privateKeyJwk: jwk })}\n`);
    await this.files.setMode(this.path, VAPID_MODE);
    return await this.adopt(jwk);
  }

  /**
   * Re-imports the stored key with `sign` as its ONLY permitted use and extraction refused.
   *
   * Only the five fields the curve needs are passed through, so an exported `key_ops` or `ext` cannot
   * widen what the imported handle may do, and a document somebody edited to claim broader use has no
   * effect on the key this daemon actually holds.
   */
  private async adopt(jwk: z.infer<typeof JsonWebKeySchema>): Promise<VapidIdentity> {
    // The point is derived FIRST, because it is the cheap structural check: coordinates of the wrong
    // size are named as a damaged document rather than surfacing as whatever the curve implementation
    // decides to throw.
    const publicKey = uncompressedPoint(jwk.x, jwk.y);
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );
      return { privateKey, publicKey };
    } catch {
      // A stored key the curve refuses is damage in the same sense a truncated one is: this daemon has
      // a signing key it cannot sign with, and saying so beats a raw platform exception.
      throw new PushError('corrupt_store', 'the notification signing key is not a usable P-256 key');
    }
  }
}

/**
 * A damaged signing key is `corrupt_store`, never "absent".
 *
 * Treating an unreadable document as no key at all would mint a fresh pair and silently break every
 * subscription already enrolled against the old one — a fleet of phones that stop being reachable with
 * nothing anywhere reporting a fault.
 */
function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PushError('corrupt_store', 'the notification signing key is not valid JSON');
  }
}
