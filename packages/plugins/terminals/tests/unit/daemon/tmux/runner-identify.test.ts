/**
 * c58-37 `Runner.identify?` and `Runner.signalDescendant?`, over a scripted tmux and a scripted process host.
 *
 * The properties that matter, because the second one is a kill primitive:
 * - identity is the TRIPLE handle, pid and start; `'gone'` only on proof; anything else that cannot be told is `undefined`;
 * - one signal reaches ONE pid, only if that pid with that start is a descendant of the pane root RIGHT NOW, and never a
 *   protected pid (the daemon or one of its parents).
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { TmuxRunner, type PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { ProcessDetailRow, ProcessTreeRead } from '../../../../daemon/lib/session/processes/ports.ts';

const HANDLE = '%7' as RunnerHandle;
const ROOT = 4242;
const ROOT_START = 9000;
/** The ferret whose session `live()` names. */
const FERRET = 'ferret-one' as FerretId;

interface Reply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const live = (pane = '%7', pid = ROOT, dead = '0', session = 'fy-ferret-one'): Reply => ({
  code: 0,
  stdout: `%1|1|0|fy-other|500\n${pane}|${pid}|${dead}|${session}|1000\n`,
  stderr: '',
});

function row(pid: number, ppid: number, start: number): ProcessDetailRow {
  return { pid, ppid, start, startedAtMs: 0, argv: `job-${String(pid)}`, state: 'S' };
}

interface Signalled {
  readonly pid: number;
  readonly signal: string;
}

function world(
  options: {
    readonly tmux?: () => Promise<Reply> | Reply;
    readonly rows?: readonly ProcessDetailRow[] | (() => readonly ProcessDetailRow[]);
    readonly tree?: ProcessTreeRead;
    readonly startOf?: (pid: number) => number | undefined;
    readonly protectedPids?: readonly number[];
    readonly kill?: (pid: number, signal: string) => void;
    readonly host?: false;
  } = {},
) {
  const calls: (readonly string[])[] = [];
  const warnings: string[] = [];
  const signalled: Signalled[] = [];
  const starts = new Map<number, number>([[ROOT, ROOT_START]]);
  const rowsNow = (): readonly ProcessDetailRow[] =>
    typeof options.rows === 'function' ? options.rows() : (options.rows ?? []);
  const host: PaneProcessHost = {
    startOf: async pid =>
      options.startOf !== undefined
        ? options.startOf(pid)
        : (starts.get(pid) ?? rowsNow().find(r => r.pid === pid)?.start),
    tree: async () => options.tree ?? { kind: 'read', rows: rowsNow() },
    signal: (pid, signal) => {
      if (options.kill !== undefined) options.kill(pid, signal);
      signalled.push({ pid, signal });
    },
    protectedPids: async () => options.protectedPids ?? [100, 50],
  };
  const runner = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        return await (options.tmux ?? (() => live()))();
      },
    },
    spawn: {
      run: async () => {
        throw new Error('identify must not spawn');
      },
      runBytes: () => Promise.reject(new Error('identify must not spawn')),
      start: () => {
        throw new Error('identify must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'now' as never,
    now: () => 'now' as never,
    log: { warn: message => void warnings.push(message) },
    ...(options.host === false ? {} : { processes: host }),
  });
  return { runner, calls, signalled, warnings };
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('TmuxRunner.identify', () => {
  test('names the live pane by handle, pid and the pid start', async () => {
    const { runner } = world();
    expect(await runner.identify(HANDLE)).toEqual({ handle: HANDLE, pid: ROOT, processStart: String(ROOT_START) });
  });

  test('names the pane for its own ferret, and tells nothing of it for another ferret whose stale handle it is', async () => {
    // The pane `%7` is `fy-ferret-one`'s. A record of `ferret-two` that kept `%7` after a server restart must not take
    // stock of `ferret-one`'s processes (a move would hand them to ferret-two's new first turn).
    const { runner } = world();
    expect(await runner.identify(HANDLE, 'ferret-one' as FerretId)).toEqual({
      handle: HANDLE,
      pid: ROOT,
      processStart: String(ROOT_START),
    });
    expect(await runner.identify(HANDLE, 'ferret-two' as FerretId)).toBeUndefined();
  });

  test('a refusal says which proof failed, in plain words: the session name, then the start ticks', async () => {
    const other = world();
    expect(await other.runner.identify(HANDLE, 'ferret-two' as FerretId)).toBeUndefined();
    expect(other.warnings).toHaveLength(1);
    expect(other.warnings[0]).toContain('session name "fy-ferret-one" is not this ferret\'s session "fy-ferret-two"');

    const notFerret = world({ tmux: () => live('%7', ROOT, '0', 'main') });
    expect(await notFerret.runner.identify(HANDLE)).toBeUndefined();
    expect(notFerret.warnings[0]).toContain('session name "main" is not a ferret\'s session');

    const noStart = world({ startOf: () => undefined });
    expect(await noStart.runner.identify(HANDLE)).toEqual({ handle: HANDLE, pid: ROOT });
    expect(noStart.warnings[0]).toContain(`start ticks of its process (pid ${String(ROOT)}) could not be read`);

    const fine = world();
    await fine.runner.identify(HANDLE, 'ferret-one' as FerretId);
    expect(fine.warnings).toEqual([]);
  });

  test('is read-only: it asks tmux to list panes and nothing else', async () => {
    const { runner, calls } = world();
    await runner.identify(HANDLE);
    expect(calls.map(call => call[0])).toEqual(['list-panes']);
  });

  test('a pane absent from a server that answered is proved gone', async () => {
    const { runner } = world({ tmux: () => live('%9') });
    expect(await runner.identify(HANDLE)).toBe('gone');
  });

  test('a server that is not running holds nothing: gone', async () => {
    for (const stderr of [
      'no server running on /fixture/tmux.sock',
      'error connecting to /s (No such file or directory)',
    ]) {
      const { runner } = world({ tmux: () => ({ code: 1, stdout: '', stderr }) });
      expect(await runner.identify(HANDLE)).toBe('gone');
    }
  });

  test('what proves nothing is undefined, never gone: a refused socket, a lost server, a throw', async () => {
    for (const stderr of ['error connecting to /s (Permission denied)', 'server exited unexpectedly', ''])
      expect(await world({ tmux: () => ({ code: 1, stdout: '', stderr }) }).runner.identify(HANDLE)).toBeUndefined();
    expect(
      await world({ tmux: () => Promise.reject(new Error('spawn failed')) }).runner.identify(HANDLE),
    ).toBeUndefined();
  });

  test('a dead pane tmux keeps has a handle and no pid', async () => {
    const { runner } = world({ tmux: () => live('%7', ROOT, '1') });
    expect(await runner.identify(HANDLE)).toEqual({ handle: HANDLE });
  });

  test('a pane that is not a ferret session is not vouched for', async () => {
    for (const session of ['fy-webterm-abc', 'main'])
      expect(await world({ tmux: () => live('%7', ROOT, '0', session) }).runner.identify(HANDLE)).toBeUndefined();
  });

  test('a handle that is no pane id is never asked about', async () => {
    const { runner, calls } = world();
    expect(await runner.identify('not-a-pane' as RunnerHandle)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a start that cannot be read leaves the start out, so a caller sees an unproven identity', async () => {
    const { runner } = world({ startOf: () => undefined });
    expect(await runner.identify(HANDLE)).toEqual({ handle: HANDLE, pid: ROOT });
  });

  test('a runner given no process host still names the pane, without a start', async () => {
    const { runner } = world({ host: false });
    expect(await runner.identify(HANDLE)).toEqual({ handle: HANDLE, pid: ROOT });
  });
});

describe('TmuxRunner.signalDescendant', () => {
  const job = row(5000, ROOT, 9100);
  const grandchild = row(5001, 5000, 9200);
  const rows = [job, grandchild];

  test("a stale handle that now names ANOTHER ferret's pane signals nothing of its tree, even a proved descendant", async () => {
    // `%7` is `fy-ferret-one`'s pane. A record of `ferret-two` still holding it must not signal `ferret-one`'s job.
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5001, '9200', 'SIGKILL', 'ferret-two' as FerretId)).toBe(false);
    expect(signalled).toEqual([]);
    // The pane's own ferret still can.
    expect(await runner.signalDescendant(HANDLE, 5001, '9200', 'SIGKILL', 'ferret-one' as FerretId)).toBe(true);
    expect(signalled).toEqual([{ pid: 5001, signal: 'SIGKILL' }]);
  });

  test('a call that names no ferret (an untyped caller) signals nothing: no ferret is never any ferret', async () => {
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5001, '9200', 'SIGKILL', undefined as never)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('delivers ONE signal to ONE pid that descends from the pane root and matches its start', async () => {
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5001, '9200', 'SIGTERM', FERRET)).toBe(true);
    expect(signalled).toEqual([{ pid: 5001, signal: 'SIGTERM' }]);
  });

  test('delivers SIGKILL when asked, and no other signal', async () => {
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGKILL', FERRET)).toBe(true);
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGSTOP' as never, FERRET)).toBe(false);
    expect(signalled).toEqual([{ pid: 5000, signal: 'SIGKILL' }]);
  });

  test('a pid that is not below the pane root is never signalled', async () => {
    const { runner, signalled } = world({ rows, startOf: pid => (pid === ROOT ? ROOT_START : 7777) });
    expect(await runner.signalDescendant(HANDLE, 777, '7777', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a reused pid (another start) is never signalled', async () => {
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5000, '9101', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a caller that could not read the start cannot prove which run it means: nothing is signalled', async () => {
    const { runner, signalled } = world({ rows });
    expect(await runner.signalDescendant(HANDLE, 5000, undefined, 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('the start is re-read just before the signal: a pid that changed in between is left alone', async () => {
    // The tree still lists 9100; the fresh read just before the signal says the pid is another run now.
    const { runner, signalled } = world({ rows, startOf: pid => (pid === ROOT ? ROOT_START : 9999) });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a protected pid (the daemon or a parent of it) is never signalled, even when it sits below the pane', async () => {
    const daemon = row(100, 5000, 9300);
    const parent = row(50, 100, 9400);
    const { runner, signalled } = world({ rows: [job, daemon, parent], protectedPids: [100, 50] });
    expect(await runner.signalDescendant(HANDLE, 100, '9300', 'SIGKILL', FERRET)).toBe(false);
    expect(await runner.signalDescendant(HANDLE, 50, '9400', 'SIGKILL', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('the pane root itself, init and nonsense pids are never signalled', async () => {
    const { runner, signalled } = world({ rows: [row(1, ROOT, 5), row(-4, ROOT, 5), row(0, ROOT, 5), job] });
    for (const pid of [ROOT, 1, 0, -4, 1.5, Number.NaN])
      expect(await runner.signalDescendant(HANDLE, pid, String(ROOT_START), 'SIGKILL', FERRET)).toBe(false);
    expect(await runner.signalDescendant(HANDLE, 1, '5', 'SIGKILL', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a pane that is gone or dead signals nothing', async () => {
    for (const tmux of [() => live('%9'), () => live('%7', ROOT, '1')]) {
      const { runner, signalled } = world({ rows, tmux });
      expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
      expect(signalled).toEqual([]);
    }
  });

  test('a pane that is not a ferret session signals nothing', async () => {
    const { runner, signalled } = world({ rows, tmux: () => live('%7', ROOT, '0', 'fy-webterm-x') });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a tree that cannot be read proves no descent: nothing is signalled', async () => {
    const { runner, signalled } = world({ rows, tree: { kind: 'unavailable', reason: 'no procfs' } });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a pane root that was replaced while the tree was read signals nothing', async () => {
    let rootReads = 0;
    const { runner, signalled } = world({
      rows,
      startOf: pid => {
        if (pid !== ROOT) return pid === 5000 ? 9100 : undefined;
        rootReads += 1;
        return rootReads === 1 ? ROOT_START : ROOT_START + 1;
      },
    });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });

  test('a process that exited (ESRCH) or is not ours (EPERM) is not delivered; anything else still rejects', async () => {
    for (const code of ['ESRCH', 'EPERM'])
      expect(
        await world({
          rows,
          kill: () => {
            throw errno(code);
          },
        }).runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET),
      ).toBe(false);
    await expect(
      world({
        rows,
        kill: () => {
          throw errno('EINVAL');
        },
      }).runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET),
    ).rejects.toThrow('EINVAL');
  });

  test('a runner given no process host signals nothing', async () => {
    const { runner, signalled } = world({ rows, host: false });
    expect(await runner.signalDescendant(HANDLE, 5000, '9100', 'SIGTERM', FERRET)).toBe(false);
    expect(signalled).toEqual([]);
  });
});
