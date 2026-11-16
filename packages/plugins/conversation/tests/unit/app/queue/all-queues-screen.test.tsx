import { afterEach, describe, expect, test } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { ensureDom, RouterProvider, render, runAsync, settleUntil } from '@ferretry/app/testing';
import { ferretSummary } from '@ferretry/core-ferrets/contract/testing';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MemoryOutboxBackend } from '../../../../app/composer/send-outbox.ts';
import {
  createDaemonOutbox,
  type DaemonOutbox,
  SendOutboxProvider,
} from '../../../../app/composer/send-outbox-wiring.ts';
import { AllQueuesScreen } from '../../../../app/queue/all-queues-screen.tsx';
import { type FakeClient, fakeClient } from '../../../support/app/fake-client.ts';
import { withClient } from '../../../support/app/client.tsx';

ensureDom();

const LIST = 'GET /v1/ferrets';
const QUEUE = 'GET /v1/ferrets/:ferretId/queue';
const EDIT = 'PATCH /v1/ferrets/:ferretId/queue/:messageId';
const CANCEL = 'DELETE /v1/ferrets/:ferretId/queue/:messageId';

let mounted: ReactTestRenderer | undefined;
let outboxes: DaemonOutbox[] = [];
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  for (const each of outboxes) each.stop();
  outboxes = [];
});

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');
const page = (): string => JSON.stringify(mounted?.toJSON());

const queued = (id: string, words: string, minute = 0) => ({
  v: 1,
  id,
  sender: 'human',
  text: words,
  attachmentIds: [],
  state: 'queued',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  enqueuedAt: `2026-10-30T10:0${String(minute)}:00.000Z`,
});

const ferrets = [
  ferretSummary({ id: 'f1', name: 'Casen' }),
  ferretSummary({ id: 'f2', name: 'Mira' }),
  ferretSummary({ id: 'f3', name: 'Idle' }),
];

/** The daemon: three ferrets, two with queued messages; a queue that answers with a refusal is `broken`. */
const daemon = (queues: Record<string, unknown>, broken: readonly string[] = []): FakeClient =>
  fakeClient(
    {
      [LIST]: () => ferrets,
      [QUEUE]: call => {
        const id = call.params.ferretId ?? '';
        if (broken.includes(id)) throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
        return queues[id] ?? { messages: [] };
      },
      [EDIT]: () => ({}),
      [CANCEL]: () => ({}),
    },
    'd1',
  );

const deviceOutbox = (): DaemonOutbox => {
  const made = createDaemonOutbox({
    daemonId: 'd1',
    backend: new MemoryOutboxBackend(),
    environment: { onRecovered: () => () => undefined, onOnline: () => () => undefined },
  });
  outboxes.push(made);
  return made;
};

const unreachable = {
  send: async () => {
    throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
  },
  upload: async () => {
    throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
  },
};

const open = (client: FakeClient, outbox: DaemonOutbox = deviceOutbox()): void => {
  mounted = render(
    <RouterProvider>
      <SendOutboxProvider daemonId="d1" outbox={outbox} sender={unreachable}>
        {withClient(client, <AllQueuesScreen />)}
      </SendOutboxProvider>
    </RouterProvider>,
  );
};

const read = async (): Promise<void> =>
  await settleUntil(() => !page().includes('Reading the queues'), 'queues read', runAsync);

const rowIds = (): string[] =>
  (
    mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ?? []
  ).map(node => String(node.props['data-queue-row']));

const press = async (row: string, label: string): Promise<void> =>
  await runAsync(async () =>
    mounted?.root
      .findByProps({ 'data-queue-row': row })
      .findAll(node => node.type === 'button' && text(node) === label)[0]
      ?.props.onClick(),
  );

describe('AllQueuesScreen', () => {
  test('lists every ferret that has something waiting, by one list read and one queue read each', async () => {
    const client = daemon({
      f1: { messages: [queued('q1', 'for casen')] },
      f2: { messages: [queued('q2', 'for mira', 1)] },
    });
    open(client);
    await read();
    expect(text(mounted!.root.findByType('h1'))).toBe('All queues');
    expect(page()).toContain('for casen');
    expect(page()).toContain('for mira');
    expect(page()).toContain('Casen');
    expect(page()).toContain('Mira');
    // The ferret with an empty queue has no card.
    expect(page()).not.toContain('Idle');
    expect(client.callsTo(LIST)).toHaveLength(1);
    expect(client.callsTo(QUEUE).map(call => call.params.ferretId)).toEqual(['f1', 'f2', 'f3']);
    expect(mounted!.root.findAllByProps({ 'data-queue-group': 'd1/f1' })).not.toHaveLength(0);
    expect(mounted!.root.findAllByProps({ 'data-queue-group': 'd1/f2' })).not.toHaveLength(0);
  });

  test('says so when nothing is waiting anywhere', async () => {
    open(daemon({}));
    await read();
    expect(page()).toContain('Nothing is waiting');
    expect(mounted!.root.findAllByProps({ 'data-queue-empty': '' })).toHaveLength(1);
    expect(rowIds()).toEqual([]);
  });

  test('a ferret’s name opens that ferret', async () => {
    open(daemon({ f2: { messages: [queued('q2', 'for mira')] } }));
    await read();
    await runAsync(async () =>
      mounted?.root.findAll(node => node.type === 'button' && text(node) === 'Mira')[0]?.props.onClick(),
    );
    expect(window.location.pathname).toBe('/d1/conversation/chat');
    expect(new URLSearchParams(window.location.search).get('ferret')).toBe('f2');
  });

  test('edit and cancel on a row reach that row’s own ferret', async () => {
    const client = daemon({
      f1: { messages: [queued('q1', 'for casen')] },
      f2: { messages: [queued('q2', 'for mira', 1)] },
    });
    open(client);
    await read();
    await press('q2', 'Edit');
    await runAsync(async () =>
      mounted!.root
        .findByProps({ 'data-queue-row': 'q2' })
        .findByType('textarea')
        .props.onChange({ target: { value: 'better words' } }),
    );
    await press('q2', 'Save');
    expect(client.callsTo(EDIT).map(call => [call.params.ferretId, call.params.messageId])).toEqual([['f2', 'q2']]);
    await press('q1', 'Cancel message');
    expect(client.callsTo(CANCEL).map(call => [call.params.ferretId, call.params.messageId])).toEqual([['f1', 'q1']]);
  });

  test('a queue that cannot be read keeps what was last read, and this device’s own saved messages still show', async () => {
    const outbox = deviceOutbox();
    await outbox.outbox.submit({ daemonId: 'd1', ferretId: 'gone', message: 'to a ferret not listed' });
    open(daemon({ f1: { messages: [queued('q1', 'for casen')] } }, ['f1']), outbox);
    await read();
    expect(page()).toContain('to a ferret not listed');
    expect(page()).not.toContain('for casen');
  });

  test('a list that cannot be read still draws, from what this device holds', async () => {
    const client = daemon({});
    client.on(LIST, () => {
      throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
    });
    const outbox = deviceOutbox();
    await outbox.outbox.submit({ daemonId: 'd1', ferretId: 'f1', message: 'still here' });
    open(client, outbox);
    await read();
    expect(page()).toContain('still here');
  });

  const REFUSAL = 'This device is not allowed to use the fleet.';

  test('a refused list read says the daemon’s sentence, never "Nothing is waiting"', async () => {
    const client = daemon({});
    client.on(LIST, () => {
      throw new DaemonCallError(403, 'forbidden', REFUSAL);
    });
    open(client);
    await read();
    expect(page()).toContain(REFUSAL);
    expect(page()).not.toContain('Nothing is waiting');
    expect(mounted!.root.findAllByProps({ 'data-queue-empty': '' })).toHaveLength(0);
  });

  test('a queue the daemon refused is said, not counted as empty, while a readable one still shows', async () => {
    const client = fakeClient(
      {
        [LIST]: () => [ferretSummary({ id: 'f1', name: 'Casen' }), ferretSummary({ id: 'f2', name: 'Mira' })],
        [QUEUE]: call => {
          if (call.params.ferretId === 'f1') throw new DaemonCallError(403, 'forbidden', REFUSAL);
          return { messages: [queued('q2', 'for mira', 1)] };
        },
      },
      'd1',
    );
    open(client);
    await read();
    expect(page()).toContain('for mira');
    const unread = mounted!.root.findByProps({ 'data-queue-unread': 'd1/f1' });
    expect(text(unread)).toBe(`Couldn’t read this queue: ${REFUSAL}`);
    expect(mounted!.root.findAllByProps({ 'data-queue-unread': 'd1/f2' })).toHaveLength(0);
    expect(page()).not.toContain('Nothing is waiting');
  });

  test('every read refused: each ferret says it could not be read, and the empty state stays away', async () => {
    const client = fakeClient(
      {
        [LIST]: () => [ferretSummary({ id: 'f1', name: 'Casen' })],
        [QUEUE]: () => {
          throw new DaemonCallError(403, 'forbidden', REFUSAL);
        },
      },
      'd1',
    );
    open(client);
    await read();
    expect(page()).toContain(REFUSAL);
    expect(page()).not.toContain('Nothing is waiting');
  });

  test('a queue event reads the queues again; a change of ferrets reads the list again', async () => {
    const client = daemon({});
    open(client);
    await read();
    const queueReads = client.callsTo(QUEUE).length;
    client.on(QUEUE, call =>
      call.params.ferretId === 'f1' ? { messages: [queued('q9', 'arrived')] } : { messages: [] },
    );
    await runAsync(async () => client.emit('conversation.queue-changed', { ferret: 'f1' }));
    await settleUntil(() => page().includes('arrived'), 'queue read again', runAsync);
    expect(client.callsTo(QUEUE).length).toBeGreaterThan(queueReads);
    await runAsync(async () => client.emit('conversation.message-sent', { ferret: 'f1' }));
    await runAsync(async () => client.emit('ferrets.changed', { ferret: 'f1', generation: 2 }));
    await settleUntil(() => client.callsTo(LIST).length === 2, 'list read again', runAsync);
  });

  test('draws with no outbox on this device, and keeps drawing', async () => {
    mounted = render(
      <RouterProvider>
        {withClient(daemon({ f1: { messages: [queued('q1', 'for casen')] } }), <AllQueuesScreen />)}
      </RouterProvider>,
    );
    await read();
    expect(page()).toContain('for casen');
  });

  test('draws nothing for a client that names no daemon', () => {
    mounted = render(withClient(fakeClient({}), <AllQueuesScreen />));
    expect(mounted.toJSON()).toBeNull();
  });
});
