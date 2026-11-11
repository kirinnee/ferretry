/**
 * Which Codex binary the contract guard runs against, and the sealed sandbox each run gets (ported from v4's
 * `fleet/tests/contract/support/harness.ts`, Codex half only: Claude's mechanisms are not file links).
 *
 * The guard is opt-in: `FY_HARNESS_CONTRACT=1` turns it on and `run.sh` is the one place that sets it, after resolving a
 * `codex` into `FY_CONTRACT_CODEX_BIN` (the flake-pinned one, the latest npm one, or the one on PATH). Every other test
 * run walks `tests/realworld/**` and sees a skipped suite. Opting in without a binary is a FAILURE, never a skip: a
 * guard that silently measured nothing would be the false green this suite exists to prevent.
 *
 * Nothing here inherits the caller's environment. A child sees a throwaway `HOME`, a minimal `PATH`, and a proxy that
 * records where it tried to go and forwards nothing, so no credential of the person running it can be read and no request
 * can leave the machine. Every token is a fake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface HarnessUnderTest {
  /** The command a person runs. */
  readonly bin: string;
  /** The installed tree, searched for the strings the design depends on. */
  readonly root: string;
}

export const contract = {
  enabled: process.env.FY_HARNESS_CONTRACT === '1',
  codex: ((): HarnessUnderTest | undefined => {
    const bin = process.env.FY_CONTRACT_CODEX_BIN;
    if (bin === undefined || bin === '') return undefined;
    const root = process.env.FY_CONTRACT_CODEX_ROOT;
    return { bin, root: root === undefined || root === '' ? path.dirname(bin) : root };
  })(),
  ripgrep: process.env.FY_CONTRACT_RG ?? 'rg',
};

/** The Codex a suite measures, or a loud failure when the guard is on and it is missing. */
export function requireCodex(): HarnessUnderTest {
  if (contract.codex === undefined)
    throw new Error(
      'FY_HARNESS_CONTRACT=1 but FY_CONTRACT_CODEX_BIN is unset — the guard would measure nothing. Run packages/plugins/logins/tests/realworld/contract/run.sh',
    );
  return contract.codex;
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

/** The whole environment a Codex child sees: every proxy variable points at the recording proxy, nothing leaves loopback. */
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

/** Whether the installed tree still contains `needle` — the cheapest way to say WHICH rename broke the guard. */
export async function treeContains(root: string, needle: string): Promise<boolean> {
  const found = await run(
    [contract.ripgrep, '-a', '-l', '-F', '--no-ignore', '--hidden', '-L', '-m', '1', needle, root],
    { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 120_000 },
  );
  return found.code === 0 && found.stdout.trim() !== '';
}

/**
 * Kill every process whose command line names `root`. From 0.16x Codex starts a background app-server daemon from inside
 * `CODEX_HOME` that outlives the TUI it served; a sandbox path is unique (mkdtemp), so this reaches only what this suite
 * started. BY LITERAL PATH, NEVER BY PATTERN, and only under the temporary directory.
 */
export async function reap(root: string): Promise<void> {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`))
    throw new Error(`refusing to reap ${resolved}: it is not inside the temporary directory`);
  const listed = await run(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args='], {
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
  });
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    const pid = Number(match?.[1]);
    const args = match?.[2] ?? '';
    if (pid === process.pid || !(args.includes(`${resolved}${path.sep}`) || args.split(/\s+/u).includes(resolved)))
      continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
