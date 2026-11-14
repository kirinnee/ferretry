import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * Fix round 3 (lead ruling): v4/v5 is RUNNING when ANY of: a live PID in H/run/daemon.json (kill -0), the recorded or
 * documented socket / port answers, or the identity is unknown. No process name, executable or command line is matched.
 * Fake homes only; the fixture "daemon" is a short-lived child started and killed by PID here.
 */
setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const box = async (options: Parameters<typeof makeSandbox>[0] = {}): Promise<Sandbox> => {
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
const stopCalls = async (sb: Sandbox): Promise<number> =>
  (await sb.calls()).filter(line => line === 'fy daemon stop').length;
/** The v5 start happened (notes record it), the harness's own fixture is gone: the test supplies the exact daemon state. */
const started = async (sb: Sandbox): Promise<void> => {
  await advance(sb, 'start');
  await sb.daemonDown();
};
const record = (sb: Sandbox, body: string): Promise<void> => writeFile(join(sb.v4home, 'run', 'daemon.json'), body);

describe('fix3: the reviewer repro - a live daemon whose process name is "bun"', () => {
  test('a recorded live PID (comm "bun") counts as running: it is stopped the documented way BEFORE the home moves', async () => {
    const sb = await box();
    await started(sb);
    await sb.daemonUp({ comm: 'bun' });
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before + 1);
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('the same with a stop that FAILS: it stops cleanly, H is untouched (tree and mtimes), nothing moved', async () => {
    const sb = await box();
    await started(sb);
    await sb.daemonUp({ comm: 'bun' });
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'daemon stop', err: 'cannot stop', code: 1 },
    ]);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('failed for the v5 daemon');
    expect(result.err).toContain('is alive');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('the same with a stop that "succeeds" but leaves it running: stops cleanly, H untouched', async () => {
    const sb = await box();
    await started(sb);
    await sb.daemonUp({ comm: 'bun' });
    await sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('still running after');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });
});

describe('fix3: every other signal', () => {
  test('daemon.json with a DEAD pid and no socket: not running, the rollback proceeds without a stop', async () => {
    const sb = await box();
    await started(sb);
    const pid = await sb.daemonUp();
    process.kill(pid);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await Bun.sleep(20);
    }
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before);
    expect(result.out).toContain('proven: no daemon is running');
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('daemon.json UNPARSABLE: unknown counts as running; a stop that leaves it stops cleanly, nothing moved', async () => {
    const sb = await box();
    await started(sb);
    await record(sb, '{"format": 1, "pid": ');
    await sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('UNKNOWN');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('daemon.json with no usable pid field: unknown counts as running', async () => {
    const sb = await box();
    await started(sb);
    await record(sb, JSON.stringify({ format: 1, socket: '/x', host: '127.0.0.1', port: 9, version: '5.0.0' }));
    await sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('UNKNOWN');
    expect(await exists(failedHome(sb))).toBe(false);
  });

  test('the documented socket answers but the pid file is MISSING: running', async () => {
    const sb = await box();
    await started(sb);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(sb.v4home, 'run'), { recursive: true });
    const listener = Bun.listen({ unix: join(sb.v4home, 'run', 'fyd.sock'), socket: { data() {} } });
    try {
      await sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);
      const treeBefore = await sb.treeSignature(sb.v4home);
      const result = await sb.run('rollback', ['--owner-yes']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('socket');
      expect(result.err).toContain('answers');
      expect(await exists(failedHome(sb))).toBe(false);
      expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
    } finally {
      listener.stop(true);
    }
  });

  test('a dead pid but the recorded loopback PORT answers: running', async () => {
    const sb = await box();
    await started(sb);
    const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const pid = await sb.daemonUp();
      process.kill(pid);
      await Bun.sleep(300);
      await record(
        sb,
        JSON.stringify({
          format: 1,
          socket: join(sb.v4home, 'run', 'none.sock'),
          host: '127.0.0.1',
          port: listener.port,
          pid,
          version: '5.0.0',
        }),
      );
      await sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);
      const result = await sb.run('rollback', ['--owner-yes']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('answers');
      expect(await exists(failedHome(sb))).toBe(false);
    } finally {
      listener.stop(true);
    }
  });

  test('a stale socket FILE that nothing listens on is not "answering": not running', async () => {
    const sb = await box();
    await started(sb);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(sb.v4home, 'run'), { recursive: true });
    const listener = Bun.listen({ unix: join(sb.v4home, 'run', 'fyd.sock'), socket: { data() {} } });
    listener.stop(true); // closes the listener; the socket node may remain
    await Bun.sleep(100);
    await rm(join(sb.v4home, 'run', 'fyd.sock'), { force: true });
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await exists(failedHome(sb))).toBe(true);
  });
});
