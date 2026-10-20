import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseHarnessVersion } from '@ferretry/protocol';
import type { PackageInstallPort } from '../../lib/fleet/tool-install.ts';
import type { HarnessProbe, HarnessStartupCheck } from '../../lib/index.ts';

/** How long `--version` or `--help` may take. A cold node start on a slow disk is a few seconds. */
const PROBE_TIMEOUT_MS = 20_000;

/** A proxy address nothing listens on: any request the binary makes fails at once instead of leaving. */
const NOWHERE = 'http://127.0.0.1:9';

/**
 * The environment a probe runs in: a throwaway `HOME` (no login, no settings, no history can be read
 * or written), every proxy variable pointed at {@link NOWHERE}, and the binary's own directory first on
 * `PATH` so an npm launcher's `#!/usr/bin/env node` finds the node beside it.
 */
export function probeEnvironment(
  path: string,
  home: string,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const directory = dirname(path);
  const searched = inherited.PATH === undefined || inherited.PATH === '' ? directory : `${directory}:${inherited.PATH}`;
  return {
    HOME: home,
    PATH: searched,
    TMPDIR: home,
    LANG: inherited.LANG ?? 'C.UTF-8',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    HTTP_PROXY: NOWHERE,
    HTTPS_PROXY: NOWHERE,
    ALL_PROXY: NOWHERE,
    http_proxy: NOWHERE,
    https_proxy: NOWHERE,
    all_proxy: NOWHERE,
    NO_PROXY: '',
    DISABLE_AUTOUPDATER: '1',
    CI: '1',
  };
}

/**
 * Asking a harness binary about itself, isolated by {@link probeEnvironment}. Each run gets a fresh
 * throwaway home that is removed afterwards.
 */
export class HostHarnessProbe implements HarnessProbe {
  constructor(
    private readonly run: PackageInstallPort,
    private readonly inherited: Readonly<Record<string, string | undefined>>,
    private readonly timeoutMs: number = PROBE_TIMEOUT_MS,
  ) {}

  async version(path: string): Promise<{ state: 'ok'; version: string } | { state: 'unreadable'; reason: string }> {
    const result = await this.#run(path, ['--version']);
    if (result.kind === 'not-started') return { state: 'unreadable', reason: result.reason };
    if (result.kind === 'timed-out') return { state: 'unreadable', reason: 'it did not answer within 20 seconds' };
    const version = parseHarnessVersion(result.tail.join('\n'));
    if (result.code !== 0 || version === undefined)
      return { state: 'unreadable', reason: `it exited ${String(result.code)} without printing a version` };
    return { state: 'ok', version };
  }

  async startup(path: string): Promise<HarnessStartupCheck> {
    const result = await this.#run(path, ['--help']);
    if (result.kind === 'not-started') return { ok: false, reason: result.reason };
    if (result.kind === 'timed-out') return { ok: false, reason: '--help did not finish within 20 seconds' };
    return result.code === 0 ? { ok: true } : { ok: false, reason: `--help exited ${String(result.code)}` };
  }

  async #run(path: string, args: readonly string[]) {
    const home = await mkdtemp(join(tmpdir(), 'fy-harness-probe-'));
    try {
      return await this.run({
        executable: path,
        args,
        environment: probeEnvironment(path, home, this.inherited),
        timeoutMs: this.timeoutMs,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
