import { readlink, realpath } from 'node:fs/promises';
import {
  type InstallFacts,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  type SystemPackageManager,
  storePathHops,
  symlinkHops,
} from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../../lib/daemon/binary.ts';
import type { CommandOutcome } from '../../lib/daemon/ports.ts';
import type { IInstallFactsPort } from '../../lib/update/ports.ts';

/** Run a command, give it `timeoutMs`, and answer what it said. A missing command is exit 127. */
export type BoundedRunner = (argv: readonly string[], timeoutMs: number) => Promise<CommandOutcome>;

/**
 * Bun's spawn with its own timeout, which KILLS the child rather than abandoning it: an abandoned
 * `nix profile list` would hold this CLI open until it finished, whatever the race said.
 */
export const boundedRun: BoundedRunner = async (argv, timeoutMs) => {
  const [command, ...args] = argv;
  try {
    const child = Bun.spawn([command ?? '', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error: unknown) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
};

export interface HostInstallFactsOptions {
  readonly product: string;
  readonly homeDirectory: string;
  readonly platform: string;
  readonly run?: BoundedRunner;
  /** Where a command is on `PATH`, or `undefined` when it is not. */
  readonly which?: (command: string) => string | undefined;
  readonly realPath?: (path: string) => Promise<string>;
  /** A link's target, or `undefined` when the path is not a link. */
  readonly readLink?: (path: string) => Promise<string | undefined>;
  readonly timeoutMs?: number;
}

/** Long enough for a cold `nix profile list`, short enough that `status` never looks hung. */
const FACT_TIMEOUT_MS = 10_000;

/**
 * The facts `classifyInstallMethod` reads, for the daemon executable this host has installed.
 *
 * Only the question each kind of path can answer is asked: a store path asks the nix profile which
 * element holds it, anything else asks dpkg and rpm whether they own it. Every failure is an absent
 * fact, because what rides on it is a sentence, never an action — an update that acts re-classifies
 * from the same facts and refuses anything it cannot place.
 */
export class HostInstallFacts implements IInstallFactsPort {
  private readonly run: BoundedRunner;
  private readonly which: (command: string) => string | undefined;
  private readonly realPath: (path: string) => Promise<string>;
  private readonly readLink: (path: string) => Promise<string | undefined>;
  private readonly timeoutMs: number;

  constructor(private readonly options: HostInstallFactsOptions) {
    this.run = options.run ?? boundedRun;
    this.which = options.which ?? (command => Bun.which(command) ?? undefined);
    this.realPath = options.realPath ?? (path => realpath(path));
    this.readLink = options.readLink ?? (path => readlink(path).catch(() => undefined));
    this.timeoutMs = options.timeoutMs ?? FACT_TIMEOUT_MS;
  }

  async facts(daemon: InstalledDaemonBinary): Promise<InstallFacts> {
    const resolvedPath = await this.realPath(daemon.path).catch(() => daemon.path);
    const base: InstallFacts = {
      product: this.options.product,
      compiled: true,
      launchedPath: daemon.path,
      resolvedPath,
      homeDirectory: this.options.homeDirectory,
      platform: this.options.platform,
    };
    if (resolvedPath.startsWith('/nix/store/')) {
      const hops = await symlinkHops(daemon.path, this.readLink);
      const profile = await this.#nixProfile([resolvedPath, ...storePathHops(hops)]);
      return {
        ...base,
        nixProfileElement: profile.element,
        homeManagerProfile: profile.homeManager,
        viaHomeManagerPath: passesThroughHomeManagerPath(hops),
      };
    }
    return { ...base, systemPackage: await this.#systemPackage(resolvedPath) };
  }

  async #nixProfile(
    candidates: readonly string[],
  ): Promise<{ readonly element?: string; readonly homeManager: boolean }> {
    const listed = await this.run(
      ['nix', '--extra-experimental-features', 'nix-command flakes', 'profile', 'list', '--json'],
      this.timeoutMs,
    );
    if (listed.code !== 0) return { homeManager: false };
    try {
      return parseNixProfileList(JSON.parse(listed.stdout), candidates);
    } catch {
      return { homeManager: false };
    }
  }

  async #systemPackage(resolvedPath: string): Promise<SystemPackageManager | undefined> {
    if (this.which('dpkg') !== undefined && (await this.run(['dpkg', '-S', resolvedPath], this.timeoutMs)).code === 0) {
      return 'apt';
    }
    if (this.which('rpm') !== undefined && (await this.run(['rpm', '-qf', resolvedPath], this.timeoutMs)).code === 0) {
      return this.which('dnf') !== undefined ? 'dnf' : 'yum';
    }
    return undefined;
  }
}
