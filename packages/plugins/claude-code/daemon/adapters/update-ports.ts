import type { FetchPort, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { HarnessConfig } from '../../contract/index.ts';
import {
  passesThroughHomeManagerPath,
  parseNixProfileList,
  nixStorePaths,
  symlinkHops,
} from '../lib/update/nix-facts.ts';
import type {
  ClaudeLocation,
  FactsSource,
  LatestAnswer,
  LatestSource,
  LocationSource,
  Probe,
  RunPort,
  RunResult,
  StartupCheck,
} from '../lib/update/ports.ts';
import { npmLatestUrl, parseNpmLatest, parseVersionOutput } from '../lib/update/recipes.ts';

/** How long `--version` or `--help` may take. A cold node start on a slow disk is a few seconds. */
const PROBE_TIMEOUT_MS = 20_000;

/** How long a fact command (`readlink`, `nix profile list`) may take. */
const FACT_TIMEOUT_MS = 5_000;

/** How long the newest-version question may take before the answer is "could not reach npm". */
const NPM_CHECK_TIMEOUT_MS = 10_000;

/** A proxy address nothing listens on: any request the binary makes fails at once instead of leaving. */
const NOWHERE = 'http://127.0.0.1:9';

/**
 * The environment a probe adds on top of the host's: a home that holds no login, no settings and no history,
 * and every proxy variable pointed at {@link NOWHERE}, so neither question can read a login or reach the network.
 */
const PROBE_ENVIRONMENT: Readonly<Record<string, string>> = {
  HOME: '/nonexistent/fy-harness-probe',
  CLAUDE_CONFIG_DIR: '/nonexistent/fy-harness-probe/.claude',
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

const tailOf = (stdout: string, stderr: string): readonly string[] =>
  `${stdout}\n${stderr}`
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-12);

/** One program run, no stdin. A program that cannot start is `not-started`; a killed one `timed-out`. */
export function spawnRun(spawn: SpawnPort, env: Readonly<Record<string, string>> = {}): RunPort {
  return async request => {
    try {
      const result = await spawn.run(request.program, request.args, {
        timeout: milliseconds(request.timeoutMs),
        env: { NONINTERACTIVE: '1', ...env },
      });
      const tail = tailOf(result.stdout, result.stderr);
      if (result.exitCode === null) return { kind: 'timed-out', tail } satisfies RunResult;
      return { kind: 'exited', code: result.exitCode, tail } satisfies RunResult;
    } catch (error) {
      return {
        kind: 'not-started',
        reason: error instanceof Error ? error.message : String(error),
      } satisfies RunResult;
    }
  };
}

/** A fact command's stdout, or `undefined` when it did not run, did not finish or exited non-zero. */
async function fact(spawn: SpawnPort, program: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await spawn.run(program, args, { timeout: milliseconds(FACT_TIMEOUT_MS) });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** This host's home directory and platform, asked once (no home or platform port exists in the kernel). */
export function hostFacts(spawn: SpawnPort): {
  home(): Promise<string>;
  platform(): Promise<string>;
} {
  let home: Promise<string> | undefined;
  let platform: Promise<string> | undefined;
  return {
    home: () => (home ??= fact(spawn, 'printenv', ['HOME']).then(out => (out ?? '').trim())),
    platform: () => (platform ??= fact(spawn, 'uname', ['-s']).then(out => (out ?? '').trim().toLowerCase())),
  };
}

const expandHome = (value: string, home: string): string | undefined => {
  if (value === '~') return home === '' ? undefined : home;
  if (!value.startsWith('~/')) return value;
  return home === '' ? undefined : `${home.replace(/\/+$/u, '')}/${value.slice(2)}`;
};

/**
 * THE ONE RULE (`docs/harness-paths.md`): the exact file the config names, then the config's search
 * directories in order, then the inherited `PATH`. A named path that resolves to nothing fails loudly and
 * searches no further. A candidate is found by starting it with `--version`, in the throwaway environment.
 */
export function locationSource(
  spawn: SpawnPort,
  config: () => HarnessConfig | undefined,
  host: ReturnType<typeof hostFacts>,
): LocationSource {
  const starts = async (path: string): Promise<boolean> => {
    const run = await spawnRun(
      spawn,
      PROBE_ENVIRONMENT,
    )({ program: path, args: ['--version'], timeoutMs: PROBE_TIMEOUT_MS });
    return run.kind === 'exited' && run.code === 0;
  };
  return {
    locate: async (): Promise<ClaudeLocation> => {
      const document = config();
      const home = await host.home();
      const key = 'config/harness-claude-code.yaml';
      if (document?.binary !== undefined) {
        const path = expandHome(document.binary, home);
        if (path === undefined)
          return {
            outcome: 'override-absent',
            path: document.binary,
            declaredBy: `${key} binary`,
            reason: 'its ~ cannot be expanded because this daemon does not know the home directory',
          };
        return (await starts(path))
          ? { outcome: 'located', path, rule: 'explicit path', declaredBy: `${key} binary` }
          : {
              outcome: 'override-absent',
              path,
              declaredBy: `${key} binary`,
              reason: 'nothing there starts when asked for its version',
            };
      }
      const searched: string[] = [];
      for (const [index, directory] of (document?.searchPaths ?? []).entries()) {
        const expanded = expandHome(directory, home);
        if (expanded === undefined) continue;
        const path = `${expanded.replace(/\/+$/u, '')}/claude`;
        searched.push(path);
        if (await starts(path))
          return { outcome: 'located', path, rule: 'search directory', declaredBy: `${key} searchPaths[${index}]` };
      }
      const onPath = (await fact(spawn, 'which', ['claude']))?.trim();
      if (onPath !== undefined && onPath !== '')
        return { outcome: 'located', path: onPath, rule: 'inherited environment', declaredBy: 'PATH' };
      searched.push('PATH');
      return { outcome: 'absent', searched };
    },
  };
}

/** The facts about the file a runtime launches: its resolved path, its link chain, and the nix profile element that holds it. */
export function factsSource(spawn: SpawnPort, host: ReturnType<typeof hostFacts>): FactsSource {
  const readLink = async (path: string): Promise<string | undefined> => {
    const out = (await fact(spawn, 'readlink', [path]))?.trim();
    return out === undefined || out === '' ? undefined : out;
  };
  return {
    facts: async launchedPath => {
      const resolvedPath = (await fact(spawn, 'readlink', ['-f', launchedPath]))?.trim() || launchedPath;
      const hops = await symlinkHops(launchedPath, readLink);
      const candidates = [resolvedPath, ...nixStorePaths(hops)];
      let profile: ReturnType<typeof parseNixProfileList> = { homeManager: false };
      if (candidates[0]?.startsWith('/nix/store/') === true) {
        const listed = await fact(spawn, 'nix', ['profile', 'list', '--json']);
        if (listed !== undefined) {
          try {
            profile = parseNixProfileList(JSON.parse(listed), candidates);
          } catch {
            profile = { homeManager: false };
          }
        }
      }
      return {
        launchedPath,
        resolvedPath,
        homeDirectory: await host.home(),
        platform: await host.platform(),
        nixProfileElement: profile.element,
        homeManagerProfile: profile.homeManager,
        viaHomeManagerPath: passesThroughHomeManagerPath(hops),
      };
    },
  };
}

/** Asking the binary about itself, isolated by {@link PROBE_ENVIRONMENT}. */
export function probe(spawn: SpawnPort): Probe {
  const run = spawnRun(spawn, PROBE_ENVIRONMENT);
  return {
    version: async path => {
      const result = await run({ program: path, args: ['--version'], timeoutMs: PROBE_TIMEOUT_MS });
      if (result.kind === 'not-started') return { state: 'unreadable', reason: result.reason };
      if (result.kind === 'timed-out') return { state: 'unreadable', reason: 'it did not answer within 20 seconds' };
      const version = parseVersionOutput(result.tail.join('\n'));
      if (result.code !== 0 || version === undefined)
        return { state: 'unreadable', reason: `it exited ${String(result.code)} without printing a version` };
      return { state: 'ok', version };
    },
    startup: async (path): Promise<StartupCheck> => {
      const result = await run({ program: path, args: ['--help'], timeoutMs: PROBE_TIMEOUT_MS });
      if (result.kind === 'not-started') return { ok: false, reason: result.reason };
      if (result.kind === 'timed-out') return { ok: false, reason: '--help did not finish within 20 seconds' };
      return result.code === 0 ? { ok: true } : { ok: false, reason: `--help exited ${String(result.code)}` };
    },
  };
}

/**
 * ONE HTTP READ: what is the newest published `claude`? npm's `latest` dist-tag is where it publishes first;
 * Homebrew and nixpkgs follow it, sometimes days later. A version compare only — nothing is downloaded. It
 * never throws and never retries.
 */
export function npmLatest(network: FetchPort, userAgent: string): LatestSource {
  return {
    latest: async (): Promise<LatestAnswer> => {
      let response: Response;
      try {
        response = await network.request(npmLatestUrl(), {
          cache: 'no-store',
          headers: { accept: 'application/json', 'user-agent': userAgent },
          signal: AbortSignal.timeout(NPM_CHECK_TIMEOUT_MS),
        });
      } catch {
        return { kind: 'failed', reason: 'could not reach npm' };
      }
      if (!response.ok) return { kind: 'failed', reason: `npm answered ${String(response.status)}` };
      const release = parseNpmLatest(await response.json().catch(() => undefined));
      return release === undefined
        ? { kind: 'failed', reason: 'npm did not name a stable version' }
        : { kind: 'ok', release };
    },
  };
}
