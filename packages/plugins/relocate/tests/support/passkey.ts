import { toBase64Url } from '@ferretry/kernel/session';

/** TEST ONLY: a software authenticator, held in memory, signing the real daemon's WebAuthn challenge. */
export async function testPasskey(deviceId: string, origin: string, createdAt: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  let counter = 0;
  return {
    record: {
      credentialId,
      deviceId,
      origin,
      createdAt,
      algorithm: -8,
      publicKeySpki: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      signCount: 0,
    },
    async prove(
      request: (method: string, path: string, body?: unknown) => Promise<{ status?: number; body?: string }>,
    ) {
      const options = await request('POST', '/v1/step-up/options', { origin });
      if (options.status !== 200)
        throw new Error(
          `test passkey options refused (${String(options.status)}): ${String(JSON.parse(options.body ?? '{}').code)}`,
        );
      const { challenge, rpId } = JSON.parse(options.body ?? '{}') as { challenge: string; rpId: string };
      const client = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
      );
      const auth = new Uint8Array(37);
      auth.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))));
      auth[32] = 0x05; // user present and verified
      new DataView(auth.buffer).setUint32(33, ++counter);
      const signed = new Uint8Array(69);
      signed.set(auth);
      signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', client)), 37);
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, signed));
      const proof = await request('POST', '/v1/step-up', {
        credentialId,
        clientDataJSON: toBase64Url(client),
        authenticatorData: toBase64Url(auth),
        signature: toBase64Url(signature),
      });
      if (proof.status !== 200) throw new Error(`test passkey proof refused (${String(proof.status)})`);
    },
  };
}
