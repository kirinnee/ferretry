import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
  await advance(sb, 'baseline');
});
afterEach(async () => {
  await sb.cleanup();
});

describe('quiet: fail closed, never certify a failed read', () => {
  test('the owner must confirm: no flag, no stop', async () => {
    const result = await sb.run('quiet');
    expect(result.code).toBe(1);
    expect(result.err).toContain('--owner-confirmed');
    expect((await sb.calls()).filter(line => line.startsWith('fy daemon stop'))).toEqual([]);
  });

  test('R2.1: a fake tmux that exits 42 is "unreadable" (exit 2), never "quiet"', async () => {
    await sb.fake('tmux', [{ match: '*window_activity*', code: 42 }]);
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('tmux could not be read');
    expect(await sb.notesText()).not.toContain('# quiet\n');
    // It gave up before stopping anything.
    expect((await sb.calls()).filter(line => line.startsWith('fy daemon stop'))).toEqual([]);
  });

  test('a pane that keeps writing is "never quiet" (exit 1), after the allowed tries', async () => {
    await sb.fake('tmux', [
      {
        match: '*window_activity*',
        run: 'n=$(cat "$D/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$D/n"; echo "%1 $n"',
      },
      { match: '* ls' },
    ]);
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('kept writing');
    const sleeps = (await sb.calls()).filter(line => line === 'sleep 60');
    expect(sleeps).toHaveLength(3);
  });

  test('R2.1: the second check (after the daemon stops) is read too; tmux failing then is exit 2', async () => {
    await sb.fake('fy', [{ match: 'daemon stop', run: 'touch "$D/stopped"' }]);
    await sb.fake('tmux', [{ match: '*window_activity*', run: '[ ! -f "$D/stopped" ] || exit 42; echo "%1 100"' }]);
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('after the daemon stopped');
    expect(await sb.notesText()).toContain('# v4-daemon-stopped');
    expect(await sb.notesText()).not.toContain('# quiet\n');
  });

  test('happy: the check runs before and after the stop, and the daemon is stopped in between', async () => {
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(0);
    const calls = await sb.calls();
    const stop = calls.indexOf('fy daemon stop');
    const reads = calls
      .map((line, index) => (line.includes('window_activity') ? index : -1))
      .filter(index => index >= 0);
    expect(reads.some(index => index < stop)).toBe(true);
    expect(reads.some(index => index > stop)).toBe(true);
    expect(await sb.notesText()).toContain('# quiet\n');
    expect(calls.some(line => line.includes('kill-server'))).toBe(false);
  });

  test('R2.1: FOUND pending files never counts as quiet; v4 runs a minute, stops, and the owner starts over', async () => {
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-1.pending.json'), '{}');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('agenda-1.pending.json');
    expect(result.err).toContain('quiet window is NOT established');
    const notes = await sb.notesText();
    expect(notes).toContain('# quiet-retry');
    expect(notes).not.toContain('# quiet\n');
    const calls = await sb.calls();
    expect(calls.filter(line => line === 'fy daemon stop')).toHaveLength(2);
    expect(calls).toContain('fy daemon start');
  });

  test('queued agenda changes (agenda-changes.pending.json) are queued state, not pending: quiet passes and names the ferrets', async () => {
    // v4 delivers these at a ferret's next turn end; a quiet window has no turns, so they can never drain.
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-changes.pending.json'), '[{"id":"e1"}]');
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f2', 'agenda-changes.pending.json'), '[{"id":"e2"}]');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('queued agenda changes');
    expect(result.out).toContain('f1');
    expect(result.out).toContain('f2');
    expect(await sb.notesText()).toContain('# quiet\n');
    const calls = await sb.calls();
    // No "start v4 for a minute": nothing was in flight.
    expect(calls.filter(line => line === 'fy daemon stop')).toHaveLength(1);
    expect(calls).not.toContain('fy daemon start');
  });

  test('a real in-flight agenda write beside a queued change still refuses', async () => {
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-changes.pending.json'), '[{"id":"e1"}]');
    await writeFile(join(sb.v4home, 'state', 'sessions', 'f1', 'agenda-versions.pending.json'), '{}');
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('agenda-versions.pending.json');
    expect(result.out).not.toContain('agenda-changes.pending.json\n');
  });

  test('an unreadable session folder is exit 2, never "nothing pending"', async () => {
    const locked = join(sb.v4home, 'state', 'sessions', 'f2');
    await chmod(locked, 0o000);
    try {
      const result = await sb.run('quiet', ['--owner-confirmed']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('cannot read');
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe('quiet: the empty fleet', () => {
  test('no live panes: the pane checks are skipped (not failed), the daemon still stops', async () => {
    const empty = await makeSandbox({ panes: false });
    try {
      await advance(empty, 'baseline');
      expect(await empty.notesText()).toContain('PANES=none');
      await empty.fake('tmux', [{ match: '*', code: 42 }]); // any tmux call would fail the run
      const result = await empty.run('quiet', ['--owner-confirmed']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('empty fleet');
      expect((await empty.calls()).filter(line => line.startsWith('tmux'))).toEqual([]);
      expect((await empty.calls()).filter(line => line === 'fy daemon stop')).toHaveLength(1);
    } finally {
      await empty.cleanup();
    }
  });

  test('panes owned but the tmux socket is gone is exit 2 at baseline, not an "empty fleet"', async () => {
    const broken = await makeSandbox();
    try {
      await advance(broken, 'preflight');
      await rm(join(broken.v4home, 'tmux.sock'));
      const result = await broken.run('baseline', ['--asks-open', '0']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('tmux.sock is not there');
    } finally {
      await broken.cleanup();
    }
  });
});

void mkdir;
