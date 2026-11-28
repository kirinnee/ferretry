import { concatBytes, lengthPrefixed, utf8Bytes } from './binary.ts';
import type { RelocateBundleSignRequest } from '../../../contract/session.ts';

/** Kept byte-identical to Relocate's bundleSignedBytes; independent label, sign-only. */
export function relocateBundleSignedBytes(
  header: RelocateBundleSignRequest & {
    readonly sourceDaemonId: string;
    readonly identityKey: string;
  },
): Uint8Array {
  return concatBytes(
    [
      'ferretry-relocate-bundle-v1',
      String(header.v),
      header.offerId,
      header.sourceDaemonId,
      header.identityKey,
      header.targetDaemonId,
      header.expiresAt,
      header.ephemeralKey,
      String(header.chunks),
      String(header.bytes),
    ].map(field => lengthPrefixed(utf8Bytes(field))),
  );
}
