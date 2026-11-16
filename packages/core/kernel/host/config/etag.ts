import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * The etag of a config file's text: an HMAC-SHA256 under a key only this daemon holds, hex. The etag goes to every
 * `fleet.use` reader (`GET /v1/config/file`, the `kernel.config-changed` frame, `GET /v1/config/status`), and a plain
 * sha256 of the text would let one guess a short hidden value offline when the rest of the file is known. Without the
 * key a reader can still compare two etags (that a file changed is the point of one), but cannot test a guess.
 */
export type ConfigEtagger = (text: string) => string;

/** What names the key's purpose: the daemon signs it, so the key is bound to this purpose and to this daemon alone. */
const KEY_PURPOSE = 'ferretry/kernel/config-etag/v1';

/** A key that lives as long as the service and is never written down: for one nobody handed the daemon's own key (a test, a tool). */
export const ephemeralConfigEtagKey = (): Uint8Array => new Uint8Array(randomBytes(32));

/**
 * The daemon's etag key, derived from its identity: Ed25519 signs deterministically, so the same daemon gets the same
 * key after every restart (an editor's `If-Match` and the write-set record survive one) with no second secret file to
 * keep, and nobody without the identity's private key can compute it. The signature is hashed down to 32 bytes.
 */
export async function configEtagKey(identity: { sign(bytes: Uint8Array): Promise<Uint8Array> }): Promise<Uint8Array> {
  const signature = await identity.sign(new TextEncoder().encode(KEY_PURPOSE));
  return new Uint8Array(createHash('sha256').update(signature).digest());
}

export const configEtagger =
  (key: Uint8Array): ConfigEtagger =>
  text =>
    createHmac('sha256', key).update(text, 'utf8').digest('hex');
