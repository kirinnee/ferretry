import { DAEMON_RELEASE_SIGNATURE_CONTEXT, RELEASE_OWNER } from '@ferretry/protocol';

/**
 * The files a standalone release is made of, and how each is read. Pure: the adapter fetches, hashes
 * and verifies; this module only says what the bytes mean.
 */

/** The GoReleaser archive name for a platform (`.goreleaser.yaml` → `name_template`). */
export function releaseArchiveName(clientName: string, platform: string, arch: string): string | undefined {
  const os = platform === 'darwin' || platform === 'linux' ? platform : undefined;
  const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  if (os === undefined || goArch === undefined) return undefined;
  return `${clientName}_${os}_${goArch}.tar.gz`;
}

/** The SHA-256 (lower-case hex) `checksums.txt` lists for `name`, or `undefined` when it lists none. */
export function checksumFor(checksums: string, name: string): string | undefined {
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  return undefined;
}

/** A parsed `checksums.txt.sig`: `<SHA-256 of the key's SPKI, b64url>.<signature, b64url>`. */
export interface ReleaseSignature {
  readonly fingerprint: string;
  readonly signature: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/u;

export function parseReleaseSignature(text: string): ReleaseSignature | undefined {
  const [fingerprint, signature, ...rest] = text.trim().split('.');
  if (fingerprint === undefined || signature === undefined || rest.length > 0) return undefined;
  if (!B64URL.test(fingerprint) || !B64URL.test(signature)) return undefined;
  return { fingerprint, signature };
}

/** The exact bytes a release signature covers: the context line, then `checksums.txt` as served. */
export function signedReleaseMessage(checksums: Uint8Array): Uint8Array<ArrayBuffer> {
  const context = new TextEncoder().encode(DAEMON_RELEASE_SIGNATURE_CONTEXT);
  const message = new Uint8Array(context.length + checksums.length);
  message.set(context, 0);
  message.set(checksums, context.length);
  return message;
}

/** The one-line installer a person runs instead, when a standalone self-update cannot be verified. */
export function installerCommand(product: string): string {
  return `curl -fsSL https://github.com/${RELEASE_OWNER}/${product}/releases/latest/download/install.sh | bash`;
}
