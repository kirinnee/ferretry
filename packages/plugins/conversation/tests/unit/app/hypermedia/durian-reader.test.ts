/**
 * r12 H11 — THE PAGE'S SIDE OF READING A MESSAGE (`durian-reader.ts`): the time budget that ends a slow parse by terminating
 * its worker, the cache that keeps a killed message from being parsed again, one worker and one parse at a time, and one ask
 * per streaming message. Every worker here is a fake the test drives, and every clock is a manual one: nothing waits, and
 * the only "slow parse" is a worker that never answers.
 */
import { describe, expect, it } from 'bun:test';
import {
  CACHE_WEIGHT,
  createDurianReader,
  FETCH_BUDGET_MS,
  idPrefixOf,
  PARSE_BUDGET_MS,
  type Reading,
  STARTUP_BUDGET_MS,
  STREAM_INTERVAL_MS,
  type Timers,
  type WorkerLike,
} from '../../../../app/hypermedia/durian-reader.ts';
import type { ReadRequest, WorkerMessage } from '../../../../app/hypermedia/durian-wire.ts';

/** A clock the test moves. */
class ManualClock implements Timers {
  now_ = 0;
  private next = 1;
  private readonly pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  readonly now = (): number => this.now_;
  readonly set = (run: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now_ + ms, run });
    return id;
  };
  readonly clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** Moves time on, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const until = this.now_ + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.now_ = due[1].at;
      due[1].run();
    }
    this.now_ = until;
  }
  get timers(): number {
    return this.pending.size;
  }
}

/** A worker the test drives: it records what it was asked and answers only when told to. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  terminated = false;
  readonly asked: ReadRequest[] = [];
  postMessage(message: unknown): void {
    this.asked.push(message as ReadRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(data: WorkerMessage | unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  ready(): void {
    this.say({ kind: 'ready' });
  }
  answer(id: number, doc: object = { blocks: [] }): void {
    this.say({ kind: 'read', id, doc, drawable: [['k', ['body']]] });
  }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** A reader over a fake clock, handing out the fake workers it starts. */
function rig(options: { cacheWeight?: number; failSpawn?: boolean } = {}) {
  const clock = new ManualClock();
  const workers: FakeWorker[] = [];
  let spawns = 0;
  const reader = createDurianReader({
    spawn: () => {
      spawns += 1;
      if (options.failSpawn === true) return Promise.reject(new Error('no worker'));
      const worker = new FakeWorker();
      workers.push(worker);
      return Promise.resolve(worker);
    },
    timers: clock,
    ...(options.cacheWeight === undefined ? {} : { cacheWeight: options.cacheWeight }),
  });
  const seen: Reading[] = [];
  let changes = 0;
  reader.subscribe(() => {
    changes += 1;
  });
  return {
    clock,
    workers,
    reader,
    seen,
    spawns: () => spawns,
    changes: () => changes,
    /** The newest worker, started and ready. */
    async up(): Promise<FakeWorker> {
      await settle();
      const worker = workers[workers.length - 1];
      if (worker === undefined) throw new Error('no worker was started');
      worker.ready();
      return worker;
    },
  };
}

describe('a message that reads in time', () => {
  it('is pending, then rich with the document the worker sent, its drawable bodies and its id prefix', async () => {
    const { reader, up, changes } = rig();
    const slot = reader.slot();
    expect(reader.snapshot(slot, 'hello', false)).toEqual({ kind: 'pending' });
    reader.want(slot, 'hello', false);
    const worker = await up();
    expect(worker.asked).toEqual([
      { kind: 'read', id: 1, source: 'hello', idPrefix: idPrefixOf('hello'), arriving: false },
    ]);
    worker.answer(1);
    const reading = reader.snapshot(slot, 'hello', false);
    expect(reading.kind).toBe('rich');
    if (reading.kind !== 'rich') return;
    expect(reading.read.doc as unknown).toEqual({ blocks: [] });
    expect([...reading.read.drawable]).toEqual([['k', ['body']]]);
    expect(reading.prefix).toBe(idPrefixOf('hello'));
    expect(changes()).toBe(1);
  });

  it('is the same object until something changes (a store snapshot must be stable)', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'hello', false);
    (await up()).answer(1);
    expect(reader.snapshot(slot, 'hello', false)).toBe(reader.snapshot(slot, 'hello', false));
  });

  it('is answered at once from the cache for another message of the same text (a remount does not blink)', async () => {
    const { reader, up, workers } = rig();
    const first = reader.slot();
    reader.want(first, 'hello', false);
    (await up()).answer(1);
    reader.release(first);
    const again = reader.slot();
    expect(reader.snapshot(again, 'hello', false).kind).toBe('rich');
    reader.want(again, 'hello', false);
    expect(workers[0]?.asked.length).toBe(1);
  });

  it('keeps a message that is finishing and one that is streaming apart, even for the same text', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'same', true);
    (await up()).answer(1);
    expect(reader.snapshot(slot, 'same', true).kind).toBe('rich');
    expect(reader.snapshot(reader.slot(), 'same', false)).toEqual({ kind: 'pending' });
  });
});

describe('a parse that is too slow', () => {
  it('is ended with terminate() once its budget is spent, and the message is plain text, never pending', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'slow one', false);
    const worker = await up();
    clock.advance(PARSE_BUDGET_MS - 1);
    expect(worker.terminated).toBe(false);
    expect(reader.snapshot(slot, 'slow one', false)).toEqual({ kind: 'pending' });
    clock.advance(1);
    expect(worker.terminated).toBe(true);
    expect(reader.snapshot(slot, 'slow one', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });

  it('is not parsed again when the message is opened again, or by another message of the same text', async () => {
    const { reader, up, clock, workers, spawns } = rig();
    const slot = reader.slot();
    reader.want(slot, 'slow one', false);
    await up();
    clock.advance(PARSE_BUDGET_MS);
    reader.release(slot);
    for (let open = 0; open < 3; open++) {
      const again = reader.slot();
      reader.want(again, 'slow one', false);
      expect(reader.snapshot(again, 'slow one', false)).toEqual({ kind: 'plain', reason: 'slow' });
    }
    await settle();
    expect(spawns()).toBe(1);
    expect(workers.length).toBe(1);
  });

  it('does not take the next message with it: a new worker is started for it, and it reads', async () => {
    const { reader, up, clock, workers } = rig();
    const slow = reader.slot();
    const fast = reader.slot();
    reader.want(slow, 'slow one', false);
    reader.want(fast, 'fast one', false);
    const first = await up();
    expect(first.asked.length).toBe(1);
    clock.advance(PARSE_BUDGET_MS);
    expect(first.terminated).toBe(true);
    const second = await up();
    expect(workers.length).toBe(2);
    expect(second.asked.map(ask => ask.source)).toEqual(['fast one']);
    second.answer(second.asked[0]?.id ?? 0);
    expect(reader.snapshot(fast, 'fast one', false).kind).toBe('rich');
    expect(reader.snapshot(slow, 'slow one', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });

  it('counts the budget from the ask, not from when the worker was started', async () => {
    const { reader, clock, workers } = rig();
    const slot = reader.slot();
    reader.want(slot, 'hello', false);
    await settle();
    clock.advance(STARTUP_BUDGET_MS - 1);
    expect(reader.snapshot(slot, 'hello', false)).toEqual({ kind: 'pending' });
    workers[0]?.ready();
    clock.advance(PARSE_BUDGET_MS - 1);
    expect(workers[0]?.terminated).toBe(false);
    clock.advance(1);
    expect(workers[0]?.terminated).toBe(true);
  });

  it('ends a parse that outlives the budget even when its answer is on the way: an answer after the kill is ignored', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'slow one', false);
    const worker = await up();
    clock.advance(PARSE_BUDGET_MS);
    worker.answer(1);
    expect(reader.snapshot(slot, 'slow one', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });
});

describe('a message whose parts and KaTeX the worker has to fetch', () => {
  it('stops the parse clock while the worker fetches, and counts again from what was left', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'a formula', false);
    const worker = await up();
    clock.advance(PARSE_BUDGET_MS - 100);
    worker.say({ kind: 'loading', id: 1 });
    // A cold phone's download is far longer than the parse budget, and is not the parse.
    clock.advance(PARSE_BUDGET_MS * 10);
    expect(worker.terminated).toBe(false);
    expect(reader.snapshot(slot, 'a formula', false)).toEqual({ kind: 'pending' });
    worker.say({ kind: 'working', id: 1 });
    clock.advance(99);
    expect(worker.terminated).toBe(false);
    clock.advance(1);
    expect(worker.terminated).toBe(true);
    expect(reader.snapshot(slot, 'a formula', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });

  it('adds up the parse time of every round: a message cannot buy more than one budget by asking for more code', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'many parts', false);
    const worker = await up();
    for (let round = 0; round < 4; round++) {
      clock.advance(PARSE_BUDGET_MS / 5);
      worker.say({ kind: 'loading', id: 1 });
      clock.advance(300);
      worker.say({ kind: 'working', id: 1 });
    }
    expect(worker.terminated).toBe(false);
    clock.advance(PARSE_BUDGET_MS / 5 - 1);
    expect(worker.terminated).toBe(false);
    clock.advance(1);
    expect(worker.terminated).toBe(true);
    expect(reader.snapshot(slot, 'many parts', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });

  it('gives the fetch its own budget and ends a worker that never finishes it', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'a formula', false);
    const worker = await up();
    worker.say({ kind: 'loading', id: 1 });
    clock.advance(FETCH_BUDGET_MS - 1);
    expect(worker.terminated).toBe(false);
    clock.advance(1);
    expect(worker.terminated).toBe(true);
    expect(reader.snapshot(slot, 'a formula', false)).toEqual({ kind: 'plain', reason: 'slow' });
  });

  it('reads the message once the worker answers after its fetch, and leaves no timer behind', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'a formula', false);
    const worker = await up();
    worker.say({ kind: 'loading', id: 1 });
    clock.advance(3_000);
    worker.say({ kind: 'working', id: 1 });
    worker.answer(1);
    expect(reader.snapshot(slot, 'a formula', false).kind).toBe('rich');
    expect(clock.timers).toBe(0);
  });

  it('ignores a loading or working note for another ask', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'a formula', false);
    const worker = await up();
    worker.say({ kind: 'loading', id: 99 });
    clock.advance(PARSE_BUDGET_MS);
    expect(worker.terminated).toBe(true);
  });
});

describe('with the real clock', () => {
  it('ends a worker that never answers after its budget, and keeps one that does', async () => {
    const workers: FakeWorker[] = [];
    const reader = createDurianReader({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return Promise.resolve(worker);
      },
      parseBudgetMs: 20,
      streamIntervalMs: 1,
    });
    const hung = reader.slot();
    reader.want(hung, 'hung', false);
    await settle();
    workers[0]?.ready();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(workers[0]?.terminated).toBe(true);
    expect(reader.snapshot(hung, 'hung', false)).toEqual({ kind: 'plain', reason: 'slow' });
    const fine = reader.slot();
    reader.want(fine, 'fine', true);
    await settle();
    workers[1]?.ready();
    workers[1]?.answer(workers[1]?.asked[0]?.id ?? 0);
    expect(reader.snapshot(fine, 'fine', true).kind).toBe('rich');
    reader.want(fine, 'fine and more', true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(workers[1]?.asked.length).toBe(2);
  });
});

describe('what the worker answers besides a document', () => {
  it('shows the message as text when the worker says to', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'big', false);
    (await up()).say({ kind: 'text', id: 1 });
    expect(reader.snapshot(slot, 'big', false)).toEqual({ kind: 'plain', reason: 'text' });
  });

  it('shows the message as text when the parse failed', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'bad', false);
    (await up()).say({ kind: 'failed', id: 1 });
    expect(reader.snapshot(slot, 'bad', false)).toEqual({ kind: 'plain', reason: 'failed' });
  });

  it('ignores an answer for another ask, and anything that is not a well-formed message', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'hello', false);
    const worker = await up();
    worker.answer(99);
    worker.say('hello');
    worker.say(null);
    worker.say({ kind: 'read', id: 1, doc: 'not a document', drawable: [] });
    worker.say({ kind: 'nope', id: 1 });
    expect(reader.snapshot(slot, 'hello', false)).toEqual({ kind: 'pending' });
    worker.answer(1);
    expect(reader.snapshot(slot, 'hello', false).kind).toBe('rich');
  });

  it('shows the message as text when the worker crashes while reading it, and starts a new one for the next', async () => {
    const { reader, up, workers } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    const worker = await up();
    worker.onerror?.({} as ErrorEvent);
    expect(worker.terminated).toBe(true);
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'failed' });
    const next = reader.slot();
    reader.want(next, 'two', false);
    await up();
    expect(workers.length).toBe(2);
  });

  it('treats a message that cannot be cloned like a crash', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    const worker = await up();
    worker.onmessageerror?.({} as MessageEvent);
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'failed' });
  });
});

describe('where there is no worker', () => {
  it('shows every waiting message as text when the worker cannot be started, and never as nothing', async () => {
    const { reader, spawns } = rig({ failSpawn: true });
    const slot = reader.slot();
    const other = reader.slot();
    reader.want(slot, 'one', false);
    reader.want(other, 'two', false);
    await settle();
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'unavailable' });
    expect(reader.snapshot(other, 'two', false)).toEqual({ kind: 'plain', reason: 'unavailable' });
    expect(spawns()).toBe(1);
  });

  it('gives up on a worker that never says it is ready, and ends it', async () => {
    const { reader, clock, workers } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    await settle();
    clock.advance(STARTUP_BUDGET_MS);
    expect(workers[0]?.terminated).toBe(true);
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'unavailable' });
  });

  it('ends a worker that arrives after it was given up on', async () => {
    let arrive: (worker: FakeWorker) => void = () => undefined;
    const clock = new ManualClock();
    const reader = createDurianReader({
      spawn: () => new Promise<WorkerLike>(resolve => (arrive = resolve)),
      timers: clock,
    });
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    clock.advance(STARTUP_BUDGET_MS);
    const late = new FakeWorker();
    arrive(late);
    await settle();
    expect(late.terminated).toBe(true);
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'unavailable' });
  });

  it('shows the waiting messages as text when a worker fails before it is ready, and tries again for the next new message', async () => {
    const { reader, workers, spawns } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    await settle();
    workers[0]?.onerror?.({} as ErrorEvent);
    expect(workers[0]?.terminated).toBe(true);
    expect(reader.snapshot(slot, 'one', false)).toEqual({ kind: 'plain', reason: 'unavailable' });
    const next = reader.slot();
    reader.want(next, 'two', false);
    await settle();
    expect(spawns()).toBe(2);
  });

  it('ignores a worker that was already replaced when its late event comes', async () => {
    const { reader, up, workers } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    const worker = await up();
    worker.answer(1);
    worker.onmessage = null;
    expect(workers.length).toBe(1);
    expect(reader.snapshot(slot, 'one', false).kind).toBe('rich');
  });
});

describe('a message too big to send', () => {
  it('is plain text at once and never reaches a worker', async () => {
    const { reader, spawns } = rig();
    const slot = reader.slot();
    const big = 'x'.repeat(300_001);
    expect(reader.snapshot(slot, big, false)).toEqual({ kind: 'plain', reason: 'capped' });
    reader.want(slot, big, false);
    await settle();
    expect(spawns()).toBe(0);
  });
});

describe('a message over a pre-parse limit (r12 H11a)', () => {
  it('is plain text at once, with its own reason, and no worker is started for it', async () => {
    const { reader, spawns } = rig();
    const slot = reader.slot();
    const over = '['.repeat(60);
    expect(reader.snapshot(slot, over, false)).toEqual({ kind: 'plain', reason: 'limit' });
    reader.want(slot, over, false);
    await settle();
    expect(spawns()).toBe(0);
    // Asked again, it is the same answer (kept), and a message under the limits is still asked of the worker.
    expect(reader.snapshot(slot, over, false)).toEqual({ kind: 'plain', reason: 'limit' });
    reader.want(reader.slot(), 'fine', false);
    await settle();
    expect(spawns()).toBe(1);
  });
});

describe('one parse at a time, one ask per message', () => {
  it('never has two asks in flight, and sends the waiting ones in order, each message once', async () => {
    const { reader, up } = rig();
    const slots = ['a', 'b', 'c'].map(source => ({ source, slot: reader.slot() }));
    for (const { source, slot } of slots) reader.want(slot, source, false);
    const worker = await up();
    expect(worker.asked.map(ask => ask.source)).toEqual(['a']);
    worker.answer(1);
    expect(worker.asked.map(ask => ask.source)).toEqual(['a', 'b']);
    worker.answer(2);
    worker.answer(3);
    expect(worker.asked.map(ask => ask.source)).toEqual(['a', 'b', 'c']);
  });

  it('asks once for two messages of the same text that are waiting together', async () => {
    const { reader, up } = rig();
    const one = reader.slot();
    const two = reader.slot();
    reader.want(one, 'same', false);
    reader.want(two, 'same', false);
    const worker = await up();
    worker.answer(1);
    expect(worker.asked.length).toBe(1);
    expect(reader.snapshot(two, 'same', false).kind).toBe('rich');
  });

  it('coalesces a streaming message: while one ask is in flight the latest text replaces the waiting one, and only it is sent', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'chunk 1', true);
    const worker = await up();
    expect(worker.asked.length).toBe(1);
    for (const chunk of ['chunk 2', 'chunk 3', 'chunk 4', 'chunk 5']) {
      clock.advance(10);
      reader.want(slot, chunk, true);
    }
    expect(worker.asked.length).toBe(1);
    worker.answer(1);
    clock.advance(STREAM_INTERVAL_MS);
    expect(worker.asked.map(ask => ask.source)).toEqual(['chunk 1', 'chunk 5']);
    worker.answer(2);
    expect(reader.snapshot(slot, 'chunk 5', true).kind).toBe('rich');
  });

  it('asks for a streaming message at most once per interval, and sends the latest text when the interval is over', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'chunk 1', true);
    const worker = await up();
    worker.answer(1);
    clock.advance(STREAM_INTERVAL_MS - 40);
    reader.want(slot, 'chunk 2', true);
    reader.want(slot, 'chunk 3', true);
    expect(worker.asked.length).toBe(1);
    clock.advance(39);
    expect(worker.asked.length).toBe(1);
    clock.advance(1);
    expect(worker.asked.map(ask => ask.source)).toEqual(['chunk 1', 'chunk 3']);
  });

  it('asks at once for a streaming message whose interval is already over', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'chunk 1', true);
    const worker = await up();
    worker.answer(1);
    clock.advance(STREAM_INTERVAL_MS);
    reader.want(slot, 'chunk 2', true);
    expect(worker.asked.map(ask => ask.source)).toEqual(['chunk 1', 'chunk 2']);
  });

  it('keeps the last document drawn while the next one is awaited, and never shows an older text as the cache hit of a newer one', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'chunk 1', true);
    const worker = await up();
    worker.answer(1);
    const before = reader.snapshot(slot, 'chunk 1', true);
    expect(before.kind).toBe('rich');
    expect(reader.snapshot(slot, 'chunk 1 and more', true)).toBe(before);
    reader.want(slot, 'chunk 1 and more', true);
    expect(reader.snapshot(slot, 'chunk 1 and more', true)).toBe(before);
  });

  it('does not ask for a streaming message whose text is cached, nor keep an older ask waiting for it', async () => {
    const { reader, up, clock } = rig();
    const slot = reader.slot();
    reader.want(slot, 'one', true);
    const worker = await up();
    worker.answer(1);
    clock.advance(STREAM_INTERVAL_MS);
    reader.want(slot, 'two', true);
    worker.answer(2);
    reader.want(slot, 'one', true);
    clock.advance(1000);
    expect(worker.asked.length).toBe(2);
  });

  it('drops what a message that left the screen was waiting for, and its delayed ask', async () => {
    const { reader, up, clock } = rig();
    const busy = reader.slot();
    const gone = reader.slot();
    reader.want(busy, 'busy', false);
    const worker = await up();
    reader.want(gone, 'gone', true);
    reader.release(gone);
    worker.answer(1);
    const streaming = reader.slot();
    reader.want(streaming, 'first', true);
    worker.answer(2);
    clock.advance(10);
    reader.want(streaming, 'second', true);
    reader.release(streaming);
    clock.advance(1000);
    expect(worker.asked.map(ask => ask.source)).toEqual(['busy', 'first']);
    expect(clock.timers).toBe(0);
  });

  it('still keeps the answer of a message that left the screen while it was being read', async () => {
    const { reader, up } = rig();
    const slot = reader.slot();
    reader.want(slot, 'hello', false);
    const worker = await up();
    reader.release(slot);
    worker.answer(1);
    expect(reader.snapshot(reader.slot(), 'hello', false).kind).toBe('rich');
  });
});

describe('the cache is bounded by weight', () => {
  it('forgets the least recently used outcome when it is over, and always keeps the newest', async () => {
    const { reader, up } = rig({ cacheWeight: 280 });
    const slot = reader.slot();
    const texts = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)];
    reader.want(slot, texts[0] ?? '', false);
    const worker = await up();
    worker.say({ kind: 'text', id: 1 });
    reader.want(slot, texts[1] ?? '', false);
    worker.say({ kind: 'text', id: 2 });
    // touch the first, so the second is the oldest
    expect(reader.snapshot(slot, texts[0] ?? '', false).kind).toBe('plain');
    reader.want(slot, texts[2] ?? '', false);
    worker.say({ kind: 'text', id: 3 });
    expect(reader.snapshot(slot, texts[2] ?? '', false).kind).toBe('plain');
    expect(reader.snapshot(slot, texts[0] ?? '', false).kind).toBe('plain');
    expect(reader.snapshot(slot, texts[1] ?? '', false).kind).toBe('pending');
  });

  it('weighs a read document more than a plain one: a heavy document is kept while it is the only outcome, and the first to go', async () => {
    const { reader, up } = rig({ cacheWeight: 1000 });
    const slot = reader.slot();
    const text = 'a'.repeat(60);
    reader.want(slot, text, false);
    const worker = await up();
    worker.answer(1);
    // 60 characters of source and its document weigh 1 + 60 * 25 = 1501, over this half of the cache (500) by itself.
    expect(reader.snapshot(slot, text, false).kind).toBe('rich');
    reader.want(slot, 'b'.repeat(60), false);
    worker.say({ kind: 'text', id: 2 });
    expect(reader.snapshot(slot, 'b'.repeat(60), false).kind).toBe('plain');
    expect(reader.snapshot(reader.slot(), text, false)).toEqual({ kind: 'pending' });
    expect(CACHE_WEIGHT).toBeGreaterThan(1000);
  });
});

describe('subscribing', () => {
  it('tells a listener of every outcome until it unsubscribes', async () => {
    const { reader, up } = rig();
    let told = 0;
    const off = reader.subscribe(() => {
      told += 1;
    });
    const slot = reader.slot();
    reader.want(slot, 'one', false);
    const worker = await up();
    worker.answer(1);
    expect(told).toBe(1);
    off();
    reader.want(slot, 'two', false);
    worker.answer(2);
    expect(told).toBe(1);
  });
});

describe('idPrefixOf', () => {
  it('is made of the text alone: the same for the same text, different for different text, and fit for an id', () => {
    expect(idPrefixOf('# Plan')).toBe(idPrefixOf('# Plan'));
    expect(idPrefixOf('# Plan')).not.toBe(idPrefixOf('# Plan!'));
    expect(idPrefixOf('')).toMatch(/^dh-[a-z0-9]+-$/u);
    expect(idPrefixOf('# Plan\n\ntext')).toMatch(/^dh-[a-z0-9]+-$/u);
  });
});
