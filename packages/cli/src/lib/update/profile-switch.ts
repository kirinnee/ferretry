import { classifyInstallMethod, planUpdate, releaseFlakeReference } from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../daemon/binary.ts';
import type { IDaemonOutput, IDaemonPrompt } from '../daemon/ports.ts';
import type { IInstallFactsPort, IPackageManagerPort, IUpdateLifecyclePort } from './ports.ts';

export interface NixProfileSwitchDeps {
  readonly facts: IInstallFactsPort;
  readonly packages: IPackageManagerPort;
  readonly lifecycle: Pick<IUpdateLifecyclePort, 'executable' | 'versionOf'>;
  readonly out: IDaemonOutput;
  readonly prompt: IDaemonPrompt;
  readonly interactive: () => boolean;
  readonly product: string;
  readonly clientName: string;
  readonly daemonName: string;
  readonly homeDirectory: string;
}

/** Whether a typed answer is a yes. Anything else — an empty line included — is a no. */
export const isYes = (answer: string): boolean => /^y(es)?$/iu.test(answer.trim());

/**
 * Moving a daemon that runs from a temporary `nix shell` store path into the user's nix profile.
 *
 * WHY: a unit file must name an absolute path, and a `nix shell` path is one garbage collection can
 * delete and no update ever moves. A profile gives a STABLE path — `~/.nix-profile/bin/<daemon>` is a
 * link that follows the profile — so after this, `nix profile upgrade` and a restart are the whole
 * update, forever.
 *
 * NEVER SILENT. Both callers ask first: `fy daemon install` at a terminal, and `fy daemon update` only
 * with `--switch-to-profile` or a yes. Nothing here rewrites a service definition; the caller installs
 * the path this returns, through the ordinary install.
 */
export class NixProfileSwitch {
  constructor(private readonly deps: NixProfileSwitchDeps) {}

  /** The stable paths a profile install puts the daemon at, classic first, then the XDG layout. */
  get profilePaths(): readonly string[] {
    const home = this.deps.homeDirectory.replace(/\/+$/u, '');
    return [
      `${home}/.nix-profile/bin/${this.deps.daemonName}`,
      `${home}/.local/state/nix/profile/bin/${this.deps.daemonName}`,
    ];
  }

  /** Whether this daemon runs from a temporary `nix shell` store path. */
  async isNixShell(daemon: InstalledDaemonBinary): Promise<boolean> {
    return classifyInstallMethod(await this.deps.facts.facts(daemon)).kind === 'nix-shell';
  }

  /** Run `nix profile install <flake>` and answer the stable path it produced, or why it did not. */
  async install(): Promise<{ readonly path: string } | { readonly failure: string }> {
    const flake = releaseFlakeReference(this.deps.product);
    const outcome = await this.deps.packages.nixProfileInstall(flake);
    if (outcome.code !== 0) {
      return {
        failure: `nix profile install ${flake} failed: ${lastLine(outcome.stderr) ?? `exit ${String(outcome.code)}`}`,
      };
    }
    const path = this.profilePaths.find(candidate => this.deps.lifecycle.executable(candidate));
    if (path === undefined) {
      return {
        failure: `nix profile install ${flake} finished, but no ${this.deps.daemonName} appeared in your profile`,
      };
    }
    return { path };
  }

  /**
   * For `fy daemon install`: explain, and at a terminal offer the switch. Answers the daemon to install
   * instead, or `undefined` to install the one that was found.
   */
  async offer(daemon: InstalledDaemonBinary): Promise<InstalledDaemonBinary | undefined> {
    if (!(await this.isNixShell(daemon))) return undefined;
    const plan = planUpdate({ kind: 'nix-shell', storePath: daemon.path }, this.deps);
    if (plan.kind === 'switch') this.deps.out.warn(plan.explanation);
    const flake = releaseFlakeReference(this.deps.product);
    if (!this.deps.interactive()) {
      this.deps.out.warn(
        `to fix it, run \`nix profile install ${flake}\`, then \`${this.deps.clientName} daemon install\` from a new shell`,
      );
      return undefined;
    }
    const answer = await this.deps.prompt.ask(`Install ${this.deps.product} into your nix profile now? [y/N]`);
    if (!isYes(answer)) return undefined;
    const switched = await this.install();
    if ('failure' in switched) {
      this.deps.out.warn(`${switched.failure}; installing the nix shell path instead`);
      return undefined;
    }
    return { path: switched.path, source: 'FY_DAEMON_BIN', version: this.deps.lifecycle.versionOf(switched.path) };
  }
}

/** The last `count` non-empty lines of a command's error output, joined for a sentence; `undefined` when it said nothing. */
export function lastLines(text: string, count: number): string | undefined {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-count);
  return lines.length === 0 ? undefined : lines.join('\n  ');
}

/** The last non-empty line of a command's error output: usually the sentence that explains it. */
export function lastLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  return lines.at(-1);
}
