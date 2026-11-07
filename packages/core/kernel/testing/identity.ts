import type { DaemonSigningKey } from '../host/session/wire/crypto.ts';
import { toBase64Url } from '../host/session/wire/binary.ts';

/** A throwaway daemon identity for tests: a fresh Ed25519 key that never leaves this process. */
export interface TestIdentity {
  readonly daemonId: string;
  readonly publicKeySpki: Uint8Array;
  readonly key: DaemonSigningKey;
}

/** Mints a {@link TestIdentity} with WebCrypto (non-extractable private half). */
export async function testIdentity(): Promise<TestIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const publicKeySpki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const daemonId = `fy_daemon_${toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeySpki)))}`;
  const key: DaemonSigningKey = {
    publicKeySpki,
    daemonId,
    sign: async message => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new Uint8Array(message))),
  };
  return { daemonId, publicKeySpki, key };
}
