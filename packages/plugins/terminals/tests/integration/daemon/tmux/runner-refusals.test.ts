/**
 * The refusals of `TmuxRunner` over a scripted tmux, each said out loud or answered with nothing: a ferret id that is no
 * tmux session name proves and stops nothing, a pane that is not THIS ferret's is not named, a process whose start could
 * not be read is named without one (and says so), and a has-session that fails any other way is thrown and logged.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { TmuxRunner, type PaneProcessHost } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const FERRET = 'mw7bp88g-50e00159' as FerretId;
const OTHER = 'mw7bp99h-61f11260' as FerretId;
/** A ferret id that is no tmux session name (`[a-z0-9_.-]` only): its session cannot be addressed. */
const UNADDRESSABLE = 'Not A Ferret' as FerretId;
const PANE = '%7' as RunnerHandle;
const NOW = '2026-11-18T10:00:00.000Z';

interface Reply {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

function runner(
  script: (args: readonly string[]) => Reply | 'throw',
  options: { readonly processes?: Pick<PaneProcessHost, 'startOf'> } = {},
) {
  const calls: (readonly string[])[] = [];
  const warnings: string[] = [];
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        const reply = script(args);
        if (reply === 'throw') throw new Error('spawn failed');
        return { code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
      },
    },
    spawn: {
      run: async () => {
        throw new Error('no spawn here');
      },
      runBytes: () => Promise.reject(new Error('no spawn here')),
      start: () => {
        throw new Error('no spawn here');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => NOW as never,
    now: () => NOW as never,
    log: { warn: (message: string) => void warnings.push(message) },
    ...(options.processes === undefined ? {} : { processes: options.processes as PaneProcessHost }),
  });
  return { subject, calls, warnings };
}

describe('a ferret id that is no tmux session name', () => {
  test('proves no exit, and asks tmux nothing', async () => {
    const { subject, calls } = runner(() => ({ code: 0 }));

    expect(await subject.exited(UNADDRESSABLE, PANE)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('stops nothing by name when the pane behind the handle is gone', async () => {
    const { subject, calls } = runner(args => (args[0] === 'display-message' ? { code: 1 } : { code: 0 }));

    await subject.stop(PANE, 'now', UNADDRESSABLE);

    expect(calls.map(args => args[0])).toEqual(['display-message']);
  });
});

describe('TmuxRunner.identify refuses a pane that is not this ferret’s, and says why', () => {
  const listing = (session: string) => (args: readonly string[]) =>
    args[0] === 'list-panes' ? { code: 0, stdout: `${PANE}|4242|0|${session}|1000\n` } : { code: 0 };

  test('a pane outside every ferret’s session is not named', async () => {
    const { subject, warnings } = runner(listing('work'));

    expect(await subject.identify(PANE, FERRET)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is not a ferret's session");
  });

  test('another ferret’s pane behind a stale handle is not named either', async () => {
    const { subject, warnings } = runner(listing(`fy-${OTHER}`));

    expect(await subject.identify(PANE, FERRET)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the handle is stale');
  });

  test('a process whose start could not be read is named without one, and the warning says so', async () => {
    const { subject, warnings } = runner(listing(`fy-${FERRET}`), {
      processes: { startOf: async () => undefined } as Pick<PaneProcessHost, 'startOf'>,
    });

    expect(await subject.identify(PANE, FERRET)).toEqual({ handle: PANE, pid: 4242 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('is named without a process start');
  });
});

describe('a stop by name whose has-session fails any other way', () => {
  test('is thrown, and warned with the session it could not check', async () => {
    const { subject, warnings } = runner(args => {
      if (args[0] === 'display-message') return { code: 1 };
      return { code: 1, stderr: 'server exited unexpectedly' };
    });

    await expect(subject.stop(PANE, 'now', FERRET)).rejects.toThrow(/so it was not stopped; it may still be running/u);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`fy-${FERRET}`);
  });
});
