/**
 * THE BACKGROUND RETRY, WITH AN INJECTED CLOCK AND A SCRIPTED DIRECTORY.
 *
 * Nothing here waits in real time and nothing dials: the clock moves only when a case advances it,
 * and the directory answers exactly what the case scripted. The cases are the contract — transient
 * failures are asked again with growing, capped, jittered delays; an answer ends the asking; and
 * stopping the daemon means nothing fires afterwards, not even a read that was already in flight.
 */

import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { fixedClock } from '../../../../../core/kernel/testing/clock.ts';
import { RelayDirectoryRetry } from '../../../daemon/lib/relay/directory-retry.ts';
import type { RelayAdvertisement } from '../../../daemon/lib/relay/discovery.ts';

const transient = (retryAfterMs?: number): RelayAdvertisement => ({
  kind: 'undetermined',
  reason: 'this daemon could not reach the relay directory',
  retry: retryAfterMs === undefined ? {} : { retryAfterMs },
});
const available: RelayAdvertisement = { kind: 'available', relayUrl: 'https://hosted.example' };

/**
 * The driven clock gives a fired timer one microtask turn, and the retry's read-then-reschedule takes several, so a
 * timer scheduled by one would land after the clock had already moved on. The rig therefore keeps its own LOGICAL
 * now (the due time of the timer that last fired), schedules relative to it, and `drain` re-runs the clock until a
 * pass fires nothing new.
 */
function rig(script: Array<RelayAdvertisement | Promise<RelayAdvertisement>>, random = () => 1) {
  const clock = fixedClock();
  let logical = clock.nowMs();
  const reads: Array<{ readonly atMs: number; readonly signal: AbortSignal }> = [];
  const events: string[] = [];
  const waiting: RelayAdvertisement[] = [];
  const settled: RelayAdvertisement[] = [];
  let needed = true;
  const retry = new RelayDirectoryRetry(
    {
      read: async signal => {
        reads.push({ atMs: logical, signal });
        const next = script.shift();
        if (next === undefined) throw new Error('the script ran out');
        return await next;
      },
      after: (ms, fn) => {
        const due = logical + ms;
        return clock.after(milliseconds(Math.max(0, due - clock.nowMs())), () => {
          logical = due;
          fn();
        });
      },
      random,
      nowMs: () => logical,
      stillNeeded: () => needed,
    },
    {
      waiting: answer => {
        events.push('waiting');
        waiting.push(answer);
      },
      settled: answer => {
        events.push('settled');
        settled.push(answer);
      },
      abandoned: () => events.push('abandoned'),
    },
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const drain = async (ms: number) => {
    await clock.advance(ms);
    for (;;) {
      const before = reads.length + events.length;
      await flush();
      await clock.advance(0);
      await flush();
      if (reads.length + events.length === before) return;
    }
  };
  return {
    clock,
    drain,
    reads,
    events,
    waiting,
    settled,
    retry,
    startedAt: logical,
    noLongerNeeded: () => {
      needed = false;
    },
  };
}

describe('the directory retry', () => {
  test('should ask again after each transient failure with growing, capped delays', async () => {
    const r = rig([transient(), transient(), transient(), transient(), transient(), transient(), available]);
    r.retry.begin(transient());
    await r.drain(60 * 60_000);
    const gaps = r.reads.map((read, index) => read.atMs - (index === 0 ? r.startedAt : r.reads[index - 1]!.atMs));
    // random() === 1 → the top of each window: 2 s, 4 s, 8 s, 16 s, 32 s, 64 s, 128 s.
    expect(gaps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]);
    expect(r.settled).toEqual([available]);
  });

  test('should cap the delay at five minutes however long the outage runs', async () => {
    const script: RelayAdvertisement[] = Array.from({ length: 30 }, () => transient());
    const r = rig(script);
    r.retry.begin(transient());
    await r.drain(3 * 60 * 60_000);
    const gaps = r.reads.map((read, index) => read.atMs - (index === 0 ? r.startedAt : r.reads[index - 1]!.atMs));
    expect(Math.max(...gaps)).toBe(300_000);
    expect(gaps.at(-1)).toBe(300_000);
  });

  test('should jitter each delay into the upper half of its window', async () => {
    const lowest = rig([transient(), available], () => 0);
    lowest.retry.begin(transient());
    await lowest.drain(1_000);
    expect(lowest.reads).toHaveLength(1);
    const highest = rig([available], () => 1);
    highest.retry.begin(transient());
    await highest.drain(1_999);
    expect(highest.reads).toHaveLength(0);
    await highest.drain(1);
    expect(highest.reads).toHaveLength(1);
  });

  test('should honour a Retry-After longer than the backoff', async () => {
    const r = rig([available]);
    r.retry.begin(transient(20_000));
    await r.drain(19_999);
    expect(r.reads).toHaveLength(0);
    await r.drain(1);
    expect(r.reads).toHaveLength(1);
  });

  test('should say when the next try is while it waits', () => {
    const r = rig([available]);
    const annotated = r.retry.begin(transient());
    expect(annotated).toMatchObject({ kind: 'undetermined', retry: { nextAt: '09:00:02Z' } });
  });

  test('should report each further transient failure as waiting, with its own next try', async () => {
    const r = rig([transient(), available]);
    r.retry.begin(transient());
    await r.drain(2_000);
    expect(r.events).toEqual(['waiting']);
    expect(r.waiting[0]).toMatchObject({ retry: { nextAt: '09:00:06Z' } });
    await r.drain(4_000);
    expect(r.events).toEqual(['waiting', 'settled']);
  });

  test('should stop at the first definitive answer and never ask again', async () => {
    for (const answer of [
      { kind: 'disabled' },
      { kind: 'undetermined', reason: 'the relay directory answered a document this daemon cannot read' },
      available,
    ] as RelayAdvertisement[]) {
      const r = rig([answer]);
      r.retry.begin(transient());
      await r.drain(60 * 60_000);
      expect(r.reads).toHaveLength(1);
      expect(r.settled).toEqual([answer]);
      expect(r.clock.pending()).toBe(0);
    }
  });

  test('should treat a read that throws as transient', async () => {
    const r = rig([]);
    r.retry.begin(transient());
    await r.drain(2_000);
    expect(r.events).toEqual(['waiting']);
    expect(r.clock.pending()).toBe(1);
  });

  test('should stop mid-backoff: the pending timer is cancelled and nothing fires', async () => {
    const r = rig([available]);
    r.retry.begin(transient());
    expect(r.clock.pending()).toBe(1);
    r.retry.stop();
    expect(r.clock.pending()).toBe(0);
    await r.drain(60 * 60_000);
    expect(r.reads).toHaveLength(0);
    expect(r.events).toEqual([]);
  });

  test('should stop mid-read: the read is aborted and its answer is dropped', async () => {
    let resolve!: (answer: RelayAdvertisement) => void;
    const r = rig([new Promise<RelayAdvertisement>(r => (resolve = r))]);
    r.retry.begin(transient());
    await r.drain(2_000);
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]!.signal.aborted).toBe(false);
    r.retry.stop();
    expect(r.reads[0]!.signal.aborted).toBe(true);
    resolve(available);
    await Promise.resolve();
    await r.drain(60 * 60_000);
    expect(r.events).toEqual([]);
    expect(r.clock.pending()).toBe(0);
  });

  test('should not even read once nothing needs the directory any more', async () => {
    const r = rig([available]);
    r.retry.begin(transient());
    r.noLongerNeeded();
    await r.drain(60 * 60_000);
    expect(r.reads).toHaveLength(0);
    expect(r.events).toEqual(['abandoned']);
  });

  test('should drop an answer that arrives after an explicit relay was written', async () => {
    let resolve!: (answer: RelayAdvertisement) => void;
    const r = rig([new Promise<RelayAdvertisement>(r => (resolve = r))]);
    r.retry.begin(transient());
    await r.drain(2_000);
    r.noLongerNeeded();
    resolve(available);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.events).toEqual(['abandoned']);
    expect(r.settled).toEqual([]);
  });
});
