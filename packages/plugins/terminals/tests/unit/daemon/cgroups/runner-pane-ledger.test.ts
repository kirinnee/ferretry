import { describe, it } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { RunnerCgroupPaneLedger, type RunnerPaneDirectory } from '../../../../daemon/adapters/cgroups/index.ts';
import type { RegisteredPaneObserver, RegisteredTerminalPane } from '../../../../daemon/lib/session/attach/index.ts';

/**
 * The live panes a limit change may reach, from the panes the tmux runner recorded: never multiplexer discovery,
 * never a bare pid, and nothing it cannot prove dropped silently.
 */

const pane = (pid: number): RegisteredTerminalPane => ({
  tmuxSession: `fy-${pid}`,
  paneId: `%${pid}`,
  pid,
  processStartTicks: 1_000,
});

/** The multiplexer agreeing that each recorded pane is still the incarnation it was. */
const agreeing: RegisteredPaneObserver = { observe: async registration => ({ ...registration }) };

const directory = (panes: Readonly<Record<string, RegisteredTerminalPane | undefined>>): RunnerPaneDirectory => ({
  live: async () => Object.keys(panes) as FerretId[],
  paneOf: async ferret => panes[ferret],
});

describe('the live panes a limit change may reach', () => {
  it('should offer every live ferret’s recorded pane, and skip a ferret with none', async () => {
    // Arrange
    const subject = new RunnerCgroupPaneLedger(directory({ s1: pane(100), s2: undefined }), agreeing);

    // Act
    const live = await subject.live();

    // Assert
    should(live).deepEqual({ panes: [{ sessionId: 's1', pid: 100 }], unproven: [] });
  });

  it('should refuse to offer a pid the multiplexer no longer proves is the SAME incarnation', async () => {
    // Arrange
    const recycled: RegisteredPaneObserver = {
      observe: async registration => ({ ...registration, processStartTicks: registration.processStartTicks + 1 }),
    };
    const subject = new RunnerCgroupPaneLedger(directory({ s1: pane(100) }), recycled);

    // Act
    const live = await subject.live();

    // Assert
    should(live.panes).deepEqual([]);
    should(live.unproven.map(entry => entry.sessionId)).deepEqual(['s1']);
    should(live.unproven[0]?.failure).match(/no longer the incarnation this daemon launched \(pid 100\)/u);
  });

  it('should treat a pane the multiplexer cannot show, or whose look threw, as unproven rather than gone', async () => {
    // Arrange
    const gone = new RunnerCgroupPaneLedger(directory({ s1: pane(100) }), { observe: async () => undefined });
    const threw = new RunnerCgroupPaneLedger(directory({ s1: pane(100) }), {
      observe: async () => {
        throw new Error('tmux is not answering');
      },
    });

    // Act
    const answers = [await gone.live(), await threw.live()];

    // Assert
    should(answers.map(live => [live.panes.length, live.unproven.length])).deepEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('should report a directory it could not enumerate as INCOMPLETE rather than as no panes', async () => {
    // Arrange
    const subject = new RunnerCgroupPaneLedger(
      {
        live: async () => {
          throw new Error('ferrets are unavailable');
        },
        paneOf: async () => undefined,
      },
      agreeing,
    );

    // Act
    const live = await subject.live();

    // Assert
    should(live.panes).deepEqual([]);
    should(live.incomplete).match(/could not be read \(ferrets are unavailable\)/u);
  });
});
