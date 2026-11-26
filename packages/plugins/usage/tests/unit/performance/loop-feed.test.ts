import { describe, it } from 'bun:test';
import should from 'should';
import type { WorkObserver } from '@ferretry/kernel/contract';
import {
  feedLoopToProbe,
  feedWorkToProbe,
  STALL_RECORDED_MS,
  UNNAMED_PATH,
} from '../../../daemon/lib/performance/loop-feed.ts';
import { PerformanceRecorder } from '../../../daemon/lib/performance/recorder.ts';

type Observer = Parameters<Parameters<typeof feedLoopToProbe>[0]['observe']>[0];

const rig = () => {
  let heard: Observer | undefined;
  let stopped = 0;
  const recorder = new PerformanceRecorder();
  const stop = feedLoopToProbe(
    {
      observe: observer => {
        heard = observer;
        return () => {
          stopped += 1;
        };
      },
    },
    recorder,
  );
  return { recorder, stop, tick: (...args: Parameters<Observer>) => heard?.(...args), stopped: () => stopped };
};

describe('feedLoopToProbe', () => {
  it('should count every tick and record no stall for an idle loop', () => {
    // Arrange
    const { recorder, tick } = rig();
    const window = recorder.open(0);
    // Act
    for (let i = 0; i < 4; i += 1) tick(i === 0 ? 0 : STALL_RECORDED_MS - 1, 250 * i, () => ['never asked']);
    // Assert
    const { eventLoop } = window.tables(1_000);
    should(eventLoop.ticks).equal(4);
    should(eventLoop.blocksOver100Ms).equal(0);
    should(eventLoop.stalls).deepEqual([]);
  });

  it('should record a stall from the exact threshold with its labels, and start it where the late tick began', () => {
    // Arrange
    const { recorder, tick } = rig();
    const window = recorder.open(1_000);
    // Act
    tick(STALL_RECORDED_MS, 2_100, () => ['boot: build:usage', 'job']);
    // Assert
    const { eventLoop } = window.tables(1_000);
    should(eventLoop.blocksOver100Ms).equal(1);
    should(eventLoop.stalls).deepEqual([
      { atOffsetMs: 1_000, durationMs: STALL_RECORDED_MS, during: ['boot: build:usage', 'job'], stacks: [] },
    ]);
  });

  it('should do nothing, and never build the labels, while no window is open', () => {
    // Arrange
    const { tick } = rig();
    let asked = 0;
    // Act
    tick(5_000, 9_000, () => {
      asked += 1;
      return [];
    });
    // Assert
    should(asked).equal(0);
  });

  it('should stop hearing when stopped', () => {
    // Arrange
    const subject = rig();
    // Act
    subject.stop();
    // Assert
    should(subject.stopped()).equal(1);
  });
});

describe('feedWorkToProbe', () => {
  const work = () => {
    let heard: WorkObserver | undefined;
    let stopped = 0;
    const recorder = new PerformanceRecorder();
    const stop = feedWorkToProbe(
      {
        observeWork: observer => {
          heard = observer;
          return () => {
            stopped += 1;
          };
        },
      },
      recorder,
    );
    return { recorder, stop, heard: () => heard as WorkObserver, stopped: () => stopped };
  };

  it('should fold routes, children and file calls into the window by name and duration only', () => {
    // Arrange
    const { recorder, heard } = work();
    const window = recorder.open(0);
    // Act
    heard().route('GET /v1/ferrets/:ferretId', 12, 200, 340);
    heard().route('GET /v1/ferrets/:ferretId', 8, 500, 10);
    heard().childStarted('git');
    heard().childExited('git', 30);
    heard().file('readText', 2);
    // Assert
    const tables = window.tables(60_000);
    should(tables.routes.map(r => [r.route, r.count, r.errors])).deepEqual([['GET /v1/ferrets/:ferretId', 2, 1]]);
    should(tables.childProcesses.commands.map(c => [c.command, c.count, c.synchronous])).deepEqual([['git', 1, 0]]);
    should(tables.fileOperations.top.map(f => [f.operation, f.path, f.count])).deepEqual([
      ['readText', UNNAMED_PATH, 1],
    ]);
  });

  it('should record nothing with no window open, and stop hearing when told', () => {
    // Arrange
    const { recorder, heard, stop, stopped } = work();
    // Act
    heard().route('GET /x', 1, 200, 1);
    const window = recorder.open(0);
    stop();
    // Assert
    should(window.tables(1_000).routes).deepEqual([]);
    should(stopped()).equal(1);
  });
});
