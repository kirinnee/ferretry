/**
 * `TmuxRunner.stop` / `signal` with a stale pane id. A pane id is not an identity: the private tmux server hands `%0`
 * out again after it restarts, so a handle a record kept (a converted v4 ferret's, one from before a restart) can name
 * ANOTHER ferret's pane. A stop through it used to end that ferret's session; with the ferret named it ends only its own.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const STALE_OWNER = 'mw7bp88g-50e00159' as FerretId;
const LIVE_OWNER = 'mw7bp99h-61f11260' as FerretId;
/** The pane `%5` is now the second ferret's, and alive. */
const PANE = '%5' as RunnerHandle;

/** `ownSession`: the ferret named on a stop still has its OWN session (`=fy-<id>`) under another pane id. */
function runner(ownSession = false) {
  const calls: (readonly string[])[] = [];
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        if (args[0] === 'display-message') {
          return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1700000000\n`, stderr: '' };
        }
        if (args[0] === 'has-session') {
          const own = args.at(-1) === `=fy-${STALE_OWNER}`;
          return own && ownSession
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 1, stdout: '', stderr: "can't find session: x" };
        }
        if (args[0] === 'list-panes') return { code: 0, stdout: '0\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    spawn: {
      run: async () => {
        throw new Error('stop must not spawn');
      },
      runBytes: () => Promise.reject(new Error('stop must not spawn')),
      start: () => {
        throw new Error('stop must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    politeGraceMs: 0,
    instantOf: () => '2026-11-08T10:00:00.000Z' as never,
    now: () => '2026-11-08T10:00:00.000Z' as never,
  });
  const writes = () => calls.filter(args => args[0] === 'kill-session' || args[0] === 'send-keys');
  return { subject, writes };
}

describe('TmuxRunner stop and signal through a stale pane id', () => {
  test('a stop that names a ferret kills nothing when the pane behind the handle is another ferret', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test('a polite stop does not press Ctrl-C at another ferret either', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'polite', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test("a stop whose handle names another ferret's pane stops the ferret's OWN session by exact name", async () => {
    const now = runner(true);
    await now.subject.stop(PANE, 'now', STALE_OWNER);
    expect(now.writes()).toEqual([['kill-session', '-t', `=fy-${STALE_OWNER}`]]);

    const polite = runner(true);
    await polite.subject.stop(PANE, 'polite', STALE_OWNER);
    expect(polite.writes()).toEqual([
      ['send-keys', '-t', `=fy-${STALE_OWNER}:`, 'C-c'],
      ['kill-session', '-t', `=fy-${STALE_OWNER}`],
    ]);
    // Never the pane id that names the other ferret.
    expect([...now.writes(), ...polite.writes()].some(args => args.includes(PANE))).toBe(false);
  });

  test('a stop by name that tmux refuses is thrown, never taken for a stop that happened', async () => {
    const calls: (readonly string[])[] = [];
    const refusing = (refused: string) =>
      new TmuxRunner({
        tmux: {
          execute: async args => {
            calls.push(args);
            if (args[0] === 'display-message') return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1\n`, stderr: '' };
            if (args[0] === 'list-panes') return { code: 0, stdout: '0\n', stderr: '' };
            if (args[0] === refused) return { code: 1, stdout: '', stderr: "can't find pane: x" };
            return { code: 0, stdout: '', stderr: '' };
          },
        },
        spawn: {
          run: async () => {
            throw new Error('stop must not spawn');
          },
          runBytes: () => Promise.reject(new Error('stop must not spawn')),
          start: () => {
            throw new Error('stop must not spawn');
          },
        },
        socketPath: '/fixture/tmux.sock',
        politeGraceMs: 0,
        instantOf: () => '2026-11-08T10:00:00.000Z' as never,
        now: () => '2026-11-08T10:00:00.000Z' as never,
      });

    await expect(refusing('send-keys').stop(PANE, 'polite', STALE_OWNER)).rejects.toThrow(/could not interrupt/u);
    await expect(refusing('kill-session').stop(PANE, 'now', STALE_OWNER)).rejects.toThrow(/could not stop/u);
  });

  test('a polite stop by name whose pane read FAILS is not escalated to a kill: it stops nothing and says so', async () => {
    const failures: { readonly stderr: string; readonly throws: boolean }[] = [
      { stderr: 'server exited unexpectedly', throws: false },
      { stderr: 'error connecting to /s (Permission denied)', throws: false },
      { stderr: '', throws: true },
    ];
    for (const failure of failures) {
      const calls: (readonly string[])[] = [];
      const warnings: string[] = [];
      const subject = new TmuxRunner({
        tmux: {
          execute: async args => {
            calls.push(args);
            if (args[0] === 'display-message') return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1\n`, stderr: '' };
            if (args[0] === 'list-panes') {
              if (failure.throws) throw new Error('spawn failed');
              return { code: 1, stdout: '', stderr: failure.stderr };
            }
            return { code: 0, stdout: '', stderr: '' };
          },
        },
        spawn: {
          run: async () => {
            throw new Error('stop must not spawn');
          },
          runBytes: () => Promise.reject(new Error('stop must not spawn')),
          start: () => {
            throw new Error('stop must not spawn');
          },
        },
        socketPath: '/fixture/tmux.sock',
        politeGraceMs: 0,
        instantOf: () => '2026-11-08T10:00:00.000Z' as never,
        now: () => '2026-11-08T10:00:00.000Z' as never,
        log: { warn: message => void warnings.push(message) },
      });

      await expect(subject.stop(PANE, 'polite', STALE_OWNER)).rejects.toThrow(
        /was not stopped; it may still be running/u,
      );

      expect(calls.filter(args => args[0] === 'kill-session' || args[0] === 'send-keys')).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`fy-${STALE_OWNER}`);
    }
  });

  test('a polite stop by name whose session ended between the check and the read is the stop already made', async () => {
    const calls: (readonly string[])[] = [];
    const subject = new TmuxRunner({
      tmux: {
        execute: async args => {
          calls.push(args);
          if (args[0] === 'display-message') return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1\n`, stderr: '' };
          if (args[0] === 'list-panes') return { code: 1, stdout: '', stderr: "can't find session: x" };
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      spawn: {
        run: async () => {
          throw new Error('stop must not spawn');
        },
        runBytes: () => Promise.reject(new Error('stop must not spawn')),
        start: () => {
          throw new Error('stop must not spawn');
        },
      },
      socketPath: '/fixture/tmux.sock',
      politeGraceMs: 0,
      instantOf: () => '2026-11-08T10:00:00.000Z' as never,
      now: () => '2026-11-08T10:00:00.000Z' as never,
    });
    await subject.stop(PANE, 'polite', STALE_OWNER);
    expect(calls.filter(args => args[0] === 'kill-session' || args[0] === 'send-keys')).toEqual([]);
  });

  test('a signal that names a ferret does nothing to another ferret', async () => {
    const { subject, writes } = runner();

    await subject.signal(PANE, 'terminate', STALE_OWNER);
    await subject.signal(PANE, 'interrupt', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test("a stop that names the pane's own ferret still ends it", async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now', LIVE_OWNER);

    expect(writes().map(args => args[0])).toEqual(['kill-session']);
  });

  test('a stop that names no ferret trusts the handle, as a launch cleaning up its own pane does', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now');

    expect(writes().map(args => args[0])).toEqual(['kill-session']);
  });
});
