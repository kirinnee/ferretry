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

export async function runBounded(argv: readonly string[], timeoutMs: number): Promise<FactCommandResult | undefined> {
  try {
    const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return undefined;
  }
}

/** The link-chain and nix profile facts of one executable: what a store path's install is decided by. */
export type ExecutableNixFacts = Pick<InstallFacts, 'nixProfileElement' | 'homeManagerProfile' | 'viaHomeManagerPath'>;

/** The commands and filesystem reads {@link executableNixFacts} needs. */
export interface ExecutableNixSeams {
  readonly run: (argv: readonly string[], timeoutMs: number) => Promise<FactCommandResult | undefined>;
  readonly readLink: (path: string) => Promise<string | undefined>;
}

/**
 * Walk the launched path's links and ask the nix profile which element holds it.
 *
 * SHARED by the daemon's facts about itself and the harness update's facts about `claude` and `codex`
 * (`harness-facts.ts`): the same file read the same way can never be classified two ways.
 */
export async function executableNixFacts(
  launchedPath: string,
  resolvedPath: string,
  seams: ExecutableNixSeams,
): Promise<ExecutableNixFacts> {
  const hops = await symlinkHops(launchedPath, seams.readLink);
  const profile = await nixProfile([resolvedPath, ...storePathHops(hops)], seams.run);
  return {
    nixProfileElement: profile.element,
    homeManagerProfile: profile.homeManager,
    viaHomeManagerPath: passesThroughHomeManagerPath(hops),
  };
}

async function nixProfile(
  candidates: readonly string[],
  run: ExecutableNixSeams['run'],
): Promise<{ element?: string | undefined; homeManager: boolean }> {
  if (!candidates[0]?.startsWith('/nix/store/')) return { homeManager: false };
  const listed = await run(['nix', 'profile', 'list', '--json'], FACT_COMMAND_TIMEOUT_MS);
  if (listed === undefined || listed.code !== 0) return { homeManager: false };
  try {
    return parseNixProfileList(JSON.parse(listed.stdout), candidates);
  } catch {
    return { homeManager: false };
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
    const [nix, systemPackage] = await Promise.all([
      executableNixFacts(launchedPath, resolvedPath, { run: this.run, readLink: this.readLink }),
      this.systemPackage(resolvedPath),
    ]);
    return {
      product: this.seams.product,
      compiled: this.seams.main.startsWith('/$bunfs/'),
      launchedPath,
      resolvedPath,
      homeDirectory: this.seams.homeDirectory,
      platform: this.seams.platform,
      ...nix,
      systemPackage,
    };
  }

  private launchedPath(): string {
    const argv0 = this.seams.argv0;
    if (isAbsolute(argv0)) return argv0;
    if (argv0.includes('/')) return resolve(this.seams.workingDirectory, argv0);
    return this.seams.which(argv0) ?? this.seams.execPath;
  }

  private async systemPackage(resolvedPath: string): Promise<SystemPackageManager | undefined> {
    if (this.seams.platform !== 'linux' || resolvedPath.startsWith('/nix/store/')) return undefined;
    if ((await this.run(['dpkg', '-S', resolvedPath], FACT_COMMAND_TIMEOUT_MS))?.code === 0) return 'apt';
    if ((await this.run(['rpm', '-qf', resolvedPath], FACT_COMMAND_TIMEOUT_MS))?.code !== 0) return undefined;
    return this.seams.which('dnf') === undefined ? 'yum' : 'dnf';
  }
}
