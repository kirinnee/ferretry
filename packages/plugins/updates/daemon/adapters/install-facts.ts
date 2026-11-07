import { milliseconds } from '@ferretry/std';
import type { ExecutableFacts, SpawnPort } from '@ferretry/kernel/contract';
import {
  type InstallFacts,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  type SystemPackageManager,
  storePathHops,
  symlinkHops,
} from '../../contract/index.ts';
import type { InstallHost } from '../lib/host.ts';
import type { InstallFactsSource } from '../lib/ports.ts';

/**
 * An absolute path with its `.` and `..` segments folded away and its repeated slashes joined, lexically (as
 * `path.resolve` does, and as `symlinkHops` walks): `..` above the root stays at the root.
 */
const foldSegments = (path: string): string => {
  const folded: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') folded.pop();
    else folded.push(segment);
  }
  return `/${folded.join('/')}`;
};

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
 * THE LAUNCHED PATH IS `argv0`, NOT `execPath`. The port's `resolvedExecPath` goes through every link, so
 * `~/.nix-profile/bin/fyd` and the `nix shell` store path it points at read the same there. Only the path the service
 * manager actually named tells a stable profile install from an ephemeral one.
 *
 * Every command is bounded and every failure is "no", never a throw: a host without Nix, dpkg or rpm simply has none
 * of those facts.
 */
export class HostInstallFacts implements InstallFactsSource {
  constructor(
    private readonly host: InstallHost,
    private readonly run: FactCommand,
  ) {}

  async facts(): Promise<InstallFacts> {
    const executable = await this.host.port.executable();
    const launchedPath = this.launchedPath(executable);
    const resolvedPath = executable.resolvedExecPath;
    const [nix, systemPackage] = await Promise.all([
      executableNixFacts(launchedPath, resolvedPath, { run: this.run, readLink: path => this.readLink(path) }),
      this.systemPackage(executable.platform, resolvedPath),
    ]);
    return {
      product: this.host.product,
      compiled: this.host.port.compiled,
      launchedPath,
      resolvedPath,
      homeDirectory: this.host.homeDirectory,
      platform: executable.platform,
      ...nix,
      systemPackage,
    };
  }

  /** A link's target through the bounded `readlink` (declared in the manifest); `undefined` when it is not a link. */
  private async readLink(path: string): Promise<string | undefined> {
    const answer = await this.run(['readlink', path]);
    const target = answer?.code === 0 ? answer.stdout.trim() : '';
    return target === '' ? undefined : target;
  }

  private launchedPath(executable: ExecutableFacts): string {
    const argv0 = executable.argv0;
    if (argv0.startsWith('/')) return argv0;
    if (argv0.includes('/')) return foldSegments(`${executable.workingDirectory}/${argv0}`);
    return this.host.which(argv0) ?? executable.execPath;
  }

  private async systemPackage(platform: string, resolvedPath: string): Promise<SystemPackageManager | undefined> {
    if (platform !== 'linux' || resolvedPath.startsWith('/nix/store/')) return undefined;
    if ((await this.run(['dpkg', '-S', resolvedPath]))?.code === 0) return 'apt';
    if ((await this.run(['rpm', '-qf', resolvedPath]))?.code !== 0) return undefined;
    return this.host.which('dnf') === undefined ? 'yum' : 'dnf';
  }
}
