import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
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
const v5Server = async (sb: Sandbox, panes: string): Promise<string> => {
  const sock = join(sb.v4home, 'state', 'terminals', 'tmux.sock');
  await mkdir(join(sb.v4home, 'state', 'terminals'), { recursive: true });
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
    await v5Server(sb, 'fy-f1 %1\nfy-v5only %7\nfy-orphan %8\n');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect((await kills(sb)).sort()).toEqual(['=fy-orphan', '=fy-v5only']);
    expect(result.out).toContain(
      'closed 2 tmux session(s) v5 started that v4 does not own; left 1 v4-owned session(s) alone',
    );
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
    await v5Server(sb, 'fy-f1 %1\nfy-stuck %9\n');
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
