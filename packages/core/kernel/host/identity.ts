import { z } from 'zod';
import type { HostFs } from './adapters/node-fs.ts';

/**
 * The daemon's identity (§2.2 Kernel, §9.2 `state/kernel/identity.json`, `0600`): an Ed25519 signing key. The
 * daemon id is the SHA-256 of the SubjectPublicKeyInfo, base64url (today's relay identity rule), so the browser, the
 * relay and the daemon compute one fingerprint. The private key never leaves this module: callers get `sign`.
 */
export interface DaemonIdentity {
  /** base64url SHA-256 of the SPKI DER. */
  readonly fingerprint: string;
  readonly publicKeySpki: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

const IDENTITY_FORMAT = 1;
const IdentityFileSchema = z.strictObject({
  format: z.literal(IDENTITY_FORMAT),
  privateKeyPkcs8: z.string().min(1),
});

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export type IdentityOutcome =
  | { readonly kind: 'ready'; readonly identity: DaemonIdentity; readonly created: boolean }
  | { readonly kind: 'damaged'; readonly sentence: string };

const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function fromPkcs8(source: Uint8Array): Promise<DaemonIdentity> {
  const pkcs8 = owned(source);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const fingerprint = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));
  const signer = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return Object.freeze({
    fingerprint,
    publicKeySpki: spki,
    sign: async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, owned(bytes))),
  });
}

/**
 * Loads the identity, or creates it on a home that has none. A file that does not parse is DAMAGED, never replaced:
 * a new key would silently rename this daemon to every paired device (§9.3 "damaged is not empty").
 */
export async function loadIdentity(fs: HostFs, home: string): Promise<IdentityOutcome> {
  const path = `${home}/state/kernel/identity.json`;
  const info = await fs.lstat(path);
  if (info === undefined) {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    await fs.writeAtomic(
      path,
      `${JSON.stringify({ format: IDENTITY_FORMAT, privateKeyPkcs8: base64url(pkcs8) })}\n`,
      0o600,
    );
    return { kind: 'ready', identity: await fromPkcs8(pkcs8), created: true };
  }
  try {
    const parsed = IdentityFileSchema.safeParse(JSON.parse(await fs.readText(path)));
    if (!parsed.success)
      return { kind: 'damaged', sentence: `${path} is not a format-1 identity file; restore it from a backup.` };
    await fs.chmod(path, 0o600);
    return {
      kind: 'ready',
      identity: await fromPkcs8(new Uint8Array(Buffer.from(parsed.data.privateKeyPkcs8, 'base64url'))),
      created: false,
    };
  } catch {
    return { kind: 'damaged', sentence: `${path} cannot be read; restore it from a backup.` };
  }
}
