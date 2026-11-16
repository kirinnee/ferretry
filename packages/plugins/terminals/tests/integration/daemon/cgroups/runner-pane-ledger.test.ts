import { afterEach, describe, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import type { FerretId } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { RunnerCgroupPaneLedger, type RunnerPaneDirectory } from '../../../../daemon/adapters/cgroups/index.ts';
import { TmuxPaneObserver } from '../../../../daemon/adapters/session/attach/tmux-pane-observer.ts';
import { processIncarnationFor } from '../../../../daemon/adapters/session/processes/process-incarnation.ts';
import type { RegisteredTerminalPane } from '../../../../daemon/lib/session/attach/index.ts';

/**
 * The live panes a limit change may reach, through the observer the daemon binds: the private tmux server is the
 * ONE stand-in (it answers which pid a recorded session's pane holds), and the process behind that pid is real — a
 * `sleep` this test started — so the start time the ledger compares is read from the kernel, not written by the test.
 */

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function sleeper(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  if (child.pid === undefined) throw new Error('sleep did not start');
  return child.pid;
}

const incarnation = processIncarnationFor(process.platform, bunSpawn({ PATH: '/usr/bin:/bin' }));

/** What the runner recorded for a pane: the session, the pane id, the pid, and the pid's start as read NOW. */
async function recorded(pid: number): Promise<RegisteredTerminalPane> {
  const processStartTicks = await incarnation.startOf(pid);
  if (processStartTicks === undefined) throw new Error('the child has no start time');
  return { tmuxSession: `fy-${pid}`, paneId: '%3', pid, processStartTicks };
}

/** A private tmux server whose panes are exactly `panes`, by session. */
function tmuxHolding(panes: Readonly<Record<string, { readonly paneId: string; readonly pid: number }>>) {
  return {
    paneIdentity: async (session: string) => panes[session],
  };
}

const directory = (panes: Readonly<Record<string, RegisteredTerminalPane | undefined>>): RunnerPaneDirectory => ({
  live: async () => Object.keys(panes) as FerretId[],
  paneOf: async ferret => panes[ferret],
});

describe('the live panes a limit change may reach, as the daemon observes them', () => {
  it('should offer a pane whose process is still the incarnation the runner recorded', async () => {
    const pid = sleeper();
    const pane = await recorded(pid);
    const subject = new RunnerCgroupPaneLedger(
      directory({ s1: pane }),
      new TmuxPaneObserver(tmuxHolding({ [pane.tmuxSession]: { paneId: pane.paneId, pid } }), incarnation),
    );

    const live = await subject.live();

    should(live).deepEqual({ panes: [{ sessionId: 's1', pid }], unproven: [] });
  });

  it('should call a pane unproven when its recorded start is not the process now holding the pid', async () => {
    const pid = sleeper();
    const pane = await recorded(pid);
    const subject = new RunnerCgroupPaneLedger(
      directory({ s1: { ...pane, processStartTicks: pane.processStartTicks + 1 } }),
      new TmuxPaneObserver(tmuxHolding({ [pane.tmuxSession]: { paneId: pane.paneId, pid } }), incarnation),
    );

    const live = await subject.live();

    should(live.panes).deepEqual([]);
    should(live.unproven).have.length(1);
    should(live.unproven[0]?.sessionId).equal('s1');
    should(live.unproven[0]?.failure).match(/no longer the incarnation this daemon launched/u);
    should(live.unproven[0]?.failure).containEql(`pid ${pid}`);
  });

  it('should call a pane unproven when tmux no longer holds its session, and skip a ferret with no pane', async () => {
    const pid = sleeper();
    const pane = await recorded(pid);
    const subject = new RunnerCgroupPaneLedger(
      directory({ s1: pane, s2: undefined }),
      new TmuxPaneObserver(tmuxHolding({}), incarnation),
    );

    const live = await subject.live();

    should(live.panes).deepEqual([]);
    should(live.unproven.map(entry => entry.sessionId)).deepEqual(['s1']);
  });

  it('should call a pane unproven when the observer itself cannot answer', async () => {
    const pane = await recorded(sleeper());
    const subject = new RunnerCgroupPaneLedger(
      directory({ s1: pane }),
      new TmuxPaneObserver(
        {
          paneIdentity: async () => {
            throw new Error('tmux is not answering');
          },
        },
        incarnation,
      ),
    );

    const live = await subject.live();

    should(live.panes).deepEqual([]);
    should(live.unproven.map(entry => entry.sessionId)).deepEqual(['s1']);
  });

  it('should report a directory it could not enumerate as incomplete rather than as no panes', async () => {
    const subject = new RunnerCgroupPaneLedger(
      {
        live: async () => {
          throw new Error('ferrets are unavailable');
        },
        paneOf: async () => undefined,
      },
      new TmuxPaneObserver(tmuxHolding({}), incarnation),
    );

    const live = await subject.live();

    should(live.panes).deepEqual([]);
    should(live.incomplete).match(/could not be read \(ferrets are unavailable\)/u);
  });
});
