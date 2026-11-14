import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, DAEMON_UP_SH, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * Round-4 review of migrate.sh (the fix1 re-check, findings F1, F2 and F4). Each test here failed on the script as it
 * was at 72ae794e93 and passes now. F3 (the credential-only repair path) was dropped by the lead and is not touched.
 */

setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const box = async (options?: Parameters<typeof makeSandbox>[0]): Promise<Sandbox> => {
  const sb = await makeSandbox(options);
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
const failedHome = (sb: Sandbox): string => `${sb.v4home}-v5-failed-2026-11-13-1200`;
/** Every regular file under the WHOLE sandbox root (HOME, fake tool logs, notes, repo) that holds a value. */
const filesHolding = async (sb: Sandbox, value: string): Promise<string[]> => {
  const proc = Bun.spawn(['grep', '-rl', '--', value, sb.root], { stdout: 'pipe', stderr: 'ignore' });
  const hits = (await new Response(proc.stdout).text()).split('\n').filter(Boolean);
  await proc.exited;
  return hits;
};
const stopCalls = async (sb: Sandbox): Promise<number> =>
  (await sb.calls()).filter(line => line === 'fy daemon stop').length;

describe('F1 (round 4, still holds): a live daemon after the v5 start is stopped BEFORE the home moves', () => {
  test('F1: a live recorded daemon after the v5 start is stopped BEFORE the home moves', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before + 1);
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('F1: a daemon that survives "fy daemon stop" stops the rollback: exit 1, nothing moved', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'daemon stop' }, // reports success but the daemon keeps running
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('still running');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(true);
  });

  test('F1: a daemon live after a failed start is seen by the failed-start proof (it does not claim "no daemon")', async () => {
    const sb = await box();
    await advance(sb, 'install');
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'config check', out: 'config ok' },
      { match: 'daemon start', run: DAEMON_UP_SH, code: 1 },
    ]);
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.all).not.toContain('proven: no daemon is running');
    expect(result.err).toContain('a daemon may still be running');
  });

  test('F1 control: a process list full of fyd-named processes is NOT a signal (no record, no socket: not running)', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.daemonDown();
    await sb.state('ps.out', '/nix/store/x/bin/.fyd-wrapped\nfyd\n');
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before);
  });
});

describe('F2: a missing tmux socket while live panes are expected is UNKNOWN, never "the panes are gone"', () => {
  test('F2: the recorded panes exist but no socket can be found (no daemon either): exit 2 with a sentence, nothing moved', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await rm(`${sb.v4home}-before-2026-11-13-1200/tmux.sock`);
    await sb.daemonDown();
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('UNKNOWN');
    expect(result.err).toContain('nothing was moved');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(true);
  });

  test('F2: the same with a live v5 daemon: it is not stopped away from its panes, and the home is not moved', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await rm(`${sb.v4home}-before-2026-11-13-1200/tmux.sock`);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(2);
    expect(await exists(failedHome(sb))).toBe(false);
  });

  test('F2 control: no live panes were recorded and no socket exists: the empty-fleet rollback still succeeds', async () => {
    const sb = await box({ panes: false });
    await advance(sb, 'start');
    await sb.daemonDown();
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await exists(failedHome(sb))).toBe(true);
  });
});

describe('F4: FY_URL is cleaned before the first child process of every phase', () => {
  const SENTINEL = 'QUERY-CREDENTIAL-FIX2-SENTINEL';
  const urls: [string, string][] = [
    ['a query', `http://127.0.0.1:7777?token=${SENTINEL}`],
    ['a path and a fragment', `http://127.0.0.1:7777/x#${SENTINEL}`],
  ];
  for (const [name, url] of urls) {
    test(`F4: FY_URL with ${name}: the sentinel is in NO file under the sandbox root and in NO child environment, preflight included`, async () => {
      const sb = await box();
      const env = { FY_URL: url };
      for (const [phase, args] of [
        ['preflight', ['--notes', sb.notes]],
        ['baseline', ['--asks-open', '0']],
        ['quiet', ['--owner-confirmed']],
        ['backup', ['--owner-yes']],
        ['convert', []],
        ['install', []],
        ['start', []],
        ['verify', []],
        ['rollback', ['--owner-yes']],
      ] as const) {
        const result = await sb.run(phase, args, env);
        expect(`${phase}: ${result.code}`).toBe(`${phase}: 0`);
        expect(result.all).not.toContain(SENTINEL);
      }
      const log = await sb.envLog();
      expect(log.length).toBeGreaterThan(0);
      // Every child (the very first --version of preflight too) saw the address only, never the query or fragment.
      expect(log.join('\n')).not.toContain(SENTINEL);
      expect(log.some(line => line.startsWith('fy|--version|') && line.includes('FY_URL=http://127.0.0.1:7777|'))).toBe(
        true,
      );
      expect(await filesHolding(sb, SENTINEL)).toEqual([]);
    });
  }

  test('F4: credentials before the host are refused by preflight and the secret reaches no child either', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], {
      FY_URL: `http://user:${SENTINEL}@127.0.0.1:7777`,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('carries credentials');
    expect(await exists(sb.notes)).toBe(false);
    expect((await sb.envLog()).join('\n')).not.toContain(SENTINEL);
    expect(await filesHolding(sb, SENTINEL)).toEqual([]);
  });

  test('F4: an FY_URL that is not an http(s) address is refused and is not passed on to any child', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], { FY_URL: `ftp://x/?t=${SENTINEL}` });
    expect(result.code).toBe(1);
    expect((await sb.envLog()).join('\n')).not.toContain(SENTINEL);
    expect(await filesHolding(sb, SENTINEL)).toEqual([]);
  });
});
