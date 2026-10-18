import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionLiveActivity } from '@ferretry/protocol';
import '../support/dom.ts';
import {
  type CountUpOptions,
  type LiveCounterOptions,
  type LiveScheduler,
  useCountUp,
  useLiveActivity,
  useLiveElapsed,
} from '../../src/hooks/use-live-counter.ts';
import { createLiveActivityHub } from '../../src/lib/live-activity-feed.ts';
import { COUNT_UP_MS } from '../../src/lib/live-counter.ts';
import { render, run } from '../support/react.ts';

/**
 * A clock and timer nothing advances by itself: every tick is a decision the test makes, so the hooks
 * are exercised on exact instants and no suite sleeps on the wall.
 */
class FakeScheduler implements LiveScheduler {
  time: number;
  readonly pending: Array<{ readonly at: number; readonly action: () => void }> = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  after(ms: number, action: () => void): () => void {
    const entry = { at: this.time + ms, action };
    this.pending.push(entry);
    return () => {
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
    };
  }

  /** Delays still armed, relative to now, soonest first. */
  get delays(): number[] {
    return this.pending.map(entry => entry.at - this.time).sort((a, b) => a - b);
  }

  /** Moves the clock forward and runs every timer that falls due, in order, inside act. */
  advance(ms: number): void {
    const until = this.time + ms;
    run(() => {
      for (;;) {
        const due = this.pending.filter(entry => entry.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        this.pending.splice(this.pending.indexOf(due), 1);
        this.time = due.at;
        due.action();
      }
      this.time = until;
    });
  }
}

let shown: unknown;

function Elapsed({ start, options }: { readonly start: number | null; readonly options: LiveCounterOptions }) {
  shown = useLiveElapsed(start, options);
  return null;
}

function CountUp({ target, options }: { readonly target: number | null; readonly options: CountUpOptions }) {
  shown = useCountUp(target, options);
  return null;
}

afterEach(() => {
  shown = undefined;
});

describe('useLiveElapsed', () => {
  test('has no clock without a start, and arms nothing', () => {
    const scheduler = new FakeScheduler(5_000);
    const view = render(<Elapsed options={{ scheduler, hold: false }} start={null} />);
    expect(shown).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());
  });

  test('reads the seconds so far at once and ticks exactly on each whole second of the start', () => {
    const scheduler = new FakeScheduler(1_400);
    const view = render(<Elapsed options={{ scheduler, hold: false }} start={0} />);
    expect(shown).toBe(1);
    expect(scheduler.delays).toEqual([600]);

    scheduler.advance(599);
    expect(shown).toBe(1);
    scheduler.advance(1);
    expect(shown).toBe(2);
    expect(scheduler.delays).toEqual([1_000]);

    scheduler.advance(999);
    expect(shown).toBe(2);
    scheduler.advance(1);
    expect(shown).toBe(3);
    run(() => view.unmount());
    expect(scheduler.pending).toHaveLength(0);
  });

  test('a start in the future reads 0s and waits for it', () => {
    const scheduler = new FakeScheduler(0);
    const view = render(<Elapsed options={{ scheduler, hold: false }} start={400} />);
    expect(shown).toBe(0);
    expect(scheduler.delays).toEqual([400]);
    scheduler.advance(400);
    expect(shown).toBe(0);
    scheduler.advance(1_000);
    expect(shown).toBe(1);
    run(() => view.unmount());
  });

  test('a hold freezes the label and releasing it catches up to the present at once', () => {
    const scheduler = new FakeScheduler(0);
    const view = render(<Elapsed options={{ scheduler, hold: false }} start={0} />);
    scheduler.advance(2_000);
    expect(shown).toBe(2);

    run(() => view.update(<Elapsed options={{ scheduler, hold: true }} start={0} />));
    expect(scheduler.pending).toHaveLength(0);
    scheduler.advance(5_000);
    expect(shown).toBe(2);

    run(() => view.update(<Elapsed options={{ scheduler, hold: false }} start={0} />));
    expect(shown).toBe(7);
    expect(scheduler.delays).toEqual([1_000]);
    run(() => view.unmount());
  });

  test('a new start restarts the clock from the new turn', () => {
    const scheduler = new FakeScheduler(10_000);
    const view = render(<Elapsed options={{ scheduler, hold: false }} start={0} />);
    expect(shown).toBe(10);
    run(() => view.update(<Elapsed options={{ scheduler, hold: false }} start={9_000} />));
    expect(shown).toBe(1);
    expect(scheduler.delays).toEqual([1_000]);
    run(() => view.update(<Elapsed options={{ scheduler, hold: false }} start={null} />));
    expect(shown).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());
  });

  test('falls back to the transcript hold and the browser clock when none are injected', () => {
    const view = render(<Elapsed options={{}} start={Date.now() - 3_200} />);
    expect(shown).toBeGreaterThanOrEqual(3);
    run(() => view.unmount());
  });
});

describe('useCountUp', () => {
  test('shows its first reading at once and keeps null as null', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={null} />);
    expect(shown).toBeNull();
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={null} />));
    expect(shown).toBeNull();
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());

    const seeded = render(<CountUp options={{ scheduler, hold: false }} target={500} />);
    expect(shown).toBe(500);
    run(() => seeded.unmount());
  });

  test('counts up through values strictly between and lands on the target', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={1_000} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={2_000} />));
    expect(shown).toBe(1_000);

    scheduler.advance(32);
    const partial = shown as number;
    expect(partial).toBeGreaterThan(1_000);
    expect(partial).toBeLessThan(2_000);

    let previous = partial;
    for (let step = 0; step < COUNT_UP_MS / 16; step += 1) {
      scheduler.advance(16);
      expect(shown as number).toBeGreaterThanOrEqual(previous);
      previous = shown as number;
    }
    expect(shown).toBe(2_000);
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());
  });

  test('a reading that lands mid-count continues from the value on screen, never restarting lower', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={0} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={1_000} />));
    scheduler.advance(64);
    const mid = shown as number;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1_000);

    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={1_500} />));
    expect(shown).toBe(mid);
    scheduler.advance(16);
    expect(shown as number).toBeGreaterThanOrEqual(mid);
    scheduler.advance(COUNT_UP_MS);
    expect(shown).toBe(1_500);
    run(() => view.unmount());
  });

  test('a lower reading holds the shown value and arms nothing', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={900} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={400} />));
    expect(shown).toBe(900);
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());
  });

  test('a new reset key shows its first reading at once, even a lower one', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false, resetKey: 'turn-1' }} target={9_000} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false, resetKey: 'turn-2' }} target={300} />));
    expect(shown).toBe(300);
    expect(scheduler.pending).toHaveLength(0);
    run(() => view.unmount());
  });

  test('an unknown count becoming known shows it at once, and a known one going unknown goes back to unknown', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={null} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={700} />));
    expect(shown).toBe(700);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={null} />));
    expect(shown).toBeNull();
    run(() => view.unmount());
  });

  test('a hold freezes the count, and releasing it counts up to the target', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: true }} target={100} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: true }} target={800} />));
    scheduler.advance(1_000);
    expect(shown).toBe(100);
    expect(scheduler.pending).toHaveLength(0);

    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={800} />));
    scheduler.advance(COUNT_UP_MS);
    expect(shown).toBe(800);
    run(() => view.unmount());
  });

  test('leaving mid-count cancels the pending frame', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false }} target={0} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false }} target={5_000} />));
    expect(scheduler.pending).toHaveLength(1);
    run(() => view.unmount());
    expect(scheduler.pending).toHaveLength(0);
  });

  test('a longer duration takes proportionally longer', () => {
    const scheduler = new FakeScheduler();
    const view = render(<CountUp options={{ scheduler, hold: false, durationMs: 1_000 }} target={0} />);
    run(() => view.update(<CountUp options={{ scheduler, hold: false, durationMs: 1_000 }} target={100} />));
    scheduler.advance(COUNT_UP_MS);
    expect(shown as number).toBeLessThan(100);
    scheduler.advance(1_000);
    expect(shown).toBe(100);
    run(() => view.unmount());
  });

  test('uses the browser clock and the transcript hold when none are injected', () => {
    const view = render(<CountUp options={{}} target={10} />);
    run(() => view.update(<CountUp options={{}} target={20} />));
    expect(shown as number).toBeGreaterThanOrEqual(10);
    run(() => view.unmount());
  });
});

const sample = (outputTokens: number): SessionLiveActivity => ({
  sessionId: 's1',
  at: '2026-10-18T07:00:05.000Z',
  outputTokens,
});

function Live({ feed }: { readonly feed: ReturnType<typeof createLiveActivityHub> | undefined }) {
  shown = useLiveActivity(feed);
  return null;
}

describe('useLiveActivity', () => {
  test('is null with no feed or before the first sample, then follows the latest sample the hub published', () => {
    const none = render(<Live feed={undefined} />);
    expect(shown).toBeNull();
    run(() => none.unmount());

    const hub = createLiveActivityHub();
    const view = render(<Live feed={hub} />);
    expect(shown).toBeNull();
    run(() => hub.publish(sample(10)));
    expect(shown).toEqual(sample(10));
    run(() => hub.publish(sample(20)));
    expect(shown).toEqual(sample(20));
    run(() => view.unmount());
  });
});

describe('createLiveActivityHub', () => {
  test('keeps only the latest sample and tells every subscriber, until it unsubscribes', () => {
    const hub = createLiveActivityHub();
    expect(hub.current()).toBeNull();
    const heard: string[] = [];
    const stopA = hub.subscribe(() => heard.push(`a${hub.current()?.outputTokens}`));
    hub.subscribe(() => heard.push(`b${hub.current()?.outputTokens}`));

    hub.publish(sample(1));
    stopA();
    stopA();
    hub.publish(sample(2));

    expect(heard).toEqual(['a1', 'b1', 'b2']);
    expect(hub.current()).toEqual(sample(2));
  });

  test('a listener that unsubscribes another mid-publish does not skip the rest of the round', () => {
    const hub = createLiveActivityHub();
    const heard: string[] = [];
    let stopSecond: () => void = () => undefined;
    hub.subscribe(() => {
      heard.push('first');
      stopSecond();
    });
    stopSecond = hub.subscribe(() => heard.push('second'));
    hub.publish(sample(1));
    expect(heard).toEqual(['first', 'second']);
  });
});
