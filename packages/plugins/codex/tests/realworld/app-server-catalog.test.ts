/**
 * A REAL `codex app-server` answers `model/list` with no login.
 *
 * The fast-start catalog is read by the located Codex binary in a folder of its own, with a scrubbed
 * environment and a throwaway HOME, because a read nobody asked an account for must not need one.
 * `tests/integration/app-server-catalog.test.ts` proves the probe against a shell script that speaks the
 * protocol; nothing there can say whether the real binary still answers that way. This is where a Codex
 * release that starts demanding a login for its model list is caught.
 *
 * Realworld, because the outcome depends on the machine's Codex as much as on this code. It is SKIPPED, with the
 * reason printed, when there is no Codex binary: `FY_CONTRACT_CODEX_BIN` (the variable
 * `packages/plugins/logins/tests/realworld/contract/run.sh` sets), else a `codex` on PATH. The nightly
 * realworld job installs none, so it skips there; it runs on a machine that has one (the owner's, or `run.sh`).
 *
 * NO CREDENTIAL IS READ OR USED. The child's HOME and CODEX_HOME are empty temporary folders (the assertion
 * below checks CODEX_HOME holds no `auth.json` before and after), PATH is minimal, nothing from the caller's
 * environment is inherited, and no proxy is set: a model list that needed the network would fail here, which
 * is the finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildHandle, FencedPath, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';
import { CodexAppServerCatalog } from '../../daemon/adapters/app-server-catalog.ts';
import { realClock } from '../support/ports.ts';

/** The Codex under test: the contract guard's own variable first, else whatever `codex` PATH finds. */
const CODEX: string | null = (() => {
  const named = process.env.FY_CONTRACT_CODEX_BIN;
  if (named !== undefined && named !== '') return named;
  return Bun.which('codex');
})();

/** Said out loud when the suite is skipped, so a skipped run is never mistaken for a passing one. */
const SKIP_REASON =
  'no Codex binary: set FY_CONTRACT_CODEX_BIN or put `codex` on PATH to check that a real `codex app-server` lists models with no login';
if (CODEX === null) console.warn(`[skipped] codex app-server model/list: ${SKIP_REASON}`);

/**
 * A spawn port that hands the child EXACTLY the environment it is given and nothing from this process, the way the
 * kernel does for a scrubbed read. (`tests/support/ports.ts` drops `env` altogether, which would let the caller's
 * own HOME and credentials in.)
 */
function scrubbedSpawn(): SpawnPort {
  const unused = async (): Promise<never> => {
    throw new Error('not used by this test');
  };
  return {
    run: unused,
    runBytes: unused,
    start: (program: string, args: readonly string[], options?: SpawnOptions): ChildHandle => {
      const child = Bun.spawn([program, ...args], {
        ...(typeof options?.cwd === 'string' ? { cwd: options.cwd } : {}),
        env: { ...(options?.env as Record<string, string> | undefined) },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        pid: child.pid,
        stdout: child.stdout as ReadableStream<Uint8Array>,
        stderr: child.stderr as ReadableStream<Uint8Array>,
        write: chunk => {
          child.stdin.write(chunk);
        },
        kill: signal => child.kill((signal ?? 'SIGTERM') as NodeJS.Signals),
        pipes: [],
        closePipes: () => undefined,
        get exited() {
          return child.exited.then(code => code);
        },
      };
    },
  };
}

describe.skipIf(CODEX === null)('a real `codex app-server`, with no login', () => {
  let root = '';
  let home = '';
  let codexHome = '';
  let cwd = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fy-codex-nologin-'));
    home = path.join(root, 'home');
    codexHome = path.join(root, 'codex-home');
    cwd = path.join(root, 'cwd');
    await Promise.all([mkdir(home), mkdir(codexHome), mkdir(cwd)]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should answer model/list with a non-empty catalog', async () => {
    // Arrange — a Codex that has no credential anywhere it can look.
    const binary = CODEX as string;
    // An npm-installed launcher is a `node` script, so its own folder joins the minimal PATH.
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: `${path.dirname(binary)}:/usr/bin:/bin`,
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
    };
    const catalog = new CodexAppServerCatalog({
      spawn: scrubbedSpawn(),
      clock: realClock(),
      clientName: 'fyd',
      clientVersion: '0.0.0-realworld',
      timeoutMs: 60_000,
    });
    expect(await readdir(codexHome)).not.toContain('auth.json');

    // Act
    const choices = await catalog.models(binary, cwd as FencedPath, env);

    // Assert — the list is the point; a login was never asked for.
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.value).not.toBe('');
      expect(choice.label).not.toBe('');
    }
    expect(await readdir(codexHome)).not.toContain('auth.json');
  }, 90_000);
});
