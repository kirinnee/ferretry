import { chmod, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseDownloadBase } from '@ferretry/protocol';
import type { CommandOutcome } from '../../lib/daemon/ports.ts';
import type { UpdateObserver } from '../../lib/update/activity.ts';
import type { IStandaloneReleasePort, StagedRelease, StandaloneRefusal } from '../../lib/update/ports.ts';
import {
  checksumFor,
  installerCommand,
  parseReleaseSignature,
  releaseArchiveName,
  signedReleaseMessage,
} from '../../lib/update/release-files.ts';
import type { ReleaseFetch } from './latest-release.ts';

export interface StandaloneReleaseOptions {
  readonly product: string;
  readonly clientName: string;
  /** `process.platform` and `process.arch` of this host. */
  readonly platform: string;
  readonly arch: string;
  /** Every binary a release archive carries and a swap replaces: client, daemon, browser worker. */
  readonly binaries: readonly string[];
  /** Trusted Ed25519 keys, base64url SPKI DER. Empty refuses every standalone update. */
  readonly keys: readonly string[];
  readonly fetcher?: ReleaseFetch;
  /** Unpacks the archive; `tar` from `PATH` by default. */
  readonly run: (argv: readonly string[]) => Promise<CommandOutcome>;
  readonly timeoutMs?: number;
}

const DOWNLOAD_TIMEOUT_MS = 300_000;

const NEW = '.new';
const PREVIOUS = '.previous';

const b64url = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString('base64url');

/**
 * A standalone install's update: a GoReleaser archive, verified twice, swapped in by rename.
 *
 * VERIFIED BY SIGNATURE FIRST, CHECKSUM SECOND. The checksum list arrives from the same place as the
 * archive, so on its own it proves only that the download is whole; the signature over it, by a key
 * compiled into this `fy`, is what proves Ferretry published it. With no trusted key there is nothing
 * to prove it with, and the update refuses — naming the installer, which is what a person would run
 * by hand and which verifies checksums only, so that choice stays theirs.
 *
 * NOTHING A RUNNING DAEMON USES CHANGES BEFORE `swap`. Staging unpacks into a temporary directory
 * inside the install directory, so every later rename stays on one filesystem and is atomic.
 */
export class StandaloneRelease implements IStandaloneReleasePort {
  private readonly fetcher: ReleaseFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: StandaloneReleaseOptions) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  }

  async stage(
    version: string,
    directory: string,
    observer?: UpdateObserver,
  ): Promise<StagedRelease | StandaloneRefusal> {
    const { product, clientName } = this.options;
    const instead = `update with the installer instead: ${installerCommand(product)}`;
    if (this.options.keys.length === 0) {
      return {
        refused: `this ${clientName} carries no release-signing key, so it cannot verify a standalone update; ${instead}`,
      };
    }
    const archive = releaseArchiveName(clientName, this.options.platform, this.options.arch);
    if (archive === undefined) {
      return { refused: `no release archive is published for ${this.options.platform}/${this.options.arch}` };
    }
    const base = releaseDownloadBase(product, version);
    const downloaded = await this.#download(
      [`${base}/checksums.txt`, `${base}/checksums.txt.sig`, `${base}/${archive}`],
      observer,
    );
    if ('refused' in downloaded) return downloaded;
    const [checksums, signature, bytes] = downloaded.files as [Uint8Array, Uint8Array, Uint8Array];
    observer?.({ phase: 'verifying' });
    const trusted = await this.#verifySignature(checksums, new TextDecoder().decode(signature));
    if (trusted !== undefined) return { refused: `${version} ${trusted}; nothing changed — ${instead}` };
    const expected = checksumFor(new TextDecoder().decode(checksums), archive);
    const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (expected === undefined || expected !== actual) {
      return { refused: `${archive} does not match its signed checksum; nothing changed` };
    }
    observer?.({ phase: 'unpacking' });
    return await this.#unpack(bytes, directory);
  }

  async swap(staged: StagedRelease): Promise<void> {
    for (const name of staged.names) {
      const current = join(staged.directory, name);
      if (await exists(current)) await rename(current, `${current}${PREVIOUS}`);
      await rename(`${current}${NEW}`, current);
    }
  }

  async rollback(directory: string): Promise<void> {
    for (const name of this.options.binaries) {
      const current = join(directory, name);
      if (await exists(`${current}${PREVIOUS}`)) await rename(`${current}${PREVIOUS}`, current);
    }
  }

  async #download(
    urls: readonly string[],
    observer: UpdateObserver | undefined,
  ): Promise<{ readonly files: readonly Uint8Array[] } | StandaloneRefusal> {
    const files: Uint8Array[] = [];
    observer?.({ phase: 'downloading' });
    for (const url of urls) {
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) return { refused: `${url} answered ${String(response.status)}; nothing changed` };
        files.push(await readBody(response, observer));
      } catch {
        return { refused: `could not download ${url}; nothing changed` };
      }
    }
    return { files };
  }

  /** `undefined` when a trusted key signed these exact checksums; otherwise what is wrong. */
  async #verifySignature(checksums: Uint8Array, text: string): Promise<string | undefined> {
    const signature = parseReleaseSignature(text);
    if (signature === undefined) return 'carries no readable signature';
    for (const key of this.options.keys) {
      const der = Buffer.from(key, 'base64url');
      if (b64url(await crypto.subtle.digest('SHA-256', der)) !== signature.fingerprint) continue;
      const publicKey = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        Buffer.from(signature.signature, 'base64url'),
        signedReleaseMessage(checksums),
      );
      return valid ? undefined : 'has a signature that does not match its checksums';
    }
    return 'is signed by a key this fy does not trust';
  }

  async #unpack(bytes: Uint8Array, directory: string): Promise<StagedRelease | StandaloneRefusal> {
    const scratch = await mkdtemp(join(directory, '.update-'));
    try {
      const archive = join(scratch, 'release.tar.gz');
      await Bun.write(archive, bytes);
      const unpacked = await this.options.run(['tar', '-xzf', archive, '-C', scratch]);
      if (unpacked.code !== 0) return { refused: `could not unpack the release: ${unpacked.stderr.trim()}` };
      const names: string[] = [];
      for (const name of this.options.binaries) {
        const source = join(scratch, name);
        if (!(await exists(source))) continue;
        await chmod(source, 0o755);
        await rename(source, join(directory, `${name}${NEW}`));
        names.push(name);
      }
      if (names.length === 0) return { refused: 'the release archive carries none of the expected binaries' };
      return { directory, names };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The body of `response`, reporting bytes against `Content-Length` as they arrive when there is one to report against. */
async function readBody(response: Response, observer: UpdateObserver | undefined): Promise<Uint8Array> {
  const expected = Number(response.headers.get('content-length') ?? 0);
  if (observer === undefined || response.body === null || !(expected > 0)) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let done = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    done += chunk.byteLength;
    observer({ phase: 'downloading', bytes: { done, expected: Math.max(expected, done) } });
  }
  return Buffer.concat(chunks);
}
