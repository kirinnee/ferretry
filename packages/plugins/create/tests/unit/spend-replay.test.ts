import { expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { SPEND_LEDGER } from '../../contract/index.ts';
import { SpendLedger } from '../../daemon/lib/spend.ts';
const entry = {
  at: '2026-11-26T00:00:00.000Z',
  day: '2026-11-26',
  tool: 'generate_image',
  model: 'flux-dev',
  ferret: 'synthetic',
  microUsd: 2,
  priced: 'table',
  request: '0123456789abcdef',
};
test('E-422 a spent approval remains spent after more than 4 MiB of subsequent ledger entries and restart', async () => {
  const folder = new MemoryStateFolder();
  const old = JSON.stringify({ format: 1, ...entry });
  const filler = JSON.stringify({ format: 1, ...entry, day: '2026-11-25', request: 'fedcba9876543210' });
  folder.plant(SPEND_LEDGER, `${old}\n${`${filler}\n`.repeat(Math.ceil((4 * 1024 * 1024) / filler.length) + 10)}`);
  const ledger = () => new SpendLedger(folder.port([SPEND_LEDGER]));
  expect(await ledger().facts(entry.day, entry.request)).toEqual({ spentToday: 2, earlierSpends: 1 });
  await ledger().refund(entry as never);
  expect(await ledger().facts(entry.day, entry.request)).toEqual({ spentToday: 0, earlierSpends: 0 });
});
test('E-422 unreadable spend history cannot resurrect an approval or lower the daily sum', async () => {
  const folder = new MemoryStateFolder();
  folder.plant(SPEND_LEDGER, 'damaged-line\n');
  await expect(new SpendLedger(folder.port([SPEND_LEDGER])).facts(entry.day, entry.request)).rejects.toThrow();
});
