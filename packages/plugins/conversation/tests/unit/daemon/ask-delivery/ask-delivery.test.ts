import { describe, expect, test } from 'bun:test';
import { AskNotTypedError } from '@ferretry/core-asks/contract';
import { err, ok } from '@ferretry/std';
import { askDeliveryOf } from '../../../../daemon/delivery/adapters/ask-delivery.ts';

const FERRET = 'abc12345' as never;

const apiOf = (over: Record<string, unknown> = {}) => {
  const sent: unknown[] = [];
  const api = {
    send: async (...args: unknown[]) => {
      sent.push(args);
      return ok({ ferret: FERRET, disposition: 'queued', sendId: 's1' });
    },
    sendRecord: async () => undefined,
    ...over,
  };
  return { api: api as never, sent };
};

describe('B3 R-0334 ask.delivery:ferret over Conversation', () => {
  test('types the answer as a queued, non-interrupting message under its send id, as the owner', async () => {
    const { api, sent } = apiOf();
    await askDeliveryOf(api).send(FERRET, 'yes, go', 'send-1');
    expect(sent).toEqual([[FERRET, { kind: 'owner' }, { message: 'yes, go', sendId: 'send-1' }]]);
  });

  test('a draft in the way, or a ferret still starting, is "not typed, retry"', async () => {
    for (const code of ['composer_occupied', 'session_launching']) {
      const { api } = apiOf({ send: async () => err({ code, message: 'busy' }) });
      await expect(askDeliveryOf(api).send(FERRET, 'x', 's')).rejects.toBeInstanceOf(AskNotTypedError);
    }
  });

  test('any other refusal is a plain error, not a retry', async () => {
    const { api } = apiOf({ send: async () => err({ code: 'not_found', message: 'no such ferret' }) });
    const failed = askDeliveryOf(api).send(FERRET, 'x', 's');
    await expect(failed).rejects.toThrow('no such ferret');
    await failed.catch((e: unknown) => expect(e).not.toBeInstanceOf(AskNotTypedError));
  });

  test('the queue owns ordering, so the composer reads empty', async () => {
    expect(await askDeliveryOf(apiOf().api).composer?.(FERRET)).toBe('empty');
  });

  test('a receipt follows the send ledger: delivered, pending, failed', async () => {
    const at = (fate: string, unaccountedReason?: string) =>
      askDeliveryOf(apiOf({ sendRecord: async () => ({ fate, unaccountedReason }) }).api).receipt?.(FERRET, 's');
    expect(await at('delivered')).toEqual({ state: 'delivered' });
    expect(await at('accepted')).toEqual({ state: 'pending' });
    expect(await at('queued')).toEqual({ state: 'pending' });
    expect(await at('timed_out')).toEqual({ state: 'failed', reason: 'timed_out' });
    expect(await at('unaccounted', 'ferret_ended')).toEqual({ state: 'failed', reason: 'ferret_ended' });
    expect(await at('cancelled')).toEqual({ state: 'failed', reason: 'cancelled' });
    expect(await askDeliveryOf(apiOf().api).receipt?.(FERRET, 's')).toEqual({ state: 'pending' });
  });
});
