import { expect, it } from 'bun:test';
import { AskIdSchema } from '@ferretry/core-asks/contract';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { InputAsksAdapter } from '../../../../daemon/adapters/inputs/asks.ts';
import type { InputCard } from '../../../../daemon/lib/inputs/ports.ts';
import type { AgendaId } from '../../../../daemon/lib/inputs/wire.ts';

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
