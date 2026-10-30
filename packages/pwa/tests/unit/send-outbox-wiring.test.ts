import { describe, expect, test } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { MemoryOutboxBackend, SendOutbox } from '../../src/lib/send-outbox.ts';
import { outboxSender, watchOutbox } from '../../src/lib/send-outbox-wiring.ts';

const daemon = daemonConnection({ daemonId: 'up', baseUrl: 'https://up.example.test', deviceId: 'device' });
const attachment = {
  id: 'att_1',
  filename: 'hi.txt',
  mime: 'text/plain',
  size: 2,
  sha256: 'b'.repeat(64),
  createdAt: '2026-10-16T00:00:00.000Z',
};

describe('outboxSender', () => {
  test('sends through the typed client with the request id, and uploads a file to the session’s route', async () => {
    const sent: unknown[] = [];
    const urls: string[] = [];
    const sender = outboxSender(
      daemon,
      {
        send: async (...args: unknown[]) => {
          sent.push(args);
          return { disposition: 'queued' } as never;
        },
      },
      async input => {
        urls.push(String(input));
        return Response.json(attachment, { status: 201 });
      },
    );
    await sender.send('s1', { message: 'thank you' }, 'req-1');
    expect(sent).toEqual([['s1', { message: 'thank you' }, 'req-1']]);
    const id = await sender.upload('s1', { name: 'hi.txt', type: 'text/plain', blob: new Blob(['hi']) });
    expect(id).toBe('att_1');
    expect(urls).toEqual(['https://up.example.test/v1/sessions/s1/attachments']);
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
    await instance.submit({ daemonId: 'd1', sessionId: 's1', message: 'a' });
    await instance.submit({ daemonId: 'd1', sessionId: 's1', message: 'b' });
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
    await first.submit({ daemonId: 'd9', sessionId: 's', message: 'kept' });
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
    watchOutbox(second, { onRecovered: id => (seen.push(id), () => undefined), onOnline: () => () => undefined });
    expect(seen).toEqual(['d9']);
  });
});
