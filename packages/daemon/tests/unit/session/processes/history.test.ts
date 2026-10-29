import { describe, it } from 'bun:test';
import should from 'should';
import {
  ENDED_PROCESS_LIMIT,
  ENDED_PROCESS_RETENTION_MS,
  PROCESS_HISTORY_SESSION_LIMIT,
  ProcessHistory,
} from '../../../../src/lib/session/processes/history.ts';
import { type ProcessEntry, processIdOf } from '../../../../src/lib/session/processes/model.ts';

/**
 * WHAT THE DAEMON REMEMBERS BETWEEN LOOKS — that a command which was there is gone, and its last CPU
 * reading — bounded per ferret and across ferrets.
 */

const T0 = 1_800_000_000_000;

function entry(
  pid: number,
  options: { readonly toolCommand?: boolean; readonly cpuSeconds?: number } = {},
): ProcessEntry {
  return {
    id: processIdOf(pid, pid * 10),
    row: {
      pid,
      ppid: 1,
      start: pid * 10,
      startedAtMs: T0 - 5_000,
      argv: `cmd ${pid}`,
      state: 'S',
      ...(options.cpuSeconds === undefined ? {} : { cpuSeconds: options.cpuSeconds }),
    },
    kind: 'command',
    state: 'sleeping',
    output: { source: 'file' },
    toolCommand: options.toolCommand ?? true,
    stoppable: true,
  };
}

describe('ProcessHistory.observe', () => {
  it('should report nothing ended on the first look', () => {
    // Arrange
    const history = new ProcessHistory();

    // Act
    const ended = history.observe('s1', [entry(10)], T0);

    // Assert
    should(ended).deepEqual([]);
  });

  it('should report a tool command that is missing from the next look as ended at that look', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10), entry(11)], T0);

    // Act
    const ended = history.observe('s1', [entry(11)], T0 + 3_000);

    // Assert
    should(ended.map(item => [item.entry.row.pid, item.endedAtMs])).deepEqual([[10, T0 + 3_000]]);
    should(history.ended('s1', entry(10).id)?.endedAtMs).equal(T0 + 3_000);
  });

  it('should detect ended only for top-level tool commands, never for a child, helper or server', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10), entry(11, { toolCommand: false })], T0);

    // Act
    const ended = history.observe('s1', [], T0 + 1_000);

    // Assert
    should(ended.map(item => item.entry.row.pid)).deepEqual([10]);
  });

  it('should keep an ended command in later looks, newest first', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10)], T0);
    history.observe('s1', [entry(11)], T0 + 1_000);

    // Act
    const ended = history.observe('s1', [], T0 + 2_000);

    // Assert
    should(ended.map(item => item.entry.row.pid)).deepEqual([11, 10]);
  });

  it('should forget an ended command after the retention window, and not before', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10)], T0);
    history.observe('s1', [], T0);

    // Act
    const justWithin = history.observe('s1', [], T0 + ENDED_PROCESS_RETENTION_MS);
    const past = history.observe('s1', [], T0 + ENDED_PROCESS_RETENTION_MS + 1);

    // Assert
    should(justWithin.map(item => item.entry.row.pid)).deepEqual([10]);
    should(past).deepEqual([]);
    should(history.ended('s1', entry(10).id)).be.undefined();
  });

  it('should keep only the newest ENDED_PROCESS_LIMIT ended commands of one ferret', () => {
    // Arrange
    const history = new ProcessHistory();
    const pids = Array.from({ length: ENDED_PROCESS_LIMIT + 5 }, (_, index) => 100 + index);
    history.observe(
      's1',
      pids.map(pid => entry(pid)),
      T0,
    );

    // Act
    const ended = history.observe('s1', [], T0 + 1_000);

    // Assert
    should(ended).have.length(ENDED_PROCESS_LIMIT);
  });

  it('should keep each ferret’s history apart', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10)], T0);
    history.observe('s2', [entry(20)], T0);

    // Act
    const first = history.observe('s1', [], T0 + 1_000);

    // Assert
    should(first.map(item => item.entry.row.pid)).deepEqual([10]);
    should(history.ended('s2', entry(20).id)).be.undefined();
    should(history.ended('s1', entry(20).id)).be.undefined();
  });

  it('should drop the least recently looked-at ferret once more than the session cap are held', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('first', [entry(10)], T0);
    history.observe('first', [], T0);
    for (let index = 0; index < PROCESS_HISTORY_SESSION_LIMIT; index++) history.observe(`s${index}`, [], T0);

    // Act / Assert — `first` was the oldest of PROCESS_HISTORY_SESSION_LIMIT + 1 and is gone; the rest remain.
    should(history.ended('first', entry(10).id)).be.undefined();
    history.observe('s0', [entry(30)], T0);
    history.observe('s0', [], T0 + 1);
    should(history.ended('s0', entry(30).id)).not.be.undefined();
  });

  it('should not evict a ferret that was looked at again, because the look moves it to the back', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('keeper', [entry(10)], T0);
    history.observe('s0', [entry(20)], T0);
    history.observe('s0', [], T0);
    for (let index = 1; index < PROCESS_HISTORY_SESSION_LIMIT - 1; index++) history.observe(`s${index}`, [], T0);
    history.observe('keeper', [], T0 + 1);

    // Act — one more ferret than the cap: the oldest look is `s0`, since `keeper` was looked at again.
    history.observe('newcomer', [], T0 + 2);

    // Assert
    should(history.ended('keeper', entry(10).id)).not.be.undefined();
    should(history.ended('s0', entry(20).id)).be.undefined();
  });
});

describe('ProcessHistory.sample', () => {
  it('should hold the CPU reading of the last look for each process that reported one', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10, { cpuSeconds: 4.5 }), entry(11)], T0);

    // Act / Assert
    should(history.sample('s1', entry(10).id)).deepEqual({ cpuSeconds: 4.5, atMs: T0 });
    should(history.sample('s1', entry(11).id)).be.undefined();
    should(history.sample('other', entry(10).id)).be.undefined();
  });

  it('should replace the reading on each look', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10, { cpuSeconds: 1 })], T0);

    // Act
    history.observe('s1', [entry(10, { cpuSeconds: 3 })], T0 + 2_000);

    // Assert
    should(history.sample('s1', entry(10).id)).deepEqual({ cpuSeconds: 3, atMs: T0 + 2_000 });
  });
});

describe('ProcessHistory.endAll', () => {
  it('should end every tool command the last look saw, for a ferret whose pane is gone', () => {
    // Arrange
    const history = new ProcessHistory();
    history.observe('s1', [entry(10), entry(11, { toolCommand: false })], T0);

    // Act
    const ended = history.endAll('s1', T0 + 4_000);

    // Assert
    should(ended.map(item => [item.entry.row.pid, item.endedAtMs])).deepEqual([[10, T0 + 4_000]]);
    should(history.sample('s1', entry(10).id)).be.undefined();
  });

  it('should be empty for a ferret never looked at', () => {
    // Arrange / Act / Assert
    should(new ProcessHistory().endAll('never', T0)).deepEqual([]);
  });
});
