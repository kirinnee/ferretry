/**
 * OpenSSH key bytes, in process: an ed25519 key pair made with `node:crypto`, its private half written as an
 * unencrypted `openssh-key-v1` file (what `ssh-add -` reads), and the public half as the one-line form GitHub takes.
 * Pure: no file, no process. The private text is returned to its one caller (the sealed document) and goes nowhere else.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

const KEY_TYPE = 'ssh-ed25519';

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}
function text(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return concat([uint32(bytes.length), bytes]);
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `SHA256:` + the unpadded base64 of the SHA-256 of the key blob, as `ssh-keygen -l` prints it. */
export function fingerprintOfBlob(blob: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`;
}

export interface ParsedPublicKey {
  readonly type: string;
  /** The base64 body, exactly as written. */
  readonly body: string;
  readonly fingerprint: string;
  /** `type body`: the key without its comment, the form GitHub compares. */
  readonly bare: string;
}

/** Reads one OpenSSH public key line; `undefined` when it is not one (wrong shape, or a body that is not a key blob of that type). */
export function parsePublicKey(line: string): ParsedPublicKey | undefined {
  const match = /^([a-z0-9@.-]{3,64}) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{0,200})?$/u.exec(line.trim());
  if (match === null) return undefined;
  const type = match[1] as string;
  const body = match[2] as string;
  const blob = Buffer.from(body, 'base64');
  // The blob opens with its own type name: a key line whose body says another type is damaged or forged.
  if (blob.length < 8) return undefined;
  const nameLength = blob.readUInt32BE(0);
  if (nameLength !== type.length || blob.subarray(4, 4 + nameLength).toString('latin1') !== type) return undefined;
  return { type, body, fingerprint: fingerprintOfBlob(blob), bare: `${type} ${body}` };
}

export interface GeneratedKey {
  /** The `openssh-key-v1` PEM text. SECRET: it is sealed and fed to `ssh-add -` on stdin, nothing else. */
  readonly privateKey: string;
  /** `ssh-ed25519 AAAA… <comment>`. */
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** A fresh ed25519 key. `comment` names it in `ssh-add -l` (a plain label, never a secret). */
export function generateEd25519(comment: string): GeneratedKey {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' }) as { x: string };
  const privateJwk = pair.privateKey.export({ format: 'jwk' }) as { d: string };
  const pub = Buffer.from(publicJwk.x, 'base64url');
  const seed = Buffer.from(privateJwk.d, 'base64url');
  const blob = concat([text(KEY_TYPE), text(pub)]);

  const check = randomBytes(4);
  const section = concat([check, check, text(KEY_TYPE), text(pub), text(concat([seed, pub])), text(comment)]);
  // Pad to the cipher's block size (8 for "none") with 1, 2, 3, …
  const padding = Uint8Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, index) => index + 1);
  const file = concat([
    new TextEncoder().encode('openssh-key-v1\0'),
    text('none'),
    text('none'),
    text(''),
    uint32(1),
    text(blob),
    text(concat([section, padding])),
  ]);
  const wrapped = (
    Buffer.from(file)
      .toString('base64')
      .match(/.{1,70}/gu) ?? []
  ).join('\n');
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${KEY_TYPE} ${Buffer.from(blob).toString('base64')} ${comment}`,
    fingerprint: fingerprintOfBlob(blob),
  };
}
