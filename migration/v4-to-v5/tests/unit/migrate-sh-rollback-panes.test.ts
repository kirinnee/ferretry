import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, DAEMON_DOWN_SH, DAEMON_UP_SH, makeSandbox, type Sandbox } from './migrate-harness.ts';

// Proof run 7 findings: rollback left v5's panes running; `--restart` named every id whatever `fy restart` said; quiet
// listed empty agenda-change queues as "carried" while convert skips them.

setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const sockets: { stop(close?: boolean): void }[] = [];
const box = async (options?: Parameters<typeof makeSandbox>[0]): Promise<Sandbox> => {
  const sb = await makeSandbox(options);
  made.push(sb);
  return sb;
};
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.stop(true);
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

/** v5's own tmux server socket: a real unix socket where `[ -S ]` looks, and what its `list-panes` prints. */
const v5Server = async (sb: Sandbox, panes: string, v5Ferrets: readonly string[] = []): Promise<string> => {
  const sock = join(sb.v4home, 'state', 'terminals', 'tmux.sock');
  await mkdir(join(sb.v4home, 'state', 'terminals'), { recursive: true });
  for (const id of v5Ferrets) await mkdir(join(sb.v4home, 'state', 'ferrets', id), { recursive: true });
  sockets.push(Bun.listen({ unix: sock, socket: { data() {} } }));
  await sb.state('v5.panes', panes);
  await sb.fake('tmux', [
    { match: '*window_activity*', run: 'cat "$D/panes.activity"' },
    { match: '*kill-session*' },
    { match: '*session_name*', run: 'cat "$D/v5.panes"' },
    { match: '* ls', out: 'fy-f1: 1 windows' },
  ]);
  return sock;
};
const kills = async (sb: Sandbox): Promise<string[]> =>
  (await sb.calls()).filter(line => line.includes('kill-session')).map(line => line.replace(/^.* -t /, ''));

describe('rollback closes the panes v5 started and v4 does not own', () => {
  test('a v5-only session is closed and counted; the v4-owned one (the baseline names it) is never touched', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await v5Server(sb, 'fy-f1 %1\nfy-v5only %7\nfy-orphan %8\n', ['v5only', 'orphan']);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect((await kills(sb)).sort()).toEqual(['=fy-orphan', '=fy-v5only']);
    expect(result.out).toContain('closed 2 tmux session(s) v5 provably started');
    expect(result.out).toContain('left 1 v4-owned session(s) alone');
  });

  test('only v4-owned sessions on the server: nothing is closed, and it says 0', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await v5Server(sb, 'fy-f1 %1\n');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await kills(sb)).toEqual([]);
    expect(result.out).toContain('closed 0 tmux session(s)');
  });

  test('a session that will not close is named, and the rollback still finishes', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await v5Server(sb, 'fy-f1 %1\nfy-stuck %9\n', ['stuck']);
    await sb.fake('tmux', [
      { match: '*window_activity*', run: 'cat "$D/panes.activity"' },
      { match: '*kill-session*', code: 1 },
      { match: '*session_name*', run: 'cat "$D/v5.panes"' },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('closed 0 tmux session(s)');
    expect(result.out).toContain('could not close: fy-stuck');
  });
});

describe('rollback --restart names only the ferrets that restarted', () => {
  const restartWith = async (sb: Sandbox, text: string): Promise<void> => {
    await sb.state('restart.out', text);
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'daemon start', run: DAEMON_UP_SH },
      { match: 'daemon stop', run: DAEMON_DOWN_SH },
      { match: 'restart *', run: 'cat "$D/restart.out"' },
    ]);
  };

  test('refused and left-alone ferrets are not in the "restarted:" line; the counts are printed', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await restartWith(
      sb,
      [
        'Restarted now: 2',
        '  Chasity (f1)',
        '  g2',
        'Queued for their next idle moment: 1',
        '  Dana (f3): it is working; it restarts at its next idle moment',
        'Left alone: 1',
        '  Eve (f4): not running',
        '',
      ].join('\n'),
    );
    const result = await sb.run('rollback', ['--owner-yes', '--restart']);
    expect(result.code).toBe(0);
    const line = result.out.split('\n').find(each => each.includes('✅ restarted:')) ?? '';
    expect(line).toContain('restarted: f1 g2.');
    expect(line).not.toContain('f3');
    expect(line).not.toContain('f4');
    expect(result.out).toContain(
      'restart: 2 restarted now, 1 queued for their next idle moment, 1 left alone, 0 failed',
    );
  });

  test('nothing restarted now: no "✅ restarted" claim at all', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await restartWith(
      sb,
      'Restarted now: 0\nQueued for their next idle moment: 0\nLeft alone: 1\n  Eve (f1): not running\n',
    );
    const result = await sb.run('rollback', ['--owner-yes', '--restart']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('✅ restarted:');
    expect(result.out).toContain('no ferret was restarted now');
  });

  test('output with no counts to read claims nobody restarted', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await restartWith(sb, 'something unexpected\n');
    const result = await sb.run('rollback', ['--owner-yes', '--restart']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('✅ restarted:');
    expect(result.out).toContain('printed no counts to read');
  });
});

describe('quiet says only what convert will do with each agenda-change queue', () => {
  test('a non-empty queue is "carried"; an empty [] one is listed apart as nothing to carry; an unreadable one is set aside', async () => {
    const sb = await box();
    await advance(sb, 'baseline');
    const file = (ferret: string): string =>
      join(sb.v4home, 'state', 'sessions', ferret, 'agenda-changes.pending.json');
    await writeFile(file('f1'), '[{"id":"e1"}]');
    await writeFile(file('f2'), '[]');
    await mkdir(join(sb.v4home, 'state', 'sessions', 'f3'), { recursive: true });
    await writeFile(file('f3'), 'not json');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(0);
    const lineWith = (text: string): string => result.out.split('\n').find(each => each.includes(text)) ?? '';
    const queued = lineWith('queued agenda changes');
    expect(queued).toContain('f1');
    expect(queued).not.toContain('f2');
    expect(queued).not.toContain('f3');
    expect(lineWith('empty agenda-change queue files')).toContain('f2');
    expect(lineWith('not a readable list')).toContain('f3');
    expect(await sb.notesText()).toContain('QUEUED_AGENDA_CHANGES=f1');
  });

  test('only empty queues: there is no "queued agenda changes" line at all', async () => {
    const sb = await box();
    await advance(sb, 'baseline');
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-changes.pending.json'), '[]');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('queued agenda changes');
    expect(result.out).toContain('empty agenda-change queue files');
  });
});

describe("rollback closes nothing it cannot prove is v5's (fail closed)", () => {
  const baseDir = async (sb: Sandbox): Promise<string> =>
    (await sb.notesText())
      .split('\n')
      .find(line => line.startsWith('BASE='))
      ?.slice(5) ?? '';
  const none = async (sb: Sandbox, panes: string, ferrets: readonly string[] = []): Promise<void> => {
    await v5Server(sb, panes, ferrets);
  };

  for (const baseline of ['empty', 'missing', 'unreadable']) {
    test(`a ${baseline} baseline closes nothing (even a session v5 would own), says so, and the rollback finishes`, async () => {
      const sb = await box();
      await advance(sb, 'start');
      await none(sb, 'fy-f1 %1\nfy-v5only %7\n', ['f1', 'v5only']);
      const base = await baseDir(sb);
      for (const name of ['pane-owners.tsv', 'panes.txt']) {
        const path = join(base, name);
        if (baseline === 'empty') await writeFile(path, '');
        else {
          await rm(path);
          if (baseline === 'unreadable') await mkdir(path);
        }
      }
      const result = await sb.run('rollback', ['--owner-yes']);
      expect(result.code).toBe(0);
      expect(await kills(sb)).toEqual([]);
      expect(result.out).toContain("v5's panes were NOT closed");
    });
  }

  test('a session that is not fy-<id> of a v5 ferret is left alone and named', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await none(sb, 'fy-f1 %1\neditor-unrelated %7\nfy-ghost %8\nfy-v5only %9\n', ['v5only']);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await kills(sb)).toEqual(['=fy-v5only']);
    expect(result.out).toContain('left alone, not provably v5');
    expect(result.out).toContain('editor-unrelated');
    expect(result.out).toContain('fy-ghost');
  });

  test('a v4 session name that is also a v5 ferret folder is still never closed (the baseline wins)', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await none(sb, 'fy-f1 %1\n', ['f1']);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await kills(sb)).toEqual([]);
  });

  test('a tmux.sock that is a symlink to another server closes nothing', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const dir = join(sb.v4home, 'state', 'terminals');
    await mkdir(dir, { recursive: true });
    const other = join(sb.root, 'unrelated.sock');
    sockets.push(Bun.listen({ unix: other, socket: { data() {} } }));
    await symlink(other, join(dir, 'tmux.sock'));
    await mkdir(join(sb.v4home, 'state', 'ferrets', 'v5only'), { recursive: true });
    await sb.state('v5.panes', 'editor-unrelated %7\nfy-v5only %8\n');
    await sb.fake('tmux', [
      { match: '*window_activity*', run: 'cat "$D/panes.activity"' },
      { match: '*kill-session*' },
      { match: '*session_name*', run: 'cat "$D/v5.panes"' },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await kills(sb)).toEqual([]);
    expect(result.out).toContain('not v5');
  });

  test('a symlinked state/terminals folder closes nothing', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const real = join(sb.root, 'elsewhere');
    await mkdir(real, { recursive: true });
    sockets.push(Bun.listen({ unix: join(real, 'tmux.sock'), socket: { data() {} } }));
    await symlink(real, join(sb.v4home, 'state', 'terminals'));
    await mkdir(join(sb.v4home, 'state', 'ferrets', 'v5only'), { recursive: true });
    await sb.state('v5.panes', 'fy-v5only %8\n');
    await sb.fake('tmux', [
      { match: '*window_activity*', run: 'cat "$D/panes.activity"' },
      { match: '*kill-session*' },
      { match: '*session_name*', run: 'cat "$D/v5.panes"' },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await kills(sb)).toEqual([]);
  });

  test('a list failure warns and the rollback continues', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await none(sb, 'fy-f1 %1\n');
    await sb.fake('tmux', [
      { match: '*window_activity*', run: 'cat "$D/panes.activity"' },
      { match: '*session_name*', code: 1 },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain("v5's panes");
    expect(await kills(sb)).toEqual([]);
  });
});
