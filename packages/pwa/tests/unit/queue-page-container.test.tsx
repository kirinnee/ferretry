import { afterEach, describe, expect, test } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueuePage } from '../../src/components/queue-page.tsx';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { MemoryOutboxBackend } from '../../src/lib/send-outbox.ts';
import { type AppStore, createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import '../support/dom.ts';
import { render, runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';

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
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'device' });
const view = (id: string, name: string, teammate?: string) => ({
  config: { id, name, ...(teammate ? { teammate } : {}) },
});

let mounted: ReactTestRenderer | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');

const open = async (queues: Readonly<Record<string, unknown>>, down: readonly string[] = []) => {
  const calls: string[] = [];
  const real = await createAppStore({
    repository: new Memory(),
    connectClient: async connection => {
      if (down.includes(connection.daemonId)) throw new Error('unreachable');
      return {
        request: async (path: string, _schema: unknown, init: RequestInit) => {
          calls.push(`${init.method ?? 'GET'} ${path}`);
          return queues[path] ?? { messages: [] };
        },
      } as unknown as FyApiClient;
    },
    fetcher: async () => Response.json({}),
    outboxBackend: new MemoryOutboxBackend(),
  });
  real.connections.add(alpha);
  real.connections.add(beta);
  const fleet = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  };
  const snapshot = {
    daemons: new Map([
      ['alpha', { sessions: [view('s1', 'one', 'Casen'), view('s2', 'two')] }],
      ['beta', { sessions: [view('s3', 'three', 'Mira')] }],
    ]),
  };
  const store = { ...real, fleet } as unknown as AppStore;
  return { store, real, calls };
};

const queued = (id: string, text: string) => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  state: 'queued',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  enqueuedAt: '2026-10-30T10:00:00.000Z',
});

describe('QueuePage', () => {
  test('All queues shows only ferrets with something waiting, across machines, including this device’s outbox', async () => {
    const { store, real } = await open({
      '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')] },
      '/v1/sessions/s3/queue': { messages: [] },
    });
    await real.outbox.submit({ daemonId: 'beta', sessionId: 's3', message: 'thank you' }, undefined);
    await real.outbox.submit({ daemonId: 'alpha', sessionId: 'gone', message: 'to a ferret not listed' });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => !JSON.stringify(mounted?.toJSON()).includes('Reading the queues'), 'queues read', runAsync);
    const page = JSON.stringify(mounted.toJSON());
    expect(page).toContain('All queues');
    expect(page).toContain('from the machine');
    expect(page).toContain('thank you');
    expect(page).toContain('to a ferret not listed');
    expect(page).toContain('Casen');
    expect(page).toContain('Mira');
    expect(page).not.toContain('"two"');
    expect(page).toContain('alpha');
  });

  test('one ferret’s queue is titled by the ferret, offers All queues, and edit and cancel reach the machine', async () => {
    const { store, calls } = await open({ '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')] } });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('from the machine'), 'queue shown', runAsync);
    expect(text(mounted.root.findByType('h1'))).toBe('Queue — Casen');
    const row = mounted.root.findByProps({ 'data-queue-row': 'q1' });
    const press = async (label: string) =>
      await runAsync(async () =>
        row.findAll(node => node.type === 'button' && text(node) === label)[0]?.props.onClick(),
      );
    await runAsync(async () =>
      row.findAll(node => node.type === 'button' && text(node) === 'Edit')[0]?.props.onClick(),
    );
    await runAsync(async () => row.findByType('textarea').props.onChange({ target: { value: 'better words' } }));
    await press('Save');
    expect(calls).toContain('PATCH /v1/sessions/s1/queue/q1');
    await press('Cancel message');
    expect(calls).toContain('DELETE /v1/sessions/s1/queue/q1');
    await runAsync(async () =>
      mounted?.root.findAll(node => node.type === 'button' && text(node) === 'All queues')[0]?.props.onClick(),
    );
  });

  test('a machine that cannot be reached shows only what this device holds for it, and a lone machine names no machine', async () => {
    const { store, real } = await open({}, ['alpha', 'beta']);
    await real.outbox.submit({ daemonId: 'alpha', sessionId: 's1', message: 'still here' });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => !JSON.stringify(mounted?.toJSON()).includes('Reading the queues'), 'queues read', runAsync);
    expect(JSON.stringify(mounted.toJSON())).toContain('still here');
  });
});
