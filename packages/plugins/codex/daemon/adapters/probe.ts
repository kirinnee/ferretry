import type { Duration } from '@ferretry/std';
import { seconds } from '@ferretry/std';
import type { FencedPath, SpawnPort } from '@ferretry/kernel/contract';
import { type HarnessProbe, type HarnessStartupCheck, parseCodexVersion } from '../lib/update/index.ts';
import type { HostPrograms } from './host-programs.ts';

/** How long `--version` or `--help` may take. A cold node start on a slow disk is a few seconds. */
const PROBE_TIMEOUT = seconds(20);

/** A proxy address nothing listens on: any request the binary makes fails at once instead of leaving. */
const NOWHERE = 'http://127.0.0.1:9';

/**
 * The environment a probe runs in: a throwaway `HOME` (no login, no settings, no history can be read or written), every
 * proxy variable pointed at {@link NOWHERE}, and the binary's own directory first on `PATH` so an npm launcher's
 * `#!/usr/bin/env node` finds the node beside it.
 */
export function probeEnvironment(
  path: string,
  home: string,
  inherited: { readonly PATH?: string | undefined; readonly LANG?: string | undefined },
): Record<string, string> {
  const directory = path.slice(0, path.lastIndexOf('/')) || '/';
  const searched = inherited.PATH === undefined || inherited.PATH === '' ? directory : `${directory}:${inherited.PATH}`;
  return {
    HOME: home,
    PATH: searched,
    TMPDIR: home,
    LANG: inherited.LANG ?? 'C.UTF-8',
    CODEX_HOME: `${home}/.codex`,
    HTTP_PROXY: NOWHERE,
    HTTPS_PROXY: NOWHERE,
    ALL_PROXY: NOWHERE,
    http_proxy: NOWHERE,
    https_proxy: NOWHERE,
    all_proxy: NOWHERE,
    NO_PROXY: '',
    CI: '1',
  };
}

/**
 * Asking the Codex binary about itself, isolated by {@link probeEnvironment}. The throwaway home is a folder under this
 * plugin's own `agent-homes` root that is never created by Ferretry, so nothing a probe could write lands anywhere else.
 */
export class HostCodexProbe implements HarnessProbe {
  readonly #spawn: SpawnPort;
  readonly #host: HostPrograms;
  readonly #home: FencedPath;
  readonly #timeout: Duration;

  constructor(spawn: SpawnPort, host: HostPrograms, throwawayHome: FencedPath, timeout: Duration = PROBE_TIMEOUT) {
    this.#spawn = spawn;
    this.#host = host;
    this.#home = throwawayHome;
    this.#timeout = timeout;
  }

  async version(path: string): Promise<{ state: 'ok'; version: string } | { state: 'unreadable'; reason: string }> {
    const result = await this.#run(path, ['--version']);
    if ('failure' in result) return { state: 'unreadable', reason: result.failure };
    const version = parseCodexVersion(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0 || version === undefined)
      return { state: 'unreadable', reason: `it exited ${String(result.exitCode)} without printing a version` };
    return { state: 'ok', version };
  }

  async startup(path: string): Promise<HarnessStartupCheck> {
    const result = await this.#run(path, ['--help']);
    if ('failure' in result) return { ok: false, reason: result.failure.replace('--version', '--help') };
    return result.exitCode === 0 ? { ok: true } : { ok: false, reason: `--help exited ${String(result.exitCode)}` };
  }

  async #run(path: string, args: readonly string[]) {
    const [inheritedPath, lang] = await Promise.all([this.#host.environment('PATH'), this.#host.environment('LANG')]);
    try {
      const result = await this.#spawn.run(path, args, {
        env: probeEnvironment(path, this.#home, { PATH: inheritedPath, LANG: lang }),
        timeout: this.#timeout,
      });
      // A killed child reports no exit code: that is the deadline, not a verdict.
      if (result.exitCode === null)
        return { failure: `it did not answer within ${Math.round(this.#timeout / 1000)} seconds` };
      return result;
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  }
}
