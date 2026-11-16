import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '../../../contract/index.ts';
import { queueCancelVerb, queueEditVerb, queueVerb } from '../../../cli/lib/queue/commands.ts';
import { ClientQueueGateway } from '../../../cli/lib/queue/gateway.ts';
import type { QueueGateway } from '../../../cli/lib/queue/ports.ts';
import { renderQueue } from '../../../cli/lib/queue/render.ts';
import { at } from '../../support/instant.ts';

const AT = at('2026-10-30T13:05:37.000Z');
const message = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id: 'q-1',
  sender: 'human',
  text: 'ship it',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'queued',
  stateAt: AT,
  revision: 1,
  ...overrides,
});

class Gateway implements QueueGateway {
  readonly changes: string[] = [];
  constructor(private readonly held: readonly QueuedMessage[]) {}
  async messages(): Promise<readonly QueuedMessage[]> {
    return this.held;
  }
  async edit(ferret: string, id: string, text: string): Promise<QueuedMessage> {
    this.changes.push(`edit ${ferret} ${id} ${text}`);
    return message({ id, text, revision: 2 });
  }
  async cancel(ferret: string, id: string): Promise<QueuedMessage> {
    this.changes.push(`cancel ${ferret} ${id}`);
    return message({ id, state: 'cancelled' });
  }
}

describe('fy queue', () => {
  test('lists a ferret’s queue with a tick per state and why a waiting message waits', () => {
    const lines = renderQueue([
      message(),
      message({ id: 'q-2', state: 'queued', waitReason: 'busy', fromName: 'hadi', sender: 'agent' }),
      message({ id: 'q-3', state: 'failed', failure: 'pane gone' }),
    ]);
    expect(lines[0]).toBe('✓  q-1  you: ship it');
    expect(lines[1]).toBe('✓  q-2  hadi: ship it — waiting: the ferret is busy');
    expect(lines[2]).toBe('✗ failed  q-3  you: ship it — pane gone');
    expect(renderQueue([])).toEqual(['Nothing queued.']);
  });

  test('prints the queue, as JSON on request, and edits and cancels by id', async () => {
    const out: string[] = [];
    const gateway = new Gateway([message()]);
    const ports = { gateway, out: { report: (line: string) => out.push(line) } };
    expect(await queueVerb(ports)({ args: ['hadi'], options: {} })).toBe(0);
    expect(out).toEqual(['✓  q-1  you: ship it']);
    out.length = 0;
    await queueVerb(ports)({ args: ['hadi'], options: { json: true } });
    expect(JSON.parse(out[0] ?? '').messages).toHaveLength(1);
    expect(await queueEditVerb(ports)({ args: ['hadi', 'q-1', 'new', 'words'], options: {} })).toBe(0);
    expect(await queueCancelVerb(ports)({ args: ['hadi', 'q-1'], options: {} })).toBe(0);
    expect(gateway.changes).toEqual(['edit hadi q-1 new words', 'cancel hadi q-1']);
    expect(await queueEditVerb(ports)({ args: ['hadi', 'q-1'], options: {} })).toBe(2);
  });

  test('the gateway calls the renamed routes and parses what comes back', async () => {
    const calls: { route: string; init: unknown }[] = [];
    const client = {
      call: async (route: string, init?: unknown) => {
        calls.push({ route, init });
        return route.startsWith('GET') ? { messages: [message()] } : message({ revision: 2 });
      },
    };
    const gateway = new ClientQueueGateway(client as never);
    expect(await gateway.messages('hadi')).toHaveLength(1);
    expect((await gateway.edit('hadi', 'q-1', 'x')).revision).toBe(2);
    await gateway.cancel('hadi', 'q-1');
    expect(calls.map(call => call.route)).toEqual([
      'GET /v1/ferrets/:ferretId/queue',
      'PATCH /v1/ferrets/:ferretId/queue/:messageId',
      'DELETE /v1/ferrets/:ferretId/queue/:messageId',
    ]);
    expect(calls[1]?.init).toEqual({ params: { ferretId: 'hadi', messageId: 'q-1' }, body: { text: 'x' } });
  });
});
