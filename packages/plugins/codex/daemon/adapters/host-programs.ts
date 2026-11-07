/**
 * What this machine says about where a program is, through the programs the manifest declares it may run.
 *
 * The kernel gives a subsystem no environment, no `PATH` lookup and no file stat of its own, so each question is asked
 * of the small system program that answers it — `which`, `test`, `realpath`, `readlink`, `printenv`, `uname` — all
 * declared in `permissions.spawn`. A program that is missing, refused or slow answers 'no', never a throw: a host
 * without Nix simply has no nix facts.
 */
import type { SpawnPort } from '@ferretry/kernel/contract';
import { seconds } from '@ferretry/std';
import type { ExecutableResolverPort } from '../lib/update/ports.ts';

/** How long one fact-finding command may take before its answer is 'no'. */
const FACT_TIMEOUT = seconds(10);

/** The only environment names this plugin reads. */
export type EnvironmentName = 'HOME' | 'PATH' | 'LANG';

export class HostPrograms implements ExecutableResolverPort {
  readonly #spawn: SpawnPort;

  constructor(spawn: SpawnPort) {
    this.#spawn = spawn;
  }

  /** One finished command's trimmed standard output when it exited 0, else `undefined`. */
  async #answer(program: string, args: readonly string[]): Promise<string | undefined> {
    try {
      const result = await this.#spawn.run(program, args, { timeout: FACT_TIMEOUT });
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async resolve(name: string): Promise<string | undefined> {
    const found = (await this.#answer('which', [name]))?.split('\n')[0]?.trim();
    return found !== undefined && found.startsWith('/') ? found : undefined;
  }

  async runnable(path: string): Promise<boolean> {
    if (!path.startsWith('/')) return false;
    return (await this.#answer('test', ['-f', path, '-a', '-x', path])) !== undefined;
  }

  async realpath(path: string): Promise<string> {
    const resolved = await this.#answer('realpath', [path]);
    return resolved === undefined || resolved === '' ? path : resolved;
  }

  /** A link's target, or `undefined` when the path is not a link (or is not there). */
  async readLink(path: string): Promise<string | undefined> {
    const target = await this.#answer('readlink', [path]);
    return target === undefined || target === '' ? undefined : target;
  }

  async environment(name: EnvironmentName): Promise<string | undefined> {
    const value = await this.#answer('printenv', [name]);
    return value === undefined || value === '' ? undefined : value;
  }

  /** `darwin`, `linux`, or the lower-cased kernel name. */
  async platform(): Promise<string> {
    return ((await this.#answer('uname', ['-s'])) ?? 'linux').toLowerCase();
  }

  /** `nix profile list --json`, parsed; `undefined` without Nix or when it did not answer. */
  async nixProfile(): Promise<unknown> {
    const listed = await this.#answer('nix', ['profile', 'list', '--json']);
    if (listed === undefined) return undefined;
    try {
      return JSON.parse(listed);
    } catch {
      return undefined;
    }
  }
}
