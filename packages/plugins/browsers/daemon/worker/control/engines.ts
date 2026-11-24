import { createHash } from 'node:crypto';
import type { FetchPort, SpawnPort } from '@ferretry/kernel/contract';
import type { BrowserEngine } from '../../../contract/index.ts';
import { BrowserControlError } from './policy.ts';

/**
 * The browser BUILD the agent browser runs (docs/browser-mode.md, "Engine"): which program, and the switches that
 * program's fingerprinting takes. It is the machine's choice (`browsers.yaml engine:`); a per-identity choice is later.
 *
 * - `chromium` — the one the machine has (`selectChromeExecutable`); no switches, byte for byte what every launch was.
 * - `fingerprint-chromium` — a patched Chromium (github.com/adryfish/fingerprint-chromium). Ferretry fetches ONE pinned
 *   release, by its exact address and SHA-256, into the state folder the first time it is chosen — never at build time,
 *   never a newer one — and says so in the daemon log. It takes `--fingerprint=<seed>`.
 * - `cloakbrowser` — named so the choice exists, and REFUSED: its binary is proprietary, wants a licence key on every
 *   launch and may not be redistributed, so this build neither downloads nor starts it.
 */

/** The one release Ferretry fetches: exact address, size and hash. Changing it is a code change, reviewed. */
export const FINGERPRINT_CHROMIUM_RELEASE: EngineRelease = {
  version: '150.0.7871.186',
  url: 'https://github.com/adryfish/fingerprint-chromium/releases/download/150.0.7871.186/ungoogled-chromium-150.0.7871.186-1-x86_64_linux.tar.xz',
  sha256: '48eff860053efd9ad498d51370f0a1f59f983df39c02a72ad2a8682cdead4055',
  bytes: 145_806_232,
};

export interface EngineRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The hosts the one download may touch (the release address, then the host GitHub redirects its assets to). */
export const ENGINE_DOWNLOAD_HOSTS = ['github.com', 'release-assets.githubusercontent.com'] as const;

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const MAX_REDIRECTS = 3;

export const CLOAKBROWSER_REFUSAL =
  'The cloakbrowser engine is not available in this build: its browser is proprietary, needs a licence key on every launch and may not be redistributed, so Ferretry neither downloads nor starts it. Set engine to chromium or fingerprint-chromium in browsers.yaml.';

/** What an engine adds to a launch: the program, and switches that go on its command line. */
export interface EngineLaunch {
  readonly executable: string;
  readonly flags: readonly string[];
}

/** What the resolver reaches the world through; all of it kernel ports or the host's few file calls. */
export interface EnginePorts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `state/browsers/`: engines live under `engines/` in it. */
  readonly stateDirectory: string;
  readonly path: string | undefined;
  exists(path: string): boolean;
  /** `kernel.fetch`: only the hosts `permissions.network` declares. */
  readonly fetch: FetchPort;
  /** `kernel.spawn.run`: `tar` unpacks the archive. */
  readonly spawn: Pick<SpawnPort, 'run'>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** The daemon log: the download is announced here before it starts. */
  info(message: string, fields: Readonly<Record<string, string | number>>): void;
}

/**
 * A 32-bit seed from this machine's browser state folder: the same on every launch, different on another machine. It is
 * the machine's one identity's seed until each identity keeps its own fingerprint record (a later unit replaces it).
 */
export function engineSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff || 1;
}

/** The fingerprint switches of an engine, for the OS this daemon runs on (an honest platform, never another one). */
export function engineFlags(engine: BrowserEngine, seed: number, platform: NodeJS.Platform): readonly string[] {
  if (engine !== 'fingerprint-chromium') return [];
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  return [`--fingerprint=${seed}`, `--fingerprint-platform=${os}`];
}

export class EngineResolver {
  #installing: Promise<string> | undefined;
  constructor(
    private readonly ports: EnginePorts,
    private readonly release: EngineRelease = FINGERPRINT_CHROMIUM_RELEASE,
  ) {}

  /** The engine's program and switches, fetching it first when it is not there; `undefined` is the machine's Chromium. A refusal is a plain sentence. */
  async resolve(engine: BrowserEngine): Promise<EngineLaunch | undefined> {
    if (engine === 'chromium') return undefined;
    if (engine === 'cloakbrowser') throw new BrowserControlError('launch_failed', CLOAKBROWSER_REFUSAL);
    // Two launches asking at once share one fetch.
    this.#installing ??= this.install().finally(() => {
      this.#installing = undefined;
    });
    const executable = await this.#installing;
    return { executable, flags: engineFlags(engine, engineSeed(this.ports.stateDirectory), this.ports.platform) };
  }

  private async install(): Promise<string> {
    const { platform, arch, stateDirectory, exists } = this.ports;
    if (platform !== 'linux' || arch !== 'x64')
      throw new BrowserControlError(
        'launch_failed',
        'The fingerprint-chromium engine is fetched for Linux on x86-64 only; on this machine set engine to chromium in browsers.yaml.',
      );
    const root = `${stateDirectory}/engines/fingerprint-chromium`;
    const { version } = this.release;
    const executable = `${root}/${version}/chrome`;
    if (exists(executable)) return executable;
    const archive = `${root}/${version}.tar.xz.part`;
    const staging = `${root}/${version}.staging`;
    this.ports.info('fetching the fingerprint-chromium engine (once, for this machine)', {
      url: this.release.url,
      sha256: this.release.sha256,
      megabytes: Math.round(this.release.bytes / 1_000_000),
      into: `${root}/${version}`,
    });
    try {
      await this.ports.remove(staging);
      await this.ports.writeFile(archive, await this.download());
      const unpacked = await this.ports.spawn.run(
        'tar',
        ['-xJf', archive, '--strip-components=1', `--one-top-level=${staging}`],
        { env: { PATH: this.ports.path ?? '' } },
      );
      if (unpacked.exitCode !== 0) throw new Error(`tar exited with code ${unpacked.exitCode}`);
      await this.ports.rename(staging, `${root}/${version}`);
    } catch (error) {
      await this.ports.remove(staging).catch(() => undefined);
      throw error instanceof BrowserControlError
        ? error
        : new BrowserControlError(
            'launch_failed',
            `Could not fetch the fingerprint-chromium engine: ${error instanceof Error ? error.message : 'unknown error'}. Set engine to chromium in browsers.yaml to go on without it.`,
          );
    } finally {
      await this.ports.remove(archive).catch(() => undefined);
    }
    return executable;
  }

  /** The pinned archive, following GitHub's redirect by hand so each hop is a declared host; refused unless size and hash match. */
  private async download(): Promise<Uint8Array> {
    let url = this.release.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.ports.fetch.request(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      const next = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && next !== null) {
        url = new URL(next, url).toString();
        continue;
      }
      if (!response.ok) throw new Error(`the download answered ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== this.release.bytes)
        throw new Error(`the download is ${bytes.length} bytes, not the pinned ${this.release.bytes}`);
      if (createHash('sha256').update(bytes).digest('hex') !== this.release.sha256)
        throw new Error('the download does not match the pinned SHA-256, so it was thrown away');
      return bytes;
    }
    throw new Error('the download redirected too many times');
  }
}
