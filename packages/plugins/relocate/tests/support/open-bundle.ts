import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  fromBase64UrlFixed,
  type PrivateKeyHandle,
  utf8Bytes,
  X25519_PUBLIC_KEY_BYTES,
} from '@ferretry/std/sealing';
import {
  BUNDLE_KEY_LABEL,
  type BundleHeader,
  BundleManifestSchema,
  chunkAssociatedData,
  type BundleManifest,
} from '../../contract/index.ts';
import { toHex } from '../../daemon/lib/hex.ts';
import { crypto } from './identity.ts';

export interface OpenedBundle {
  readonly manifest: BundleManifest;
  /** Each entry's bytes, in the manifest's order (`kind:path` is its key). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Everything that was inside, joined: for a search for bytes that must never be there. */
  readonly plaintext: Uint8Array;
}

/**
 * What the TARGET does with what the source sealed: opens every chunk with its one-time key, checks the count and each
 * entry's hash, and reads the manifest. The product's own copy is the import unit's; this one lets the source's tests read
 * a sealed bundle back.
 */
export async function openBundle(
  privateKey: PrivateKeyHandle,
  offerId: string,
  header: BundleHeader,
  chunks: readonly Uint8Array[],
): Promise<OpenedBundle | undefined> {
  if (chunks.length !== header.chunks) return undefined;
  const ephemeral = fromBase64UrlFixed(header.ephemeralKey, X25519_PUBLIC_KEY_BYTES);
  if (ephemeral === null) return undefined;
  const shared = await crypto.deriveSharedSecret(privateKey, ephemeral);
  if (shared === null) return undefined;
  const key = await crypto.deriveKey(shared, utf8Bytes(offerId), BUNDLE_KEY_LABEL, AEAD_KEY_BYTES);
  const opened: Uint8Array[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const plain = await crypto.open(
      key,
      chunk.subarray(0, AEAD_NONCE_BYTES),
      chunkAssociatedData(header, index),
      chunk.subarray(AEAD_NONCE_BYTES),
    );
    if (plain === null) return undefined;
    opened.push(plain);
  }
  const plaintext = new Uint8Array(opened.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of opened) {
    plaintext.set(part, at);
    at += part.length;
  }
  const length = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0, false);
  const manifest = BundleManifestSchema.parse(JSON.parse(new TextDecoder().decode(plaintext.subarray(4, 4 + length))));
  const files = new Map<string, Uint8Array>();
  let offset = 4 + length;
  for (const entry of manifest.entries) {
    const bytes = plaintext.slice(offset, offset + entry.size);
    offset += entry.size;
    if (toHex(await crypto.sha256(bytes)) !== entry.sha256) return undefined;
    files.set(`${entry.kind}:${entry.path}`, bytes);
  }
  return offset === plaintext.length ? { manifest, files, plaintext } : undefined;
}
