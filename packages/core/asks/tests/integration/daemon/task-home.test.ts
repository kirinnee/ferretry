import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../daemon/lib/agenda/index.ts';

/**
 * What a source that keeps a daemon-raised task card for a ferret (Conversation's `prompt` source) needs of the REAL
 * port: a child's card lands on its lead's board, the ref the raise returned is the one to close by, and a closed
 * `(source, entry)` is never reopened, so the same obligation again needs a new entry.
 */
class PerSessionLedgers implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const world = () => {
  const repository = new PerSessionLedgers();
  const service = new AgendaService(
    repository,
    { now: () => '2026-11-15T10:00:00.000Z' },
    { has: async id => ['lead', 'child'].includes(id) },
    { raised: async () => undefined },
    undefined,
    undefined,
    { leadOf: async id => (id === 'child' ? 'lead' : undefined), addressOf: async id => id },
    undefined,
    { of: async id => (id === 'child' ? 'lead' : id) },
  );
  return asksPort(service, { ferrets: async () => [...repository.ledgers.keys()] }, () => ({
    schema: z.strictObject({ kind: z.string(), prompt: z.string() }),
    title: 'Prompt',
    form: false,
  }));
};

const task = (entry: string) => ({
  source: 'prompt' as never,
  ref: { kind: 'permission', prompt: 'p1' },
  entry: entry as never,
  kind: 'task' as const,
  subject: 'child needs a permission answer',
  why: 'child is waiting on a prompt only you can answer.',
  raisedBy: { kind: 'daemon' as const },
  ferret: 'child',
  blocking: true,
});

describe('a task card raised about a sub-ferret on the real Asks port', () => {
  test('lands on the lead’s board, which the returned ref names, and closes by that ref and entry', async () => {
    const asks = world();

    const ref = await asks.raise(task('p:one'));
    expect(ref.ferret).toBe('lead');
    expect(await asks.open({ source: 'prompt' as never })).toHaveLength(1);

    await asks.close(ref, 'withdrawn', 'p:one' as never);
    expect(await asks.open({ source: 'prompt' as never })).toHaveLength(0);
  });

  test('the same entry raised again after it closed is the closed obligation, not a new card', async () => {
    const asks = world();
    const ref = await asks.raise(task('p:one'));
    await asks.close(ref, 'withdrawn', 'p:one' as never);

    expect(await asks.raise(task('p:one'))).toEqual(ref);
    expect(await asks.open({ source: 'prompt' as never })).toHaveLength(0);

    await asks.raise(task('p:two'));
    expect(await asks.open({ source: 'prompt' as never })).toHaveLength(1);
  });
});
