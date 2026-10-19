import { readlink, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  type InstallFacts,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  type SystemPackageManager,
  storePathHops,
  symlinkHops,
} from '@ferretry/protocol';
import type { InstallFactsSource } from '../../lib/index.ts';

/** How long one fact-finding command may take before its answer is "no". */
const FACT_COMMAND_TIMEOUT_MS = 10_000;

/** One finished command: its exit code and what it printed. `undefined` when it could not run. */
export interface FactCommandResult {
  readonly code: number;
  readonly stdout: string;
}

/** The host seams the facts are read through, injected so a suite needs no Nix and no dpkg. */
export interface InstallFactsSeams {
  readonly product: string;
  /** `process.argv0`: the path the daemon was launched as. */
  readonly argv0: string;
  /** `process.execPath`: the executable itself. */
  readonly execPath: string;
  /** `Bun.main`: `/$bunfs/…` inside a compiled binary, a source file otherwise. */
  readonly main: string;
  readonly homeDirectory: string;
  readonly platform: string;
  readonly workingDirectory: string;
  /** A `PATH` search; `undefined` when nothing is found. */
  readonly which: (name: string) => string | undefined;
  /** Run a command, bounded; `undefined` when it is not installed or did not finish. */
  readonly run?: (argv: readonly string[], timeoutMs: number) => Promise<FactCommandResult | undefined>;
  readonly realpath?: (path: string) => Promise<string>;
  /** A link's target, or `undefined` when the path is not a link. */
  readonly readLink?: (path: string) => Promise<string | undefined>;
}

async function runBounded(argv: readonly string[], timeoutMs: number): Promise<FactCommandResult | undefined> {
  try {
    const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return undefined;
  }
}

/**
 * The facts about the running daemon's own executable that decide how it was installed.
 *
 * THE LAUNCHED PATH IS `argv0`, NOT `execPath`. The kernel resolves `execPath` through every link, so
 * `~/.nix-profile/bin/fyd` and the `nix shell` store path it points at read the same there. Only the
 * path the service manager actually named tells a stable profile install from an ephemeral one.
 *
 * Every command is bounded and every failure is "no", never a throw: a host without Nix, dpkg or rpm
 * simply has none of those facts.
 */
export class HostInstallFacts implements InstallFactsSource {
  private readonly run: NonNullable<InstallFactsSeams['run']>;
  private readonly resolveLink: NonNullable<InstallFactsSeams['realpath']>;
  private readonly readLink: NonNullable<InstallFactsSeams['readLink']>;

  constructor(private readonly seams: InstallFactsSeams) {
    this.run = seams.run ?? runBounded;
    this.resolveLink = seams.realpath ?? (async path => await realpath(path));
    this.readLink = seams.readLink ?? (async path => await readlink(path).catch(() => undefined));
  }

  async facts(): Promise<InstallFacts> {
    const launchedPath = this.launchedPath();
    const resolvedPath = await this.resolveLink(this.seams.execPath).catch(() => this.seams.execPath);
    const hops = await symlinkHops(launchedPath, this.readLink);
    const [profile, systemPackage] = await Promise.all([
      this.nixProfile([resolvedPath, ...storePathHops(hops)]),
      this.systemPackage(resolvedPath),
    ]);
    return {
      product: this.seams.product,
      compiled: this.seams.main.startsWith('/$bunfs/'),
      launchedPath,
      resolvedPath,
      homeDirectory: this.seams.homeDirectory,
      platform: this.seams.platform,
      nixProfileElement: profile.element,
      homeManagerProfile: profile.homeManager,
      viaHomeManagerPath: passesThroughHomeManagerPath(hops),
      systemPackage,
    };
  }

  private launchedPath(): string {
    const argv0 = this.seams.argv0;
    if (isAbsolute(argv0)) return argv0;
    if (argv0.includes('/')) return resolve(this.seams.workingDirectory, argv0);
    return this.seams.which(argv0) ?? this.seams.execPath;
  }

  private async nixProfile(
    candidates: readonly string[],
  ): Promise<{ element?: string | undefined; homeManager: boolean }> {
    if (!candidates[0]?.startsWith('/nix/store/')) return { homeManager: false };
    const listed = await this.run(['nix', 'profile', 'list', '--json'], FACT_COMMAND_TIMEOUT_MS);
    if (listed === undefined || listed.code !== 0) return { homeManager: false };
    try {
      return parseNixProfileList(JSON.parse(listed.stdout), candidates);
    } catch {
      return { homeManager: false };
    }
  }

  private async systemPackage(resolvedPath: string): Promise<SystemPackageManager | undefined> {
    if (this.seams.platform !== 'linux' || resolvedPath.startsWith('/nix/store/')) return undefined;
    if ((await this.run(['dpkg', '-S', resolvedPath], FACT_COMMAND_TIMEOUT_MS))?.code === 0) return 'apt';
    if ((await this.run(['rpm', '-qf', resolvedPath], FACT_COMMAND_TIMEOUT_MS))?.code !== 0) return undefined;
    return this.seams.which('dnf') === undefined ? 'yum' : 'dnf';
  }
}
