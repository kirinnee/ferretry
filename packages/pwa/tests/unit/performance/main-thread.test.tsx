import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import {
  browserLongTaskObserver,
  type LongTaskObserverPort,
  observeLongTasks,
  useRenderTiming,
} from '../../../src/lib/performance/main-thread.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import { mount } from '../../support/dom.ts';

const handClock = () => {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

const realObserver = globalThis.PerformanceObserver;

afterEach(() => {
  globalThis.PerformanceObserver = realObserver;
});

describe('observeLongTasks', () => {
  it('should feed every long task into the recorder until it is stopped', () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    let deliver: ((entries: readonly { startTime: number; duration: number }[]) => void) | undefined;
    let stopped = false;
    const port: LongTaskObserverPort = {
      supported: true,
      observe: callback => {
        deliver = callback;
        return () => {
          stopped = true;
        };
      },
    };

    // Act
    const stop = observeLongTasks(recorder, port);
    deliver?.([
      { startTime: 0, duration: 70 },
      { startTime: 10, duration: 120 },
    ]);
    stop();
    clock.advance(60_000);

    // Assert
    should(stopped).be.true();
    should(recorder.report(60_000).longTasks).eql({ observed: true, count: 2, totalMs: 190, maxMs: 120 });
  });

  it('should leave a browser without long tasks unobserved', () => {
    // Arrange
    const recorder = new PerformanceRecorder(handClock());
    const port: LongTaskObserverPort = { supported: false, observe: () => () => undefined };

    // Act
    const stop = observeLongTasks(recorder, port);
    stop();

    // Assert
    should(recorder.report(60_000).longTasks.observed).be.false();
  });
});

describe('browserLongTaskObserver', () => {
  it('should observe the browser long-task entries and disconnect when asked', () => {
    // Arrange — a stand-in for the browser's observer that reports one long task.
    const calls: string[] = [];
    class FakeObserver {
      static readonly supportedEntryTypes = ['longtask'];
      readonly #callback: (list: { getEntries: () => unknown[] }) => void;
      constructor(callback: (list: { getEntries: () => unknown[] }) => void) {
        this.#callback = callback;
      }
      observe(options: { type: string; buffered: boolean }): void {
        calls.push(`observe ${options.type} ${String(options.buffered)}`);
        this.#callback({ getEntries: () => [{ startTime: 1, duration: 55 }] });
      }
      disconnect(): void {
        calls.push('disconnect');
      }
    }
    globalThis.PerformanceObserver = FakeObserver as unknown as typeof PerformanceObserver;
    const seen: number[] = [];

    // Act
    const port = browserLongTaskObserver();
    const stop = port.observe(entries => seen.push(...entries.map(entry => entry.duration)));
    stop();

    // Assert
    should(port.supported).be.true();
    should(seen).eql([55]);
    should(calls).eql(['observe longtask true', 'disconnect']);
  });

  it('should say a browser without the observer, or without long tasks, is unsupported', () => {
    // Arrange / Act
    globalThis.PerformanceObserver = undefined as unknown as typeof PerformanceObserver;
    const absent = browserLongTaskObserver().supported;
    globalThis.PerformanceObserver = { supportedEntryTypes: ['mark'] } as unknown as typeof PerformanceObserver;
    const without = browserLongTaskObserver().supported;

    // Assert
    should(absent).be.false();
    should(without).be.false();
  });
});

describe('useRenderTiming', () => {
  it('should record each render of a surface from render to commit, and nothing without a recorder', async () => {
    // Arrange — the clock moves 7 ms while the surface renders.
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const Timed = ({ value, record }: { value: number; record: PerformanceRecorder | undefined }) => {
      useRenderTiming(record, 'fleet');
      clock.advance(7);
      return <span>{value}</span>;
    };

    // Act
    const view = await mount(<Timed value={1} record={recorder} />);
    await view.render(<Timed value={2} record={recorder} />);
    await view.render(<Timed value={3} record={undefined} />);
    await view.unmount();

    // Assert
    should(recorder.report(3_600_000).renders).eql([{ surface: 'fleet', count: 2, p50Ms: 7, p95Ms: 7, maxMs: 7 }]);
  });
});
