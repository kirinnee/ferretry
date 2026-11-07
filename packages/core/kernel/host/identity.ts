import { generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import type { HostFs } from './adapters/node-fs.ts';

/**
 * The daemon's identity (§2.2 Kernel, §9.2 `state/kernel/identity.json`, `0600`): an Ed25519 signing key. The
 * daemon id is `fy_daemon_` + the base64url SHA-256 of the SubjectPublicKeyInfo (today's rule, R17/R41), so the
 * browser, the relay and the daemon compute one fingerprint. The private key never leaves this module.
 *
 * D17 (lead decision 6): the file keeps TODAY's layout byte for byte as v5 format 1 —
 * `{"schemaVersion":1,"privateKeyPem":"<PKCS#8 PEM>"}` and a newline — so a v4 key moves across unread and every
 * paired device keeps working. `schemaVersion: 1` is this file's format field; the reader accepts exactly that.
 */
export interface DaemonIdentity {
  /** base64url SHA-256 of the SPKI DER. */
  readonly fingerprint: string;
  /** `fy_daemon_<fingerprint>`: the id the pairing QR and the rendezvous claim carry. */
  readonly daemonId: string;
  readonly publicKeySpki: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export const IDENTITY_FILE = 'state/kernel/identity.json';
const IdentityFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privateKeyPem: z.string().min(1),
});

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export type IdentityOutcome =
  | { readonly kind: 'ready'; readonly identity: DaemonIdentity; readonly created: boolean }
  | { readonly kind: 'damaged'; readonly sentence: string };

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem);
  if (match === null) throw new TypeError('not a PKCS#8 PEM');
  return owned(Buffer.from((match[1] as string).replace(/\s+/g, ''), 'base64'));
}

export async function identityFromPem(pem: string): Promise<DaemonIdentity> {
  const pkcs8 = pemBody(pem);
  const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', exportable);
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
    daemonId: `fy_daemon_${fingerprint}`,
    publicKeySpki: spki,
    sign: async (bytes: Uint8Array) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, owned(bytes))),
  });
}

/** Today's writer, byte for byte: Node's PKCS#8 PEM export inside `{"schemaVersion":1,"privateKeyPem":…}\n`. */
export function identityFileText(privateKeyPem: string): string {
  return `${JSON.stringify({ schemaVersion: 1, privateKeyPem })}\n`;
}

/**
 * Loads the identity, or creates it on a home that has none. A file that does not parse is DAMAGED, never replaced:
 * a new key would silently rename this daemon to every paired device (§9.3 "damaged is not empty").
 */
export async function loadIdentity(fs: HostFs, home: string): Promise<IdentityOutcome> {
  const path = `${home}/${IDENTITY_FILE}`;
  const info = await fs.lstat(path);
  if (info === undefined) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await fs.writeAtomic(path, identityFileText(privateKeyPem), 0o600);
    return { kind: 'ready', identity: await identityFromPem(privateKeyPem), created: true };
  }
  try {
    const parsed = IdentityFileSchema.safeParse(JSON.parse(await fs.readText(path)));
    if (!parsed.success)
      return {
        kind: 'damaged',
        sentence: `${path} is not a daemon identity file this daemon can read; restore it from a backup.`,
      };
    await fs.chmod(path, 0o600);
    return { kind: 'ready', identity: await identityFromPem(parsed.data.privateKeyPem), created: false };
  } catch {
    return { kind: 'damaged', sentence: `${path} cannot be read; restore it from a backup.` };
  }
}

/** At most this many characters of a daemon name (today's `PAIRING_DEVICE_NAME_MAX_LENGTH`). */
export const DAEMON_NAME_MAX_LENGTH = 100;

/**
 * Today's `normalizeDaemonName`, byte for byte: hostnames are platform text, not a display-name contract, so control
 * and format characters go, the rest is trimmed and bounded, and an empty result is `Ferretry daemon`.
 */
export function daemonNameFrom(hostname: string): string {
  const cleaned = hostname.replaceAll(/[\p{Cc}\p{Cf}]/gu, '').trim();
  let bounded = '';
  for (const symbol of cleaned) {
    if (bounded.length + symbol.length > DAEMON_NAME_MAX_LENGTH) break;
    bounded += symbol;
  }
  const name = bounded.trim();
  return name === '' ? 'Ferretry daemon' : name;
}
