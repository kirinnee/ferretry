import { describe, expect, test } from 'bun:test';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../daemon/lib/agenda/index.ts';
import type { SubFerretDirectory } from '../../../daemon/lib/sub-ferret/index.ts';

/** One ledger per session, as the file repository keeps them. */
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

const SESSIONS = new Set(['lead', 'child']);
/** `child` was started by `lead`; the daemon's notices about `child` land on `lead` (home redirection ON). */
const DIRECTORY: SubFerretDirectory = {
  leadOf: async id => (id === 'child' ? 'lead' : undefined),
  addressOf: async id => id,
};

const world = () => {
  const repository = new PerSessionLedgers();
  const service = new AgendaService(
    repository,
    { now: () => '2026-11-11T10:00:00.000Z' },
    { has: async id => SESSIONS.has(id) },
    { raised: async () => undefined },
    undefined,
    undefined,
    DIRECTORY,
    undefined,
    { of: async id => (id === 'child' ? 'lead' : id) },
  );
  const asks = asksPort(service, { ferrets: async () => [...repository.ledgers.keys()] }, () => 'unavailable');
  return { asks, repository };
};

const notice = (over: { subject?: string; why?: string } = {}) => ({
  source: 'daemon' as never,
  ref: {},
  entry: 'helper-blocked' as never,
  subject: over.subject ?? 'Helper has blocked work',
  why: over.why ?? 'It waits on a decision.',
  raisedBy: { kind: 'daemon' as const },
  ferret: 'child' as never,
});

describe('a standing notice about a sub-ferret whose agenda home is its lead', () => {
  test('returns the ref of the item where it landed, and get() finds it through the public port', async () => {
    const { asks, repository } = world();

    const ref = await asks.standing(notice());

    expect(ref.ferret).toBe('lead');
    expect(repository.ledgers.has('child')).toBe(false);
    expect((await asks.get(ref))?.subject).toBe('Helper has blocked work');
  });

  test('an identical retry returns the same ref instead of throwing, and writes nothing new', async () => {
    const { asks } = world();
    const first = await asks.standing(notice());

    const again = await asks.standing(notice());

    expect(again).toEqual(first);
    expect(await asks.open({ ferret: 'lead' as never })).toHaveLength(1);
  });

  test('a changed wording refreshes the same item, and close() through the returned ref closes it', async () => {
    const { asks } = world();
    const first = await asks.standing(notice());

    const changed = await asks.standing(notice({ why: 'It now waits on two decisions.' }));
    await asks.close(changed, 'answered');

    expect(changed).toEqual(first);
    expect((await asks.get(first))?.state).toBe('closed');
  });
});
