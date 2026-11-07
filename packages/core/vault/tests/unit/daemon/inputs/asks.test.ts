import { describe, expect, it } from 'bun:test';
import { AskIdSchema } from '@ferretry/core-asks/contract';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import {
  InputAgentNotifierAdapter,
  InputAsksAdapter,
  inputTellSendId,
} from '../../../../daemon/adapters/inputs/asks.ts';
import type { InputCard } from '../../../../daemon/lib/inputs/ports.ts';
import type { AgendaId } from '../../../../daemon/lib/inputs/wire.ts';
import type { InputCaller } from '../../../../daemon/lib/inputs/wire.ts';
import { inputRequestService, RAISE, SESSION } from './support.ts';

const card = (requestId: string): InputCard => ({
  requestId,
  title: 'Input',
  ask: 'Type the value',
  prompt: 'Value:',
  blocking: true,
  expiresAt: '2026-11-07T12:00:00.000Z',
});

it('keeps input ask reads and closes on the board of the request that raised them', async () => {
  const asks = new FakeAsks();
  const records = { promptOf: async (request: string) => `Prompt for ${request}` };
  const adapter = new InputAsksAdapter(asks, records);
  const first = await adapter.raise('f1', card('request1'));
  const second = await adapter.raise('f2', card('request2'));
  expect(first).toEqual({ ok: true, id: 'A1' });
  expect(second).toEqual({ ok: true, id: 'A1' });
  const id = 'A1' as AgendaId;
  // Rebuilding the adapter must retain the scope from the service's stored request, without an in-memory id map.
  const restarted = new InputAsksAdapter(asks, records);
  expect(await restarted.promptOf('f1', id)).toBe('Prompt for request1');
  expect(await restarted.promptOf('f2', id)).toBe('Prompt for request2');
  await restarted.close('f1', id, 'Ended');
  expect((await asks.get({ ferret: 'f1', id: AskIdSchema.parse(id) }))?.state).toBe('closed');
  expect((await asks.get({ ferret: 'f2', id: AskIdSchema.parse(id) }))?.state).toBe('open');
  expect(await restarted.promptOf('f1', id)).toBeUndefined();
  expect(await restarted.promptOf('f2', id)).toBe('Prompt for request2');
});

describe('InputAgentNotifierAdapter', () => {
  const SESSION_ID = 'mvv6b4qw-49d0158d';
  const HOST: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };
  const VALUE = 'hunter2-the-owners-password';

  it('tells the ferret through Asks under a send id derived from its card, so a card is told once', async () => {
    const asks = new FakeAsks();
    const notifier = new InputAgentNotifierAdapter(asks);
    await notifier.tell(SESSION_ID, 'A3' as AgendaId, 'A3 was answered and typed into %terminal:dev. Read the terminal to continue.');
    await notifier.tell(SESSION_ID, 'A3' as AgendaId, 'A3 was answered and typed into %terminal:dev. Read the terminal to continue.');
    await notifier.tell(SESSION_ID, 'A4' as AgendaId, 'A4 ended without a value (expired).');
    expect(asks.told).toEqual([
      {
        ferret: SESSION_ID,
        text: 'A3 was answered and typed into %terminal:dev. Read the terminal to continue.',
        sendId: inputTellSendId(SESSION_ID, 'A3' as AgendaId),
      },
      {
        ferret: SESSION_ID,
        text: 'A4 ended without a value (expired).',
        sendId: inputTellSendId(SESSION_ID, 'A4' as AgendaId),
      },
    ]);
    expect(inputTellSendId('f1', 'A3' as AgendaId)).not.toBe(inputTellSendId('f2', 'A3' as AgendaId));
  });

  it('is total: an Asks that refuses, or has no tell, tells nobody and throws nothing', async () => {
    await new InputAgentNotifierAdapter({
      tell: async () => {
        throw new Error('the outbox is full');
      },
    }).tell(SESSION_ID, 'A1' as AgendaId, 'ended');
    await new InputAgentNotifierAdapter({}).tell(SESSION_ID, 'A1' as AgendaId, 'ended');
  });

  it('tells the ferret once, in today’s words, when the owner declines a request, and never the typed value', async () => {
    const asks = new FakeAsks();
    const { service } = inputRequestService({ notifier: new InputAgentNotifierAdapter(asks) });
    const view = await service.raise(SESSION, RAISE);
    const id = (await service.list(HOST)).find(request => request.agendaItemId === view.id)?.id as string;
    await service.cancel(SESSION, id, HOST);
    expect(asks.told.length).toBe(1);
    expect(asks.told[0]?.ferret).toBe(SESSION);
    expect(asks.told[0]?.sendId).toBe(inputTellSendId(SESSION, view.id as AgendaId));
    expect(asks.told[0]?.text).toBe(
      `${view.id} ended without a value (cancelled: owner declined). If you still need a value, raise a fresh terminal_request_input, or ask the owner to take over the terminal.`,
    );
    expect(asks.told[0]?.text).not.toContain(VALUE);
  });

  it('does not tell a ferret whose own session ended: nobody is there to read it', async () => {
    const asks = new FakeAsks();
    const { service } = inputRequestService({ notifier: new InputAgentNotifierAdapter(asks) });
    await service.raise(SESSION, RAISE);
    await service.sessionEnded(SESSION);
    expect(asks.told).toEqual([]);
  });
});
