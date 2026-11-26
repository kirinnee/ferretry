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
    let subscribed = 0;
    const recorder = new PerformanceRecorder();
    const stop = feedWorkToProbe(
      {
        observeWork: observer => {
          subscribed += 1;
          heard = observer;
          return () => {
            stopped += 1;
          };
        },
      },
      recorder,
    );
    return { recorder, stop, heard: () => heard as WorkObserver, stopped: () => stopped, subscribed: () => subscribed };
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

  it('should not subscribe to the kernel at all while no window is open', () => {
    // Arrange
    const subject = work();
    // Assert
    should(subject.subscribed()).equal(0);
  });

  it('should subscribe when the first window opens and stop hearing when the last one closes', () => {
    // Arrange
    const { recorder, subscribed, stopped } = work();
    // Act
    const first = recorder.open(0);
    const second = recorder.open(0);
    // Assert
    should(subscribed()).equal(1);
    recorder.close(first);
    should(stopped()).equal(0);
    recorder.close(second);
    should(stopped()).equal(1);
    recorder.open(0);
    should(subscribed()).equal(2);
  });

  it('should hear at once when a window is already open, and stop hearing when told', () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    recorder.open(0);
    let subscribed = 0;
    let stopped = 0;
    const stop = feedWorkToProbe(
      {
        observeWork: () => {
          subscribed += 1;
          return () => {
            stopped += 1;
          };
        },
      },
      recorder,
    );
    // Act
    stop();
    // Assert
    should(subscribed).equal(1);
    should(stopped).equal(1);
  });
});
