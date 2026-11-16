import { describe, expect, test } from 'bun:test';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { MemoryOutboxBackend, SendOutbox } from '../../../../app/composer/send-outbox.ts';
import {
  createDaemonOutbox,
  daemonOutboxBackend,
  outboxSender,
  watchOutbox,
} from '../../../../app/composer/send-outbox-wiring.ts';

const daemon = daemonConnection('up');
const attachment = {
  id: 'att_1',
  filename: 'hi.txt',
  mime: 'text/plain',
  size: 2,
  sha256: 'b'.repeat(64),
  createdAt: '2026-10-16T00:00:00.000Z',
};

describe('outboxSender', () => {
  test('sends through the composer’s api with the request id, and uploads a file to the ferret’s route', async () => {
    const sent: unknown[] = [];
    const calls: unknown[] = [];
    const sender = outboxSender(
      daemon,
      {
        send: async (...args: unknown[]) => {
          sent.push(args);
          return { disposition: 'queued' } as never;
        },
      },
      {
        call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
          calls.push([route, (init as { readonly params?: unknown } | undefined)?.params]);
          return attachment as Answer;
        },
      },
    );
    await sender.send('s1', { message: 'thank you' }, 'req-1');
    expect(sent).toEqual([['s1', { message: 'thank you' }, 'req-1']]);
    const id = await sender.upload('s1', { name: 'hi.txt', type: 'text/plain', blob: new Blob(['hi']) });
    expect(id).toBe('att_1');
    expect(calls).toEqual([['POST /v1/ferrets/:ferretId/attachments', { ferretId: 's1' }]]);
  });
});

describe('watchOutbox', () => {
  const outbox = () => {
    let n = 0;
    const tried: string[] = [];
    const instance = new SendOutbox({
      backend: new MemoryOutboxBackend(),
      mintId: () => `m${++n}`,
      now: () => 1,
      resolve: async daemonId => {
        tried.push(daemonId);
        return null;
      },
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    return { instance, tried };
  };

  test('listens for recovery of each machine that has something waiting, once, and for the browser coming online', async () => {
    const { instance, tried } = outbox();
    const recovered = new Map<string, () => void>();
    const stopped: string[] = [];
    let online: () => void = () => undefined;
    let onlineStopped = false;
    const stop = watchOutbox(instance, {
      onRecovered: (daemonId, listener) => {
        recovered.set(daemonId, listener);
        return () => stopped.push(daemonId);
      },
      onOnline: listener => {
        online = listener;
        return () => {
          onlineStopped = true;
        };
      },
    });
    expect([...recovered.keys()]).toEqual([]);
    await instance.submit({ daemonId: 'd1', ferretId: 's1', message: 'a' });
    await instance.submit({ daemonId: 'd1', ferretId: 's1', message: 'b' });
    expect([...recovered.keys()]).toEqual(['d1']);

    tried.length = 0;
    recovered.get('d1')?.();
    await Promise.resolve();
    online();
    await Promise.resolve();
    expect(tried.length).toBeGreaterThan(0);

    stop();
    expect(stopped).toEqual(['d1']);
    expect(onlineStopped).toBe(true);
  });

  test('picks up what a reload left waiting', async () => {
    const backend = new MemoryOutboxBackend();
    const first = new SendOutbox({
      backend,
      mintId: () => 'm1',
      now: () => 1,
      resolve: async () => null,
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    await first.submit({ daemonId: 'd9', ferretId: 's', message: 'kept' });
    const second = new SendOutbox({
      backend,
      mintId: () => 'm2',
      now: () => 2,
      resolve: async () => null,
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    await second.load();
    const seen: string[] = [];
    watchOutbox(second, {
      onRecovered: id => {
        seen.push(id);
        return () => undefined;
      },
      onOnline: () => () => undefined,
    });
    expect(seen).toEqual(['d9']);
  });
});

describe('one outbox per daemon', () => {
  const quiet = { onRecovered: () => () => undefined, onOnline: () => () => undefined };

  test('reads and writes only its own daemon’s entries in a store every daemon shares', async () => {
    const shared = new MemoryOutboxBackend();
    const first = createDaemonOutbox({ daemonId: 'd1', backend: shared, environment: quiet, mintId: () => 'm1' });
    await first.outbox.submit({ daemonId: 'd1', ferretId: 's', message: 'for d1' });
    const second = createDaemonOutbox({ daemonId: 'd2', backend: shared, environment: quiet, mintId: () => 'm2' });
    await second.outbox.load();
    expect(second.outbox.snapshot()).toEqual([]);
    await expect(daemonOutboxBackend(shared, 'd2').put((await shared.all())[0] as never)).rejects.toThrow(
      'an outbox writes only its own daemon’s entries',
    );
    first.stop();
    second.stop();
  });

  test('waits for a composer’s sender, and sends what waited once one is offered', async () => {
    const sent: string[] = [];
    const daemonOutbox = createDaemonOutbox({
      daemonId: 'd1',
      backend: new MemoryOutboxBackend(),
      environment: quiet,
      mintId: () => 'm1',
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    const waiting = await daemonOutbox.outbox.submit({ daemonId: 'd1', ferretId: 's', message: 'later' });
    expect(waiting.outcome.kind).toBe('waiting');
    const withdraw = daemonOutbox.offer({
      send: async (_ferret, input) => {
        sent.push(input.message);
        return { disposition: 'queued' };
      },
      upload: async () => 'att',
    });
    await daemonOutbox.outbox.drain('d1', 's');
    expect(sent).toEqual(['later']);
    expect(daemonOutbox.outbox.snapshot()).toEqual([]);
    withdraw();
    daemonOutbox.stop();
  });
});
