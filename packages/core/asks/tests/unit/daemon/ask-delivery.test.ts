import { expect, it } from 'bun:test';
import type { AskDelivery } from '../../../contract/index.ts';
import { askDelivery } from '../../../daemon/adapters/ask-delivery.ts';

it('keeps receipts pending while the delivery provider is unavailable', async () => {
  let provider: AskDelivery | 'unavailable' = {
    send: async () => undefined,
    receipt: async () => ({ state: 'pending' }),
  };
  const delivery = askDelivery(() => provider);
  await delivery.messenger.send('f1', 'answer', 'send1');
  expect(await delivery.ports.receipts.receipt('f1', 'send1')).toEqual({ state: 'pending' });
  provider = 'unavailable';
  expect(await delivery.ports.receipts.receipt('f1', 'send1')).toEqual({ state: 'pending' });
  expect(await askDelivery(() => 'unavailable').ports.receipts.receipt('f1', 'send1')).toEqual({ state: 'pending' });
});

it('counts delivery without a receipt method only while a provider is available', async () => {
  const delivery = askDelivery(() => ({ send: async () => undefined }));
  expect(await delivery.ports.receipts.receipt('f1', 'send1')).toEqual({ state: 'delivered' });
});
