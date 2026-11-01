import { describe, expect, test } from 'bun:test';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import {
  MemoryOutboxBackend,
  type OutboxBackend,
  type OutboxEntry,
  type OutboxFile,
  type OutboxSender,
  SendOutbox,
  WAITING_REASON,
} from '../../src/lib/send-outbox.ts';

interface Call {
  readonly sessionId: string;
  readonly message: string;
  readonly attachmentIds?: string[];
  readonly now?: boolean;
  readonly requestId: string;
}

/** A machine that can be switched off, and a record of what reached it. */
const machine = (options: { up?: boolean; failWith?: () => unknown; uploadFailWith?: () => unknown } = {}) => {
  const state = { up: options.up ?? true, failWith: options.failWith, uploadFailWith: options.uploadFailWith };
  const received: Call[] = [];
  const uploaded: string[] = [];
  const seen = new Set<string>();
  const sender: OutboxSender = {
    send: async (sessionId, input, requestId) => {
      if (!state.up) throw new FyTransportError('no carrier', '/send', false, undefined);
      if (state.failWith !== undefined) throw state.failWith();
      // The daemon answers a repeat of a request id from its first record: it is not typed twice.
      if (!seen.has(requestId)) {
        seen.add(requestId);
        received.push({ sessionId, ...input, requestId });
      }
      return { disposition: 'queued' };
    },
    upload: async (_sessionId, file) => {
      if (!state.up) throw new FyTransportError('no carrier', '/send', false, undefined);
      if (state.uploadFailWith !== undefined) throw state.uploadFailWith();
      uploaded.push(file.name);
      return `att-${file.name}`;
    },
  };
  return { state, received, uploaded, sender };
};

const outboxOver = (
  backend: OutboxBackend,
  host: ReturnType<typeof machine>,
  extra: { reachable?: () => boolean; timers?: (() => void)[] } = {},
) => {
  let n = 0;
  let clock = Date.parse('2026-10-30T10:00:00.000Z');
  return new SendOutbox({
    backend,
    mintId: () => `m${++n}`,
    now: () => (clock += 1000),
    resolve: async () => (extra.reachable?.() === false ? null : host.sender),
    ...(extra.timers === undefined
      ? {}
      : { setTimer: (run: () => void) => extra.timers?.push(run), clearTimer: () => undefined }),
  });
};

const text = (name: string, body = 'hello'): OutboxFile => ({ name, type: 'text/plain', blob: new Blob([body]) });
const input = (message: string, sessionId = 's1') => ({ daemonId: 'd1', sessionId, message });

describe('SendOutbox', () => {
  test('a message sent while the machine is down is kept, then goes once on reconnect, in order', async () => {
    const host = machine({ up: false });
    const backend = new MemoryOutboxBackend();
    const outbox = outboxOver(backend, host);
    const first = await outbox.submit(input('thank you'));
    await outbox.submit(input('and one more'));
    expect(first.outcome).toEqual({ kind: 'waiting', reason: WAITING_REASON });
    expect(outbox.snapshot().map(entry => entry.message)).toEqual(['thank you', 'and one more']);
    // Only the first was tried: a message that cannot leave holds the ones behind it.
    expect(outbox.snapshot()[1]?.reason).toBeUndefined();
    expect((await backend.all()).length).toBe(2);

    host.state.up = true;
    await outbox.drainDaemon('d1');
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['thank you', 'and one more']);
    expect(outbox.snapshot()).toEqual([]);
    expect(await backend.all()).toEqual([]);
  });

  test('a second drain of the same session joins the first, and sessions do not hold each other', async () => {
    const host = machine();
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    host.state.up = false;
    await outbox.submit(input('a', 's1'));
    await outbox.submit(input('b', 's2'));
    host.state.up = true;
    const one = outbox.drain('d1', 's1');
    expect(outbox.drain('d1', 's1')).toBe(one);
    await Promise.all([one, outbox.drain('d1', 's2')]);
    expect(host.received.map(call => `${call.sessionId}:${call.message}`).sort()).toEqual(['s1:a', 's2:b']);
  });

  test('sending under an id twice types it once: the daemon answers the repeat from its first record', async () => {
    const host = machine();
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    host.state.up = false;
    const { entry } = await outbox.submit(input('once'));
    host.state.up = true;
    await host.sender.send('s1', { message: 'once' }, entry.id);
    await outbox.drainAll();
    expect(host.received).toHaveLength(1);
  });

  test('a reload with a non-empty outbox finds the messages and sends them', async () => {
    const backend = new MemoryOutboxBackend();
    const host = machine({ up: false });
    await (await Promise.resolve(outboxOver(backend, host))).submit(input('typed on the train'));

    const reloaded = outboxOver(backend, machine());
    expect(reloaded.snapshot()).toEqual([]);
    await reloaded.load();
    await reloaded.load();
    expect(reloaded.snapshot().map(entry => entry.message)).toEqual(['typed on the train']);
    const arrived = machine();
    const again = outboxOver(backend, arrived);
    await again.drainAll();
    expect(arrived.received.map(call => call.message)).toEqual(['typed on the train']);
    expect(await backend.all()).toEqual([]);
  });

  test('a backend that cannot be read is an empty outbox; one that cannot be written does not lose the entry on screen', async () => {
    const broken: OutboxBackend = {
      all: async () => {
        throw new Error('blocked');
      },
      put: async () => {
        throw new Error('quota');
      },
      delete: async () => {
        throw new Error('quota');
      },
    };
    const host = machine({ up: false });
    const outbox = outboxOver(broken, host);
    await outbox.load();
    await outbox.submit(input('kept in memory'));
    expect(outbox.snapshot()).toHaveLength(1);
    host.state.up = true;
    await outbox.drainAll();
    expect(outbox.snapshot()).toEqual([]);
    expect((await outbox.cancel('nope')).valueOf()).toBe('elsewhere');
  });

  test('edit and cancel work on a message still on this device, and say so when it has left', async () => {
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const a = await outbox.submit(input('thnak you'));
    const b = await outbox.submit(input('drop me'));
    expect(await outbox.edit(a.entry.id, 'thank you')).toBe('edited');
    expect(outbox.snapshot()[0]).toMatchObject({ message: 'thank you' });
    expect(outbox.snapshot()[0]?.reason).toBeUndefined();
    expect(await outbox.cancel(b.entry.id)).toBe('cancelled');
    expect(outbox.has(b.entry.id)).toBe(false);

    host.state.up = true;
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['thank you']);
    expect(await outbox.edit(a.entry.id, 'late')).toBe('elsewhere');
    expect(await outbox.cancel(a.entry.id)).toBe('elsewhere');
  });

  test('an edit waits for a send of that message that is already in flight', async () => {
    const host = machine();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const inFlight = new Promise<void>(resolve => {
      started = resolve;
    });
    const slow: OutboxSender = {
      ...host.sender,
      send: async (sessionId, body, requestId) => {
        started();
        await gate;
        return await host.sender.send(sessionId, body, requestId);
      },
    };
    const outbox = new SendOutbox({
      backend: new MemoryOutboxBackend(),
      mintId: () => 'm1',
      resolve: async () => slow,
    });
    const submitted = outbox.submit(input('hello'));
    await inFlight;
    const edited = outbox.edit('m1', 'changed');
    release();
    await submitted;
    expect(await edited).toBe('elsewhere');
    expect(host.received[0]?.message).toBe('hello');
  });

  test('the explicit now flag and uploaded attachment ids ride along', async () => {
    const host = machine();
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    await outbox.submit({ ...input('stop'), attachmentIds: ['a1'], now: true });
    expect(host.received[0]).toMatchObject({ message: 'stop', attachmentIds: ['a1'], now: true });
  });

  test('the composer’s own sender carries the first attempt; later drains use the machine’s', async () => {
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host, { reachable: () => false });
    const via: string[] = [];
    const first = await outbox.submit(input('with a prefix'), {
      send: async (_s, body, requestId) => {
        via.push(`${requestId}:${body.message}`);
        return 'composer';
      },
    });
    // No route to the machine, but the composer's client can still try this one entry.
    expect(first.outcome).toEqual({ kind: 'sent', result: 'composer' });
    expect(via).toEqual(['m1:with a prefix']);
    expect(outbox.snapshot()).toEqual([]);
  });

  test('a machine that answers "no" refuses the message: it stays, stops its session, and a cancel frees it', async () => {
    const host = machine({ failWith: () => new FyHttpError('the message is too long', 422, undefined) });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const first = await outbox.submit(input('too long'));
    expect(first.outcome).toMatchObject({ kind: 'refused' });
    await outbox.submit(input('behind it'));
    expect(outbox.snapshot()[0]).toMatchObject({ refused: true });
    host.state.failWith = undefined;
    await outbox.drainAll();
    expect(host.received).toEqual([]);
    expect(await outbox.cancel(first.entry.id)).toBe('cancelled');
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['behind it']);
  });

  test('an edit lifts a refusal so the message is tried again', async () => {
    const host = machine({ failWith: () => new FyHttpError('no', 400, undefined) });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const { entry } = await outbox.submit(input('bad'));
    host.state.failWith = undefined;
    expect(await outbox.edit(entry.id, 'good')).toBe('edited');
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['good']);
  });

  test('a busy or down machine (5xx, 408, 429) is waiting, not a refusal', async () => {
    for (const status of [500, 503, 408, 429]) {
      const host = machine({ failWith: () => new FyHttpError('later', status, undefined) });
      const outbox = outboxOver(new MemoryOutboxBackend(), host);
      expect((await outbox.submit(input('x'))).outcome).toEqual({ kind: 'waiting', reason: WAITING_REASON });
    }
    for (const words of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      const offline = machine({ failWith: () => new TypeError(words) });
      expect((await outboxOver(new MemoryOutboxBackend(), offline).submit(input('x'))).outcome.kind).toBe('waiting');
    }
    const plain = machine({ failWith: () => 'a string' });
    expect((await outboxOver(new MemoryOutboxBackend(), plain).submit(input('x'))).outcome).toMatchObject({
      kind: 'refused',
      reason: 'the machine refused it',
    });
  });

  test('a TypeError that is not a fetch failing is a bug: shown as a refusal, never retried as offline', async () => {
    const host = machine({ failWith: () => new TypeError("Cannot read properties of undefined (reading 'id')") });
    const timers: (() => void)[] = [];
    const outbox = outboxOver(new MemoryOutboxBackend(), host, { timers });
    const { outcome } = await outbox.submit(input('x'));
    expect(outcome).toMatchObject({ kind: 'refused', reason: "Cannot read properties of undefined (reading 'id')" });
    expect(outbox.snapshot()[0]).toMatchObject({ refused: true });
    // Nothing is scheduled to try it again: it waits for the person, not for a connection.
    expect(timers).toEqual([]);
  });

  test('the Agenda items a message is about go with it on every attempt, after a reload too', async () => {
    const host = machine({ up: false });
    const backend = new MemoryOutboxBackend();
    const first = outboxOver(backend, host);
    const { entry } = await first.submit({ ...input('yes, ship it'), references: ['A3'] });
    // The words stay as typed, so an edit shows only what the person wrote.
    expect(entry).toMatchObject({ message: 'yes, ship it', references: ['A3'] });
    first.stop();
    host.state.up = true;
    const reloaded = outboxOver(backend, host);
    await reloaded.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['!A3 yes, ship it']);
  });

  test('an edit keeps the item a message is about, and a message about none is sent as typed', async () => {
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const about = await outbox.submit({ ...input('ok'), references: ['A3', 'A9'] });
    await outbox.submit({ ...input('plain'), references: [] });
    expect(await outbox.edit(about.entry.id, 'ok, do it')).toBe('edited');
    expect(outbox.snapshot()[1]).not.toHaveProperty('references');
    host.state.up = true;
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['!A3 !A9 ok, do it', 'plain']);
  });

  test('attachments upload as part of the drain, before the send, and are not uploaded twice after a failure', async () => {
    const host = machine();
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    host.state.up = false;
    await outbox.submit({ ...input('see attached'), files: [text('a.txt'), text('b.txt')] });
    host.state.up = true;
    await outbox.drainAll();
    expect(host.uploaded).toEqual(['a.txt', 'b.txt']);
    expect(host.received[0]).toMatchObject({ message: 'see attached', attachmentIds: ['att-a.txt', 'att-b.txt'] });
  });

  test('a failed upload keeps the message with a plain reason and sends nothing', async () => {
    const host = machine({ uploadFailWith: () => new FyHttpError('the file is too large', 413, undefined) });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const { outcome } = await outbox.submit({ ...input('see attached'), files: [text('big.bin')] });
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'big.bin could not be uploaded: Files must be 20 MiB or smaller',
    });
    expect(outbox.snapshot()[0]).toMatchObject({
      refused: true,
      reason: 'big.bin could not be uploaded: Files must be 20 MiB or smaller',
    });
    expect(host.received).toEqual([]);
  });

  test('an upload cut off by the connection waits, and the files already up are not sent again', async () => {
    const host = machine();
    let calls = 0;
    const flaky: OutboxSender = {
      ...host.sender,
      upload: async (sessionId, file) => {
        calls += 1;
        if (calls === 2) throw new FyTransportError('dropped', '/send', false, undefined);
        return await host.sender.upload(sessionId, file);
      },
    };
    const outbox = new SendOutbox({
      backend: new MemoryOutboxBackend(),
      mintId: () => 'm1',
      resolve: async () => flaky,
    });
    const { outcome } = await outbox.submit({ ...input('two files'), files: [text('a.txt'), text('b.txt')] });
    expect(outcome).toEqual({ kind: 'waiting', reason: `${WAITING_REASON} — b.txt is not uploaded yet` });
    expect(outbox.snapshot()[0]).toMatchObject({ attachmentIds: ['att-a.txt'] });
    await outbox.drainAll();
    expect(host.uploaded).toEqual(['a.txt', 'b.txt']);
    expect(host.received[0]?.attachmentIds).toEqual(['att-a.txt', 'att-b.txt']);
  });

  test('files cannot be uploaded with no route to the machine, even for the composer’s own sender', async () => {
    const host = machine();
    const outbox = outboxOver(new MemoryOutboxBackend(), host, { reachable: () => false });
    const { outcome } = await outbox.submit(
      { ...input('x'), files: [text('a.txt')] },
      { send: async () => 'composer' },
    );
    expect(outcome.kind).toBe('waiting');
  });

  test('a resolver that throws is a machine that cannot be reached', async () => {
    const outbox = new SendOutbox({
      backend: new MemoryOutboxBackend(),
      mintId: () => 'm1',
      resolve: async () => {
        throw new Error('no client');
      },
    });
    expect((await outbox.submit(input('x'))).outcome.kind).toBe('waiting');
  });

  test('while anything waits it looks again later; a refused message alone does not', async () => {
    const timers: (() => void)[] = [];
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host, { timers });
    await outbox.submit(input('wait'));
    expect(timers).toHaveLength(1);
    host.state.up = true;
    timers[0]?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    await outbox.drainAll();
    expect(host.received.map(call => call.message)).toEqual(['wait']);
    outbox.stop();

    const refusing = machine({ failWith: () => new FyHttpError('no', 400, undefined) });
    const quiet: (() => void)[] = [];
    await outboxOver(new MemoryOutboxBackend(), refusing, { timers: quiet }).submit(input('no'));
    expect(quiet).toEqual([]);
  });

  test('entriesFor narrows to a machine and a ferret; subscribers hear every change', async () => {
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    let heard = 0;
    const stop = outbox.subscribe(() => {
      heard += 1;
    });
    await outbox.submit(input('a', 's1'));
    await outbox.submit({ daemonId: 'd2', sessionId: 's9', message: 'b' });
    expect(outbox.entriesFor('d1').map(entry => entry.message)).toEqual(['a']);
    expect(outbox.entriesFor('d2', 's9')).toHaveLength(1);
    expect(outbox.entriesFor('d2', 's1')).toEqual([]);
    expect(heard).toBeGreaterThan(1);
    stop();
    const before = heard;
    await outbox.submit(input('c'));
    expect(heard).toBe(before);
  });

  test('entries keep their order across a reload even when made in the same millisecond', async () => {
    const backend = new MemoryOutboxBackend();
    const stored: OutboxEntry[] = ['c', 'a', 'b'].map((message, index) => ({
      id: message,
      daemonId: 'd1',
      sessionId: 's1',
      message,
      attachmentIds: [],
      files: [],
      now: false,
      createdAt: '2026-10-30T10:00:00.000Z',
      seq: [3, 1, 2][index] as number,
    }));
    for (const entry of stored) await backend.put(entry);
    const outbox = outboxOver(backend, machine({ up: false }));
    await outbox.load();
    expect(outbox.snapshot().map(entry => entry.message)).toEqual(['a', 'b', 'c']);
    const next = await outbox.enqueue(input('d'));
    expect(next.seq).toBe(4);
    await backend.delete('zzz');
  });
});

describe('SendOutbox — whether a message reached this device (&F331 review)', () => {
  test('says the message is stored when storage took it, and not when storage refused', async () => {
    const host = machine({ up: false });
    const stored = await outboxOver(new MemoryOutboxBackend(), host).submit(input('kept'));
    const refusing = new MemoryOutboxBackend();
    refusing.put = async () => {
      throw new Error('quota');
    };
    const unstored = await outboxOver(refusing, host).submit(input('in memory only'));
    expect([stored.stored, stored.outcome.kind]).toEqual([true, 'waiting']);
    expect([unstored.stored, unstored.outcome.kind]).toEqual([false, 'waiting']);
  });

  test('sends what a message takes out of the shared draft with it, however much later it leaves', async () => {
    const host = machine({ up: false });
    const outbox = outboxOver(new MemoryOutboxBackend(), host);
    const sharedDraft = { generation: 'g', epoch: 0, base: 2, text: [-5] };
    await outbox.submit({ ...input('later'), sharedDraft });
    host.state.up = true;
    await outbox.drainAll();
    expect(host.received.at(-1)).toMatchObject({ message: 'later', sharedDraft });
  });
});
