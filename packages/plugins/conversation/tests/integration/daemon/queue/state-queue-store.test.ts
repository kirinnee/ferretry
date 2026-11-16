import { describe, it } from 'bun:test';
import { state as kernelState } from '@ferretry/kernel/host';
import type { StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import { CONVERSATION_STATE, QUEUE_CARRY_STATE, QUEUE_STATE } from '../../../../contract/index.ts';
import { type RotationFailure, StateQueueStore } from '../../../../daemon/queue/adapters/index.ts';

import { foldQueue, type QueueEvent } from '@ferretry/core-mailbox/contract';
import { ROTATE_EVENTS } from '@ferretry/core-mailbox/contract';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import type { QueuedMessage } from '@ferretry/core-mailbox/contract';
import { LightState } from '../../../support/light-state.ts';
import { queueHistory } from '../../../support/queue-history.ts';

const HOME = '/home/fy';
const F1 = parseSessionId('f1');
const F2 = parseSessionId('f2');
const LIVE = `${HOME}/state/conversation/f1/queue.jsonl`;
const AT = '2026-11-01T08:00:00.000Z' as Instant;

function world(rotateEvents?: number) {
  const fs = kernelState.createMemoryHostFs();
  const port = kernelState.createStatePort({ home: HOME, pluginId: 'conversation', files: CONVERSATION_STATE, fs });
  return { fs, port, store: new StateQueueStore(port, rotateEvents) };
}

const liveLines = (fs: ReturnType<typeof world>['fs'], file = LIVE): string[] =>
  (fs.snapshot().get(file) ?? '').split('\n').filter(line => line !== '');
const shardFiles = (fs: ReturnType<typeof world>['fs']): string[] =>
  [...fs.snapshot().keys()].filter(path => path.includes('/queue-shards/')).sort();
const carryFiles = (fs: ReturnType<typeof world>['fs']): string[] =>
  [...fs.snapshot().keys()].filter(path => path.includes('/queue-carry/')).sort();

/** A state port that counts the calls a read makes, so "an unchanged log costs one lstat" is read off a counter. */
function counting(port: StatePort) {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(port, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[String(key)] = (calls[String(key)] ?? 0) + 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { port: proxy, calls };
}

const enqueued = (id: string): QueueEvent => ({
  v: 1,
  kind: 'enqueued',
  at: AT,
  message: {
    v: 1,
    id,
    sender: 'human',
    text: id,
    attachmentIds: [],
    enqueuedAt: AT,
    state: 'queued',
    stateAt: AT,
    revision: 1,
  },
});
const moved = (id: string, state: QueuedMessage['state']): QueueEvent => ({ v: 1, kind: 'moved', at: AT, id, state });

describe('a rotated queue log', () => {
  it('should keep the live file to ROTATE_EVENTS lines and a header over 200,000 events, and read as the plain fold does', async () => {
    // A light file: the in-memory file system copies a whole file per append, which 200,000 appends cannot afford.
    const files = new LightState();
    const port = files.port();
    const store = new StateQueueStore(port);
    const events = queueHistory(7, 200_000);

    for (const event of events) await store.append(F1, event);

    const live = files.logs.get('f1/queue.jsonl') ?? [];
    should(live.length).be.belowOrEqual(ROTATE_EVENTS + 1);
    const shards = [...files.documents.keys()].filter(key => key.startsWith('queue-shards/'));
    should(shards.length).be.aboveOrEqual(Math.floor(200_000 / ROTATE_EVENTS) - 1);
    // The shards hold the rest: everything the live file does not.
    const sealed = shards.reduce(
      (total, key) =>
        total + (JSON.parse(files.documents.get(key) as string) as { messages: unknown[] }).messages.length,
      0,
    );
    const header = JSON.parse(live[0] as string) as { carried: number; accepted: number };
    should(sealed + header.carried).be.above(0);
    should(header.accepted).be.above(0);
    const expected = foldQueue(events);
    should(await store.messages(F1)).eql(expected);
    // Another daemon run, cold: the same answer from the files alone.
    should(await new StateQueueStore(port).messages(F1)).eql(expected);
  }, 120_000);

  it('should give every message the version and the place in the list a log that never rotated gives it', async () => {
    for (const [seed, every] of [
      [1, 5],
      [2, 13],
      [3, 40],
    ] as const) {
      const { store } = world(every);
      const events = queueHistory(seed, 600);
      const applied: QueueEvent[] = [];
      for (const event of events) {
        await store.append(F1, event);
        applied.push(event);
        should(await store.messages(F1)).eql(foldQueue(applied));
      }
    }
  }, 60_000);

  it('should read a log written before rotation existed exactly as it always was, and rotate it when it gets long', async () => {
    const { fs, port, store } = world(6);
    const events = queueHistory(11, 5);
    for (const event of events) await port.append<unknown>(QUEUE_STATE, event, F1);

    should(await store.messages(F1)).eql(foldQueue(events));
    should(shardFiles(fs)).eql([]);

    const more = queueHistory(11, 40).slice(5);
    for (const event of more) await store.append(F1, event);
    should(await store.messages(F1)).eql(foldQueue([...events, ...more]));
    should(shardFiles(fs).length).be.above(0);
  });

  it('should carry what is open in a file with its exact state, and seal what is final', async () => {
    const { fs, store } = world(6);
    for (const event of [
      enqueued('a'),
      enqueued('b'),
      enqueued('c'),
      { v: 1, kind: 'moved', at: AT, id: 'a', state: 'typing', batch: 'a' } as QueueEvent,
      { v: 1, kind: 'waiting', at: AT, id: 'b', reason: 'draft' } as QueueEvent,
      moved('c', 'cancelled'),
    ])
      await store.append(F1, event);

    // The live file is the header alone; the open messages are in the carry file the header's base names.
    const lines = liveLines(fs).map(line => JSON.parse(line) as Record<string, unknown>);
    should(lines).eql([{ format: 1, v: 1, kind: 'segment', base: 6, accepted: 3, carried: 2 }]);
    should(carryFiles(fs)).eql([`${HOME}/state/conversation/queue-carry/f1~000000000006.json`]);
    const carry = JSON.parse(fs.snapshot().get(carryFiles(fs)[0] as string) as string) as {
      base: number;
      messages: Array<{ order: number; message: QueuedMessage }>;
    };
    should(carry.base).equal(6);
    should(
      carry.messages.map(entry => [entry.order, entry.message.id, entry.message.state, entry.message.version]),
    ).eql([
      [0, 'a', 'typing', 4],
      [1, 'b', 'queued', 5],
    ]);
    should(carry.messages[0]?.message.deliveredAs).equal('a');
    should(carry.messages[1]?.message.waitReason).equal('draft');
    const shard = JSON.parse(fs.snapshot().get(shardFiles(fs)[0] as string) as string) as {
      through: number;
      messages: Array<{ order: number; message: QueuedMessage }>;
    };
    should(shard.through).equal(6);
    should(
      shard.messages.map(entry => [entry.order, entry.message.id, entry.message.state, entry.message.version]),
    ).eql([[2, 'c', 'cancelled', 6]]);
    should((await store.messages(F1)).map(entry => [entry.id, entry.version])).eql([
      ['a', 4],
      ['b', 5],
      ['c', 6],
    ]);

    // The next event is at position 7 whichever segment it lands in.
    await store.append(F1, moved('a', 'delivered'));
    should((await store.messages(F1)).find(entry => entry.id === 'a')?.version).equal(7);
  });

  it('should treat a retried enqueue of a sealed message as the retry it is, not a new message', async () => {
    const { store } = world(4);
    for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b'), moved('b', 'cancelled')])
      await store.append(F1, event);
    await store.append(F1, enqueued('a'));

    should((await store.messages(F1)).map(entry => entry.id)).eql(['a', 'b']);
  });

  it('should keep one ferret’s shards out of another’s queue', async () => {
    const { store } = world(4);
    for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b'), moved('b', 'cancelled')])
      await store.append(F1, event);
    for (const event of [enqueued('x'), moved('x', 'cancelled'), enqueued('y'), moved('y', 'cancelled')])
      await store.append(F2, event);

    should((await new StateQueueStore(world(4).port).messages(F1)).length).equal(0);
    should((await store.messages(F1)).map(entry => entry.id)).eql(['a', 'b']);
    should((await store.messages(F2)).map(entry => entry.id)).eql(['x', 'y']);
  });

  it('should read an unchanged log with one lstat, and a sealed shard only once', async () => {
    const seeded = world(6);
    for (const event of queueHistory(5, 30)) await seeded.store.append(F1, event);
    const { port, calls } = counting(seeded.port);
    const store = new StateQueueStore(port, 6);

    await store.messages(F1);
    const shardsRead = calls.read;
    const linesRead = calls.lines;
    await store.messages(F1);
    await store.messages(F1);

    should(shardsRead).be.above(0);
    should(calls.read).equal(shardsRead);
    should(calls.lines).equal(linesRead);
    should(calls.version).equal(3);

    // A change by somebody else is seen at the next look, and the shards are not read again for it.
    await seeded.port.append<unknown>(QUEUE_STATE, moved('ghost', 'read'), F1);
    await store.messages(F1);
    should(calls.lines).equal((linesRead ?? 0) + 1);
    should(calls.read).equal(shardsRead);
  });

  it('should apply an event it appended itself without reading the file again', async () => {
    const seeded = world();
    const { port, calls } = counting(seeded.port);
    const store = new StateQueueStore(port);
    await store.append(F1, enqueued('a'));
    const linesRead = calls.lines;

    await store.append(F1, moved('a', 'typing'));
    const messages = await store.messages(F1);

    should(calls.lines).equal(linesRead);
    should(messages.map(entry => [entry.id, entry.state, entry.version])).eql([['a', 'typing', 2]]);
  });

  it('should read the file again when a read of its own rebuilt what it kept while an append was waiting', async () => {
    const seeded = world();
    let looks = 0;
    let arm = false;
    const racing = new Proxy(seeded.port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== 'version' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          looks += arm ? 1 : 0;
          // The append's own look at the version (the second one) is joined by a read that finds the file changed.
          if (looks === 2) await racer.messages(F1);
          return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });
    const racer = new StateQueueStore(racing);
    await racer.append(F1, enqueued('a'));
    arm = true;

    await racer.append(F1, moved('a', 'typing'));

    should(looks).be.aboveOrEqual(2);
    should((await racer.messages(F1)).map(entry => [entry.id, entry.state, entry.version])).eql([['a', 'typing', 2]]);
  });
});

describe('a crash in the middle of a rotation', () => {
  /** A port whose replacement of the live file fails once armed: the shard is written, the live file is not. */
  function crashing(port: StatePort) {
    const switches = { crash: false };
    const proxy = new Proxy(port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== 'write' || typeof value !== 'function') return value;
        return async (file: { name: string }, ...rest: unknown[]) => {
          if (switches.crash && file.name === QUEUE_STATE.name) throw new Error('the daemon went down');
          return await (value as (...args: unknown[]) => Promise<unknown>).call(target, file, ...rest);
        };
      },
    });
    return { port: proxy, switches };
  }

  it('should leave the old segment authoritative with the shard ignored, and let the next rotation succeed', async () => {
    const seeded = world(6);
    const { port, switches } = crashing(seeded.port);
    const store = new StateQueueStore(port, 6);
    const events = [
      enqueued('a'),
      enqueued('b'),
      moved('a', 'cancelled'),
      moved('b', 'typing'),
      enqueued('c'),
      moved('c', 'cancelled'),
    ];
    for (const event of events.slice(0, 5)) await store.append(F1, event);
    switches.crash = true;

    // The sixth event reaches the limit: the shard is written, the live file is not replaced, and the append still resolves.
    await store.append(F1, events[5] as QueueEvent);

    should(shardFiles(seeded.fs)).have.length(1);
    should(carryFiles(seeded.fs)).have.length(1);
    should(liveLines(seeded.fs)).have.length(6);
    should(await store.messages(F1)).eql(foldQueue(events));
    // The daemon restarts: only the files are left, and they read the same.
    switches.crash = false;
    const restarted = new StateQueueStore(seeded.port, 6);
    should(await restarted.messages(F1)).eql(foldQueue(events));

    // The next event rotates for real: the orphan shard goes, the new one holds what is final.
    const next = moved('b', 'delivered');
    await restarted.append(F1, next);

    should(await restarted.messages(F1)).eql(foldQueue([...events, next]));
    should(shardFiles(seeded.fs)).eql([`${HOME}/state/conversation/queue-shards/f1~000000000007.json`]);
    // The orphan carry file is gone too, and the live file is the header alone.
    should(carryFiles(seeded.fs)).eql([`${HOME}/state/conversation/queue-carry/f1~000000000007.json`]);
    should(liveLines(seeded.fs)).have.length(1);
    should(await new StateQueueStore(seeded.port, 6).messages(F1)).eql(foldQueue([...events, next]));
  });

  it('should not fail an append whose rotation failed, and try the rotation again at the next one', async () => {
    const seeded = world(3);
    const { port, switches } = crashing(seeded.port);
    const store = new StateQueueStore(port, 3);
    switches.crash = true;
    const events = [enqueued('a'), moved('a', 'cancelled'), enqueued('b')];

    for (const event of events) await store.append(F1, event);

    should(await store.messages(F1)).eql(foldQueue(events));
    switches.crash = false;
    await store.append(F1, moved('b', 'cancelled'));
    should(liveLines(seeded.fs)).have.length(1);
    should((await store.messages(F1)).map(entry => [entry.id, entry.state])).eql([
      ['a', 'cancelled'],
      ['b', 'cancelled'],
    ]);
  });
});

describe('reading the live file and the shards', () => {
  it('should take the header only from the first line that parses, and skip a stray one', async () => {
    const { port, store } = world();
    const header = { v: 1, kind: 'segment', base: 10, accepted: 1, carried: 0 };
    await port.append<unknown>(QUEUE_STATE, { nonsense: true }, F1);
    await port.append<unknown>(QUEUE_STATE, header, F1);
    await port.append<unknown>(QUEUE_STATE, enqueued('a'), F1);
    await port.append<unknown>(QUEUE_STATE, { ...header, base: 99 }, F1);
    await port.append<unknown>(QUEUE_STATE, moved('a', 'typing'), F1);

    should((await store.messages(F1)).map(entry => [entry.id, entry.state, entry.version])).eql([['a', 'typing', 12]]);
  });

  it('should start a segment of a header past zero from the carry file of its base', async () => {
    const { port, store } = world();
    const carried = {
      order: 4,
      message: {
        ...(enqueued('old') as Extract<QueueEvent, { kind: 'enqueued' }>).message,
        state: 'delivered',
        version: 77,
      },
    };
    await port.append<unknown>(QUEUE_STATE, { v: 1, kind: 'segment', base: 100, accepted: 5, carried: 1 }, F1);
    await port.write(QUEUE_CARRY_STATE, { format: 1, base: 100, messages: [carried] } as never, 'f1~000000000100');
    // A carry file of another base is not this segment's and changes nothing.
    await port.write(
      QUEUE_CARRY_STATE,
      { format: 1, base: 300, messages: [{ ...carried, order: 9 }] } as never,
      'f1~000000000300',
    );
    await port.append<unknown>(QUEUE_STATE, enqueued('new'), F1);

    should((await store.messages(F1)).map(entry => [entry.id, entry.state, entry.version])).eql([
      ['old', 'delivered', 77],
      ['new', 'queued', 101],
    ]);
  });

  it('should fail loudly, naming the file, when the carry file is missing, unreadable or holds another number', async () => {
    const { fs, port, store } = world();
    await port.append<unknown>(QUEUE_STATE, { v: 1, kind: 'segment', base: 100, accepted: 5, carried: 2 }, F1);

    await should(store.messages(F1)).be.rejectedWith(
      /carry file f1~000000000100 should hold 2 messages and holds none/,
    );

    const carried = {
      order: 4,
      message: { ...(enqueued('old') as Extract<QueueEvent, { kind: 'enqueued' }>).message, version: 77 },
    };
    await port.write(QUEUE_CARRY_STATE, { format: 1, base: 100, messages: [carried] } as never, 'f1~000000000100');
    await should(new StateQueueStore(port).messages(F1)).be.rejectedWith(/should hold 2 messages and holds 1/);

    fs.seed(carryFiles(fs)[0] as string, 'not json');
    await should(new StateQueueStore(port).messages(F1)).be.rejectedWith(/carry file f1~000000000100 is unreadable/);
  });

  it('should fail loudly, naming the shard, when a sealed shard cannot be read', async () => {
    const { fs, port, store } = world(4);
    for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b'), moved('b', 'cancelled')])
      await store.append(F1, event);
    fs.seed(shardFiles(fs)[0] as string, 'not json');

    await should(new StateQueueStore(port, 4).messages(F1)).be.rejectedWith(
      /queue shard f1~000000000004 is unreadable/,
    );
  });

  it('should skip a shard that disappears between listing and reading', async () => {
    const { port, store } = world(4);
    for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b'), moved('b', 'cancelled')])
      await store.append(F1, event);
    const listing = new Proxy(port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== 'list') return value;
        return async () => ['f1~000000000004', 'f1~000000000002'];
      },
    });

    should((await new StateQueueStore(listing, 4).messages(F1)).map(entry => entry.id)).eql(['b', 'a'].sort());
  });

  it('should ignore names in the shard folder that are not this ferret’s shards', async () => {
    const { port, store } = world(4);
    for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b'), moved('b', 'cancelled')])
      await store.append(F1, event);
    const noisy = new Proxy(port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== 'list') return value;
        return async (...args: unknown[]) => [
          ...((await (value as (...rest: unknown[]) => Promise<string[]>).apply(target, args)) as string[]),
          'f1~notes',
          'f10~000000000004',
        ];
      },
    });

    should((await new StateQueueStore(noisy, 4).messages(F1)).map(entry => entry.id)).eql(['a', 'b']);
  });
});

describe('a live file changed by somebody else', () => {
  const line = (event: QueueEvent): string => JSON.stringify({ format: 1, ...event });
  const text = (...events: QueueEvent[]): string => events.map(event => `${line(event)}\n`).join('');
  const states = async (store: StateQueueStore) => (await store.messages(F1)).map(entry => [entry.id, entry.state]);

  it('should read it again when it was replaced with as many bytes as before', async () => {
    const { fs, store } = world();
    fs.seed(LIVE, text(enqueued('aa'), enqueued('bb')));
    should(await states(store)).eql([
      ['aa', 'queued'],
      ['bb', 'queued'],
    ]);

    // Same length, other content, written the way the state port replaces a file: a new file in the old one's place.
    fs.seed(LIVE, text(enqueued('cc'), enqueued('dd')));

    should(await states(store)).eql([
      ['cc', 'queued'],
      ['dd', 'queued'],
    ]);
  });

  it('should read it again when it shrank, and when it was rewritten to a header and nothing else', async () => {
    const { fs, port, store } = world();
    fs.seed(LIVE, text(enqueued('a'), enqueued('b'), moved('a', 'typing')));
    should(await states(store)).eql([
      ['a', 'typing'],
      ['b', 'queued'],
    ]);

    fs.seed(LIVE, text(enqueued('a')));
    should(await states(store)).eql([['a', 'queued']]);

    await port.write(QUEUE_STATE, [{ v: 1, kind: 'segment', base: 50, accepted: 9, carried: 0 }] as never, F1);
    should(await states(store)).eql([]);
  });

  it('should never keep a torn final line, and read it once it is whole', async () => {
    const { fs, store } = world();
    const whole = line(enqueued('b'));
    fs.seed(LIVE, `${text(enqueued('a'))}${whole.slice(0, 20)}`);
    should(await states(store)).eql([['a', 'queued']]);

    fs.seed(LIVE, `${text(enqueued('a'))}${whole}\n`);
    should(await states(store)).eql([
      ['a', 'queued'],
      ['b', 'queued'],
    ]);
  });

  it('should still read a final line that is whole but has no newline', async () => {
    const { fs, store } = world();
    fs.seed(LIVE, `${text(enqueued('a'))}${line(enqueued('b'))}`);

    should(await states(store)).eql([
      ['a', 'queued'],
      ['b', 'queued'],
    ]);
  });

  it('should answer a log removed after it was read as empty, and one written again from scratch', async () => {
    const { fs, port, store } = world();
    await store.append(F1, enqueued('a'));
    should(await states(store)).eql([['a', 'queued']]);

    await port.remove(QUEUE_STATE, F1);
    should(await states(store)).eql([]);

    fs.seed(LIVE, text(enqueued('z')));
    should(await states(store)).eql([['z', 'queued']]);
  });

  it('should answer two reads made at once with the same messages', async () => {
    const { fs, store } = world();
    fs.seed(LIVE, text(enqueued('a'), moved('a', 'typing')));

    const [first, second] = await Promise.all([store.messages(F1), store.messages(F1)]);

    should(first).eql(second);
    should(first.map(entry => [entry.id, entry.state])).eql([['a', 'typing']]);
  });

  it('should keep every answer right when many ferrets are read, appended to and read again', async () => {
    const { store } = world(4);
    const ferrets = Array.from({ length: 20 }, (_, n) => parseSessionId(`g${n}`));
    for (const ferret of ferrets)
      for (const event of [enqueued('a'), moved('a', 'cancelled'), enqueued('b')]) await store.append(ferret, event);
    for (const ferret of ferrets) await store.append(ferret, moved('b', 'typing'));

    for (const ferret of ferrets)
      should((await store.messages(ferret)).map(entry => [entry.id, entry.state])).eql([
        ['a', 'cancelled'],
        ['b', 'typing'],
      ]);
  });
});

describe('messages too long for one record', () => {
  const big = (id: string, bytes: number): QueueEvent => {
    const event = enqueued(id) as Extract<QueueEvent, { kind: 'enqueued' }>;
    return { ...event, message: { ...event.message, text: 'x'.repeat(bytes) } };
  };
  const line = (event: QueueEvent): string => JSON.stringify({ format: 1, ...event });
  const waiting = (id: string, behind?: string): QueueEvent => ({
    v: 1,
    kind: 'waiting',
    at: AT,
    id,
    reason: 'draft',
    ...(behind === undefined ? {} : { behind }),
  });

  it('should rotate several 600 KB open messages, and keep the live file bounded', async () => {
    const { fs, port, store } = world(5);
    const events: QueueEvent[] = [big('a', 600_000), big('b', 600_000), big('c', 600_000), big('d', 600_000)];
    for (const event of events) await store.append(F1, event);
    // The fifth event reaches the limit: four messages of 600 KB are open, which no single record could hold.
    const more = moved('a', 'typing');
    events.push(more);
    await store.append(F1, more);

    should(liveLines(fs)).have.length(1);
    should(carryFiles(fs)).have.length(1);
    should(await store.messages(F1)).eql(foldQueue(events));
    should(await new StateQueueStore(port, 5).messages(F1)).eql(foldQueue(events));

    // And it goes on rotating, with the same versions a log that never rotated gives, and one carry file at a time.
    for (let n = 0; n < 12; n += 1) {
      const next = n % 2 === 0 ? moved('a', 'delivered') : moved('a', 'read');
      events.push(next);
      await store.append(F1, next);
    }
    should(liveLines(fs).length).be.belowOrEqual(5 + 1);
    should(carryFiles(fs)).have.length(1);
    should(await store.messages(F1)).eql(foldQueue(events));
  });

  it('should rotate a message accepted at the very edge of a record once it has a wait reason and a send it waits behind', async () => {
    const { fs, port, store } = world(4);
    // Written by a daemon with no limit of its own: the enqueue line is exactly 1,048,566 bytes, a record the file takes.
    const probe = line(big('a', 1));
    const edge = big('a', 1 + (1_048_566 - new TextEncoder().encode(probe).byteLength));
    should(new TextEncoder().encode(line(edge)).byteLength).equal(1_048_566);
    fs.seed(LIVE, `${line(edge)}\n`);
    const events: QueueEvent[] = [edge];
    const behind = 'send-'.padEnd(120, 'z');

    // Four consecutive rotations' worth: with the wait on it the carried message is over a record's cap.
    for (let n = 0; n < 11; n += 1) {
      const next = n % 2 === 0 ? waiting('a', behind) : ({ v: 1, kind: 'waiting', at: AT, id: 'a' } as QueueEvent);
      events.push(next);
      await store.append(F1, next);
      should(liveLines(fs).length).be.belowOrEqual(4 + 1);
    }

    should(carryFiles(fs)).have.length(1);
    should(liveLines(fs)).have.length(1 + 0);
    should(await store.messages(F1)).eql(foldQueue(events));
    should(await new StateQueueStore(port, 4).messages(F1)).eql(foldQueue(events));
  });
});

describe('a rotation that cannot be written', () => {
  /** A port whose writes of the live file fail, and whose version can be taken down. */
  function failing(port: StatePort) {
    const switches = { writes: false, breakVersion: true, version: false, removes: false };
    const proxy = new Proxy(port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'write')
          return async (file: { name: string }, ...rest: unknown[]) => {
            if (switches.writes && file.name === QUEUE_STATE.name) {
              switches.version = switches.breakVersion;
              throw new Error('the disk is full');
            }
            return await (value as (...args: unknown[]) => Promise<unknown>).call(target, file, ...rest);
          };
        if (key === 'remove')
          return async (...args: unknown[]) => {
            if (switches.removes) throw new Error('the file is held');
            return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
          };
        if (key === 'version')
          return async (...args: unknown[]) => {
            if (switches.version) throw new Error('lstat failed');
            return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
          };
        return value.bind(target);
      },
    });
    return { port: proxy, switches };
  }

  it('should stand even when the last segment’s carry file could not be removed, and say nothing about it', async () => {
    const seeded = world();
    const { port, switches } = failing(seeded.port);
    const told: RotationFailure[] = [];
    const store = new StateQueueStore(port, 2, failure => told.push(failure));
    switches.removes = true;
    const events = [enqueued('a'), enqueued('b'), moved('a', 'typing'), moved('b', 'typing')];

    for (const event of events) await store.append(F1, event);

    // Two rotations stood; the first one's carry file is still there, and is not the live segment's.
    should(told).eql([]);
    should(carryFiles(seeded.fs)).have.length(2);
    should(await store.messages(F1)).eql(foldQueue(events));
    should(await new StateQueueStore(seeded.port, 2).messages(F1)).eql(foldQueue(events));
    switches.removes = false;
    await store.append(F1, moved('a', 'delivered'));
    await store.append(F1, moved('b', 'delivered'));
    should(carryFiles(seeded.fs)).have.length(1);
  });

  it('should be said once with the ferret, the events and the size, however many appends fail after it, and again after a success', async () => {
    const seeded = world();
    const { port, switches } = failing(seeded.port);
    const told: Array<{ ferret: string; events: number; bytes: number | undefined; error: string }> = [];
    const store = new StateQueueStore(port, 3, failure =>
      told.push({ ferret: failure.ferret, events: failure.events, bytes: failure.bytes, error: String(failure.error) }),
    );
    for (const event of [enqueued('a'), moved('a', 'cancelled')]) await store.append(F1, event);
    switches.writes = true;

    // The third event reaches the limit and the disk refuses; so does every append after it. One report, with no size
    // (the disk that refused the write cannot be measured either).
    await store.append(F1, enqueued('b'));
    switches.version = false;
    switches.breakVersion = false;
    await store.append(F1, moved('b', 'cancelled'));
    await store.append(F1, enqueued('c'));
    should(told).eql([{ ferret: 'f1', events: 3, bytes: undefined, error: 'Error: the disk is full' }]);

    // The disk comes back: the next append rotates, and the log is short again.
    switches.writes = false;
    await store.append(F1, moved('c', 'typing'));
    should(liveLines(seeded.fs)).have.length(1);

    // It goes down again, and that is a new failure to say, this time with the size of the file that keeps growing.
    switches.writes = true;
    for (const event of [enqueued('d'), moved('d', 'typing'), moved('d', 'delivered')]) await store.append(F1, event);
    should(told).have.length(2);
    should(told[1]?.events).equal(3);
    should(told[1]?.bytes).be.above(0);
  });
});
