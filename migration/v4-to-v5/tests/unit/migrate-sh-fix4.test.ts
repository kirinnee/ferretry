import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * Fix round 4 (the same lead ruling as round 3): a live PID, an answering socket/port, or an UNKNOWN identity is "running"
 * in EVERY rollback branch, including the one whose notes record no v5 launch. It is stopped the documented way and
 * re-checked, or the script refuses BEFORE any move. A marker in the notes never overrides live or unknown evidence.
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
const record = async (sb: Sandbox, body: string): Promise<void> => {
  await mkdir(join(sb.v4home, 'run'), { recursive: true });
  await writeFile(join(sb.v4home, 'run', 'daemon.json'), body);
};
const refusingStop = (sb: Sandbox): Promise<void> =>
  sb.fake('fy', [
    { match: '--version', run: 'cat "$D/fy.version"' },
    { match: 'daemon stop', err: 'cannot stop', code: 1 },
  ]);
const leavingStop = (sb: Sandbox): Promise<void> =>
  sb.fake('fy', [{ match: '--version', run: 'cat "$D/fy.version"' }, { match: 'daemon stop' }]);

describe('fix4: rollback with NO v5 launch marker (after convert, before the v5 launch)', () => {
  test('a live owned bun PID + a stop that fails: refused before any move, H tree and mtimes unchanged', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.daemonUp({ comm: 'bun' });
    await refusingStop(sb);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(await stopCalls(sb)).toBeGreaterThan(0);
    expect(result.err).toContain('failed for the daemon that is running or may be');
    expect(result.err).toContain('nothing was moved');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('a live owned bun PID + a stop that leaves it running: refused before any move, H unchanged', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.daemonUp({ comm: 'bun' });
    await leavingStop(sb);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('still running or may be after');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('a live owned bun PID + a stop that works: it is stopped the documented way, then the home moves', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.daemonUp({ comm: 'bun' });
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before + 1);
    expect(result.out).not.toContain('left alone');
    expect(result.out).toContain('proven: no daemon is running');
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('an UNPARSABLE daemon record + a stop that leaves it: refused before any move, H unchanged', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await record(sb, '{"format": 1, "pid": ');
    await leavingStop(sb);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('UNKNOWN');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('an UNPARSABLE daemon record + a stop that fails: refused before any move, H unchanged', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await record(sb, 'not json at all');
    await refusingStop(sb);
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });

  test('after the v5 install (fy is v5) the documented stop is the v5 fy; the live PID is stopped, then the home moves', async () => {
    const sb = await box();
    await advance(sb, 'install');
    await sb.daemonUp({ comm: 'bun' });
    const before = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await stopCalls(sb)).toBe(before + 1);
    expect(result.out).toContain('with the v5 fy');
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('fy is neither v4 nor v5: the right stop cannot be chosen, nothing is stopped, moved or written', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.daemonUp({ comm: 'bun' });
    await sb.state('fy.version', '3.0.0\n');
    const treeBefore = await sb.treeSignature(sb.v4home);
    const callsBefore = await stopCalls(sb);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot be chosen');
    expect(await stopCalls(sb)).toBe(callsBefore);
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
  });
});

describe('fix4: backup moves H aside, so it follows the same rule', () => {
  test('a live PID after quiet: backup refuses before the move, H unchanged, no backup folder', async () => {
    const sb = await box();
    await advance(sb, 'quiet');
    await sb.daemonUp({ comm: 'bun' });
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('backup', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('quiet window no longer holds');
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
    expect(await exists((await sb.notesText()).match(/^B=(.+$)/m)?.[1] ?? '')).toBe(false);
  });

  test('an UNPARSABLE record after quiet: backup refuses before the move, H unchanged', async () => {
    const sb = await box();
    await advance(sb, 'quiet');
    await sb.daemonUp();
    await record(sb, '{"pid": ');
    const treeBefore = await sb.treeSignature(sb.v4home);
    const result = await sb.run('backup', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('UNKNOWN');
    expect(await sb.treeSignature(sb.v4home)).toBe(treeBefore);
    expect(await exists((await sb.notesText()).match(/^B=(.+$)/m)?.[1] ?? '')).toBe(false);
  });
});
