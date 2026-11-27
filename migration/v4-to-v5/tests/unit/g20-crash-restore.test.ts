import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);
let sb: Sandbox | undefined;
afterEach(async () => {
  await sb?.cleanup();
});

for (const panes of [false, true]) {
  for (const recovery of ['rollback', 'backup'] as const) {
    test(`F: ${recovery} restores the session after keeper SIGKILL between exchange and publication (${panes ? 'live panes' : 'no panes'})`, async () => {
      const { session, lease } = await crashAtExchange(panes);
      if (sb === undefined) throw new Error('sandbox missing');
      const result = await sb.run(recovery, ['--owner-yes']);
      if (recovery === 'rollback') expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
      else expect(result.all).toContain('restored');
      expect(await readFile(session, 'utf8')).toBe('the only session history\n');
      expect((await lstat(sb.v4home)).isDirectory()).toBe(true);
      if (panes && recovery === 'rollback') {
        expect(result.out).toContain('quiet before');
        expect((await sb.calls()).some(call => call.includes(join(lease, 'old-home/tmux.sock')))).toBe(true);
      }
    });
  }
}

async function crashAtExchange(panes: boolean) {
  sb = await makeSandbox({ panes });
  // Even without live panes, the home contains irreplaceable session data.
  const session = join(sb.v4home, 'state/sessions/f1/history');
  await writeFile(session, 'the only session history\n');
  await advance(sb, 'quiet');
  const helper = join(sb.repo, 'migration/v4-to-v5/src/cutover-home.ts');
  const source = await readFile(helper, 'utf8');
  const boundary = 'exchangePaths(staged, home);';
  expect(source).toContain(boundary);
  await writeFile(helper, source.replace(boundary, boundary + "\nprocess.kill(process.pid, 'SIGKILL');"));
  for (const args of [
    ['add', '-A'],
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'inject keeper crash'],
  ]) {
    const proc = Bun.spawn(['git', ...args], { cwd: sb.repo, stdout: 'ignore', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
  }
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: sb.repo });
  await writeFile(
    sb.notes,
    (await sb.notesText()).replace(/^COMMIT=.*$/m, `COMMIT=${commit.stdout.toString().trim()}`),
  );
  const crashed = await sb.run('backup', ['--owner-yes']);
  expect(crashed.code).not.toBe(0);
  const notes = await sb.notesText();
  const backup = notes.match(/^B=(.*)$/m)![1]!;
  const lease = notes.match(/^LEASE=(.*)$/m)![1]!;
  expect(await lstat(backup).catch(() => undefined)).toBeUndefined();
  expect((await lstat(sb.v4home)).isFile()).toBe(true);
  expect(await readFile(join(lease, 'old-home/state/sessions/f1/history'), 'utf8')).toBe('the only session history\n');
  return { session, lease, backup };
}

for (const changed of ['home', 'placeholder'] as const) {
  test(`F: recovery refuses a replaced ${changed} and keeps the session`, async () => {
    const { lease } = await crashAtExchange(false);
    if (sb === undefined) throw new Error('sandbox missing');
    const staged = join(lease, 'old-home');
    const saved = join(lease, 'saved-entry');
    if (changed === 'home') {
      await rename(staged, saved);
      await mkdir(staged);
    } else {
      const text = await readFile(sb.v4home, 'utf8');
      await rename(sb.v4home, saved);
      await writeFile(sb.v4home, text);
    }
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).not.toBe(0);
    expect(result.all).toContain('cannot verify interrupted cutover');
    expect(await readFile(join(changed === 'home' ? saved : staged, 'state/sessions/f1/history'), 'utf8')).toBe(
      'the only session history\n',
    );
    expect((await lstat(sb.v4home)).isFile()).toBe(true);
  });
}
