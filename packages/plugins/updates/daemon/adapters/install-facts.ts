import { milliseconds } from '@ferretry/std';
import type { SpawnPort } from '@ferretry/kernel/contract';
import {
  type InstallFacts,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  type SystemPackageManager,
  storePathHops,
  symlinkHops,
} from '../../contract/index.ts';
import type { UpdateHost } from '../lib/host.ts';
import type { InstallFactsSource } from '../lib/ports.ts';

/** How long one fact-finding command may take before its answer is "no". */
const FACT_COMMAND_TIMEOUT = milliseconds(10_000);

/** One finished command: its exit code and what it printed. `undefined` when it could not run. */
export interface FactCommandResult {
  readonly code: number;
  readonly stdout: string;
}

/** Run a command, bounded; `undefined` when it is not installed or did not finish. */
export type FactCommand = (argv: readonly [string, ...string[]]) => Promise<FactCommandResult | undefined>;

/** The bounded command runner over the kernel's spawn port (`nix`, `dpkg`, `rpm` are declared in the manifest). */
export function factCommand(spawn: SpawnPort): FactCommand {
  return async ([program, ...args]) => {
    try {
      const result = await spawn.run(program, args, { timeout: FACT_COMMAND_TIMEOUT });
      return result.exitCode === null ? undefined : { code: result.exitCode, stdout: result.stdout };
    } catch {
      return undefined;
    }
  };
}

/** The link-chain and nix profile facts of one executable: what a store path's install is decided by. */
export type ExecutableNixFacts = Pick<InstallFacts, 'nixProfileElement' | 'homeManagerProfile' | 'viaHomeManagerPath'>;

/** Walk the launched path's links and ask the nix profile which element holds it. */
export async function executableNixFacts(
  launchedPath: string,
  resolvedPath: string,
  seams: { readonly run: FactCommand; readonly readLink: (path: string) => Promise<string | undefined> },
): Promise<ExecutableNixFacts> {
  const hops = await symlinkHops(launchedPath, seams.readLink);
  const candidates = [resolvedPath, ...storePathHops(hops)];
  let profile: { element?: string | undefined; homeManager: boolean } = { homeManager: false };
  if (candidates[0]?.startsWith('/nix/store/')) {
    const listed = await seams.run(['nix', 'profile', 'list', '--json']);
    if (listed !== undefined && listed.code === 0) {
      try {
        profile = parseNixProfileList(JSON.parse(listed.stdout), candidates);
      } catch {
        profile = { homeManager: false };
      }
    }
  }
  return {
    nixProfileElement: profile.element,
    homeManagerProfile: profile.homeManager,
    viaHomeManagerPath: passesThroughHomeManagerPath(hops),
  };
}

/**
 * The facts about the running daemon's own executable that decide how it was installed.
 *
 * THE LAUNCHED PATH IS `argv0`, NOT `execPath`. The kernel resolves `execPath` through every link, so
 * `~/.nix-profile/bin/fyd` and the `nix shell` store path it points at read the same there. Only the path the service
 * manager actually named tells a stable profile install from an ephemeral one.
 *
 * Every command is bounded and every failure is "no", never a throw: a host without Nix, dpkg or rpm simply has none
 * of those facts.
 */
export class HostInstallFacts implements InstallFactsSource {
  constructor(
    private readonly host: UpdateHost,
    private readonly run: FactCommand,
  ) {}

  async facts(): Promise<InstallFacts> {
    const launchedPath = this.launchedPath();
    const resolvedPath = await this.host.realpath(this.host.execPath).catch(() => this.host.execPath);
    const [nix, systemPackage] = await Promise.all([
      executableNixFacts(launchedPath, resolvedPath, { run: this.run, readLink: path => this.host.readLink(path) }),
      this.systemPackage(resolvedPath),
    ]);
    return {
      product: this.host.product,
      compiled: this.host.main.startsWith('/$bunfs/'),
      launchedPath,
      resolvedPath,
      homeDirectory: this.host.homeDirectory,
      platform: this.host.platform,
      ...nix,
      systemPackage,
    };
  }

  private launchedPath(): string {
    const argv0 = this.host.argv0;
    if (argv0.startsWith('/')) return argv0;
    if (argv0.includes('/')) return `${this.host.workingDirectory.replace(/\/+$/u, '')}/${argv0.replace(/^\.\//u, '')}`;
    return this.host.which(argv0) ?? this.host.execPath;
  }

  private async systemPackage(resolvedPath: string): Promise<SystemPackageManager | undefined> {
    if (this.host.platform !== 'linux' || resolvedPath.startsWith('/nix/store/')) return undefined;
    if ((await this.run(['dpkg', '-S', resolvedPath]))?.code === 0) return 'apt';
    if ((await this.run(['rpm', '-qf', resolvedPath]))?.code !== 0) return undefined;
    return this.host.which('dnf') === undefined ? 'yum' : 'dnf';
  }
}
