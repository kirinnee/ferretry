import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { MemoryOutboxBackend } from '../../src/lib/send-outbox.ts';
import { createAppStore } from '../../src/lib/store.tsx';

class Memory implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'device' });

const open = async (backend = new MemoryOutboxBackend(), sent: unknown[][] = []) => {
  const store = await createAppStore({
    repository: new Memory(),
    connectClient: async () =>
      ({ send: async (...args: unknown[]) => (sent.push(args), { disposition: 'queued' }) }) as unknown as FyApiClient,
    fetcher: async () => Response.json({}),
    outboxBackend: backend,
  });
  return store;
};

describe('the app store’s outbox', () => {
  it('a message saved with no way to the machine goes through the machine’s own client once the machine is paired', async () => {
    const sent: unknown[][] = [];
    const store = await open(undefined, sent);
    const first = await store.outbox.submit({ daemonId: 'alpha', sessionId: 's1', message: 'thank you' });
    expect(first.outcome.kind).toBe('waiting');
    store.connections.add(alpha);
    await store.outbox.drainDaemon('alpha');
    expect(sent.map(call => [call[0], call[1]])).toEqual([['s1', { message: 'thank you' }]]);
    expect(store.outbox.snapshot()).toEqual([]);
  });

  it('opens a store whose outbox backend is explicitly absent on a memory outbox', async () => {
    const store = await createAppStore({
      repository: new Memory(),
      connectClient: async () => ({}) as FyApiClient,
      fetcher: async () => Response.json({}),
      outboxBackend: null,
    });
    await store.outbox.submit({ daemonId: 'nobody', sessionId: 's', message: 'kept' });
    expect(store.outbox.snapshot()).toHaveLength(1);
  });

  it('reloads what a previous visit left waiting', async () => {
    const backend = new MemoryOutboxBackend();
    const before = await open(backend);
    await before.outbox.submit({ daemonId: 'nobody', sessionId: 's', message: 'kept' });
    const after = await open(backend);
    await Bun.sleep(5);
    expect(after.outbox.snapshot().map(entry => entry.message)).toEqual(['kept']);
  });
});
