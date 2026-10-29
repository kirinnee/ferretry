/**
 * Which harness binaries the contract guard runs against, and the sealed sandbox each run gets.
 *
 * The guard is opt-in: `FY_HARNESS_CONTRACT=1` turns it on, and `run.sh` is the one place that sets
 * it, after resolving the pinned (or latest) `claude` and `codex` into `FY_CONTRACT_*`. Every other
 * test run — the unit and integration tiers both walk `tests/**` — sees a skipped suite, because
 * those tiers have no harness to measure.
 *
 * Opting in without a binary is a FAILURE, never a skip: a guard that silently measured nothing
 * would be the exact false green this suite exists to prevent.
 *
 * Nothing here ever inherits the caller's environment. A child sees a throwaway `HOME`, a minimal
 * `PATH`, and a proxy that records where it tried to go and forwards nothing, so no credential of
 * the person running it can be read and no request can leave the machine.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface HarnessUnderTest {
  /** The command a person runs. */
  readonly bin: string;
  /** The installed tree, searched for strings the design depends on. */
  readonly root: string;
}

export interface ContractConfig {
  readonly enabled: boolean;
  readonly claude: HarnessUnderTest | undefined;
  readonly codex: HarnessUnderTest | undefined;
  readonly openssl: string;
  readonly ripgrep: string;
}

const harnessFrom = (bin: string | undefined, root: string | undefined): HarnessUnderTest | undefined =>
  bin === undefined || bin === ''
    ? undefined
    : { bin, root: root === undefined || root === '' ? path.dirname(bin) : root };

export const contract: ContractConfig = {
  enabled: process.env.FY_HARNESS_CONTRACT === '1',
  claude: harnessFrom(process.env.FY_CONTRACT_CLAUDE_BIN, process.env.FY_CONTRACT_CLAUDE_ROOT),
  codex: harnessFrom(process.env.FY_CONTRACT_CODEX_BIN, process.env.FY_CONTRACT_CODEX_ROOT),
  openssl: process.env.FY_CONTRACT_OPENSSL ?? 'openssl',
  ripgrep: process.env.FY_CONTRACT_RG ?? 'rg',
};

/** The harness a suite measures, or a loud failure when the guard is on and it is missing. */
export function requireHarness(name: 'claude' | 'codex'): HarnessUnderTest {
  const harness = contract[name];
  if (harness === undefined) {
    throw new Error(
      `FY_HARNESS_CONTRACT=1 but FY_CONTRACT_${name.toUpperCase()}_BIN is unset — the guard would measure nothing. Run packages/fleet/tests/contract/run.sh`,
    );
  }
  return harness;
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  dir(...parts: string[]): string;
  dispose(): Promise<void>;
}

export async function sandbox(prefix: string): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), `fyc-${prefix}-`));
  return {
    root,
    home: path.join(root, 'home'),
    dir: (...parts: string[]) => path.join(root, ...parts),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * The whole environment a harness child sees. `USER` is set because Claude's macOS keychain item is
 * keyed on it; every proxy variable points at the recording proxy so nothing reaches a network.
 */
export function harnessEnv(
  home: string,
  proxyPort: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  return {
    HOME: home,
    // `run.sh` widens this only for an npm-installed harness, whose launcher needs `node`.
    PATH: process.env.FY_CONTRACT_PATH ?? '/usr/bin:/bin',
    USER: process.env.USER ?? 'fy-contract',
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    ALL_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  };
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run to completion, or kill at the ceiling — a harness that waits on the dead network must not wedge the job. */
export async function run(
  command: readonly string[],
  options: { env: Record<string, string>; cwd?: string; timeoutMs?: number },
): Promise<Ran> {
  const child = Bun.spawn([...command], {
    env: options.env,
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Poll until `check` holds or the budget runs out; the caller asserts on what it finds. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  everyMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(everyMs);
  }
  return await check();
}

/** Whether the installed tree still contains `needle` — the cheapest way to say WHICH rename broke the guard. */
export async function treeContains(root: string, needle: string): Promise<boolean> {
  const found = await run(
    [contract.ripgrep, '-a', '-l', '-F', '--no-ignore', '--hidden', '-L', '-m', '1', needle, root],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 120_000,
    },
  );
  return found.code === 0 && found.stdout.trim() !== '';
}

/**
 * Kill every process whose command line names `root`. From 0.16x Codex starts a background
 * app-server daemon from inside `CODEX_HOME` that outlives the TUI it served; a sandbox path is
 * unique (mkdtemp), so this reaches only what this suite started.
 *
 * BY LITERAL PATH, NEVER BY PATTERN, and only under the temporary directory. `pkill -f` takes a
 * regular expression and matches it against every command line on the machine; a suite is often run
 * from inside a live agent whose own processes carry long command lines.
 */
export async function reap(root: string): Promise<void> {
  const sandbox = path.resolve(root);
  if (!sandbox.startsWith(`${path.resolve(tmpdir())}${path.sep}`))
    throw new Error(`refusing to reap ${sandbox}: it is not inside the temporary directory`);
  const listed = await run(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], {
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
  });
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    const pid = Number(match?.[1]);
    const args = match?.[2] ?? '';
    if (pid === process.pid || !(args.includes(`${sandbox}${path.sep}`) || args.split(/\s+/u).includes(sandbox)))
      continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** A harness's `major.minor.patch`, read off its own `--version`, for a claim that changed at a release. */
export type HarnessVersion = readonly [number, number, number];

export async function harnessVersion(bin: string, env: Record<string, string>): Promise<HarnessVersion> {
  const { stdout } = await run([bin, '--version'], { env });
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(stdout);
  if (match === null) throw new Error(`${bin} --version printed no version: ${JSON.stringify(stdout)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `version` is `at` or newer. */
export const atLeast = (version: HarnessVersion, at: HarnessVersion): boolean => {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== at[index]) return (version[index] as number) > (at[index] as number);
  }
  return true;
};
