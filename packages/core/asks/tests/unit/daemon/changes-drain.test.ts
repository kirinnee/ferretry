import { expect, it } from 'bun:test';
import { type AgendaLedgerRepository, AgendaService } from '../../../daemon/lib/agenda/index.ts';
import { FakeLedgerRepository } from './routes/support.ts';

const AT = '2024-05-01T10:00:00.000Z';

/** A repository that counts ledger reads and holds an outbox that names `pending` ferrets. */
function world(pending: string[]) {
  const inner = new FakeLedgerRepository();
  const counts = { reads: 0, flushed: [] as string[] };
  const repository: AgendaLedgerRepository = {
    read: async id => {
      counts.reads += 1;
      return await inner.read(id);
    },
    transact: async (id, apply, by, provenance) => await inner.transact(id, apply, by, provenance),
    changeOutbox: {
      flush: async id => {
        counts.flushed.push(id);
      },
      pendingFerrets: () => pending,
    },
  };
  const service = new AgendaService(
    repository,
    { now: () => AT },
    { has: async () => true },
    { raised: async () => undefined },
  );
  return { service, counts };
}

it('a drain tick with 300 boards and no pending outbox makes 0 ledger reads and 0 flushes', async () => {
  const { service, counts } = world([]);
  await service.flushPending(() => undefined);
  expect(counts.reads).toBe(0);
  expect(counts.flushed).toEqual([]);
});

it('a drain tick with one pending outbox touches only that ferret, and reads no ledger', async () => {
  const { service, counts } = world(['b7']);
  await service.flushPending(() => undefined);
  expect(counts.flushed).toEqual(['b7']);
  expect(counts.reads).toBe(0);
});

it('a drain stops before the next ferret once its signal aborts', async () => {
  const { service, counts } = world(['a', 'b', 'c']);
  const controller = new AbortController();
  controller.abort();
  await expect(service.flushPending(() => undefined, controller.signal)).rejects.toBeDefined();
  expect(counts.flushed).toEqual([]);
});
