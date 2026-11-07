/** TODO(kernel contract): pure wire copies, identical to today's key checks; never a kernel host import. */
import { z } from 'zod';
import { fromBase64UrlFixed, isAllZero, ED25519_SPKI_BYTES, X25519_PUBLIC_KEY_BYTES } from './kernel-wire/index.ts';
export * from './kernel-wire/index.ts';
export type { SessionCrypto as RelayCrypto } from './kernel-wire/index.ts';
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00] as const;

const base64UrlOf = (byteLength: number): z.ZodString =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, 'not base64url')
    .length(Math.ceil((byteLength * 4) / 3), 'wrong encoded length');

export const DeviceKeySchema = base64UrlOf(ED25519_SPKI_BYTES).refine(
  text => deviceKeyBytes(text) !== null,
  'not an Ed25519 public key',
);

export function deviceKeyBytes(text: string): Uint8Array | null {
  const bytes = fromBase64UrlFixed(text, ED25519_SPKI_BYTES);
  if (bytes === null) return null;
  return ED25519_SPKI_PREFIX.every((byte, index) => bytes[index] === byte) ? bytes : null;
}
export const MemberKeySchema = DeviceKeySchema;

export const MemberBoxKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, 'expected 32 bytes as base64url')
  .refine(text => {
    const bytes = fromBase64UrlFixed(text, X25519_PUBLIC_KEY_BYTES);
    return bytes !== null && !isAllZero(bytes);
  }, 'the all-zero X25519 key');
export * from './catalog-wire/catalog-signature.ts';
export * from './catalog-wire/link-bundle.ts';
export * from './catalog-wire/link-store.ts';
export {
  signCatalogManifest,
  signCatalogItemVersions,
  signCatalogLink,
  type CatalogSigningIdentity,
} from './signatures.ts';
