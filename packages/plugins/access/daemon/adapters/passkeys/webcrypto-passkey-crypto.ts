import type { PasskeyAlgorithm, PasskeyCrypto } from '../../lib/passkeys/index.ts';

/**
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`, so every buffer handed to it is copied
 * into one this adapter owns rather than cast.
 */
function owned(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

const IMPORT: Record<PasskeyAlgorithm, Parameters<SubtleCrypto['importKey']>[2]> = {
  [-7]: { name: 'ECDSA', namedCurve: 'P-256' },
  [-8]: { name: 'Ed25519' },
  [-257]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
};

const VERIFY: Record<PasskeyAlgorithm, Parameters<SubtleCrypto['verify']>[0]> = {
  [-7]: { name: 'ECDSA', hash: 'SHA-256' },
  [-8]: { name: 'Ed25519' },
  [-257]: { name: 'RSASSA-PKCS1-v1_5' },
};

/** The passkey verifier's crypto, on the platform's WebCrypto and nothing else. */
export class WebCryptoPasskeyCrypto implements PasskeyCrypto {
  async sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', owned(bytes)));
  }

  async verify(
    algorithm: PasskeyAlgorithm,
    spki: Uint8Array,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean> {
    const key = await crypto.subtle.importKey('spki', owned(spki), IMPORT[algorithm], false, ['verify']);
    return crypto.subtle.verify(VERIFY[algorithm], key, owned(signature), owned(data));
  }
}
