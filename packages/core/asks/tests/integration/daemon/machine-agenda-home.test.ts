import { describe, expect, test } from 'bun:test';
import type { AgendaContextSession, AgendaFerretsContext } from '../../../contract/index.ts';
import { agendaContext } from '../../../daemon/adapters/agenda-context.ts';
import { asksPort } from '../../../daemon/adapters/asks-port.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../daemon/lib/agenda/index.ts';
import { MACHINE_AGENDA_ID } from '../../../daemon/lib/protocol/agenda.ts';

/**
 * THE MACHINE AGENDA IS A REAL HOME (triage B18). Built through the production context (`agendaContext`) over a Ferrets
 * half that knows only real ferrets — the machine's own board is not one of them — a notice the owner has no home for
 * lands on the machine agenda, the Warden's orphan card can be raised there, and the owner reads it back; a gate item
 * or a follow-up still stays with the ferret's own lead.
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

const AT = '2026-11-14T10:00:00.000Z';
/** Two helpers a Warden started under a Warden-started lead: nobody the owner started, and no interactive session. */
const SESSIONS: Readonly<Record<string, AgendaContextSession>> = {
  lead: { id: 'lead', origin: 'warden', mode: 'auto', updatedAt: AT },
  child: { id: 'child', parent: 'lead', origin: 'warden', mode: 'auto', updatedAt: AT },
  other: { id: 'other', parent: 'lead', origin: 'warden', mode: 'auto', updatedAt: AT },
};
const FERRETS: AgendaFerretsContext = {
  has: async id => id in SESSIONS,
  leadOf: async id => SESSIONS[id]?.parent,
  addressOf: async id => id,
  get: async id => SESSIONS[id],
  all: async () => Object.keys(SESSIONS),
};

const world = () => {
  const repository = new PerSessionLedgers();
  const context = agendaContext(
    key => (key === 'ferrets' ? FERRETS : 'unavailable'),
    () => undefined,
  );
  const service = new AgendaService(
    repository,
    { now: () => AT },
    context.sessions,
    { raised: async () => undefined },
    undefined,
    context.focus,
    context.subFerrets,
    context.cards,
    context.homes,
    context.gates,
  );
  const asks = asksPort(service, { ferrets: async () => [...repository.ledgers.keys()] }, () => 'unavailable');
  return { asks, service, repository };
};

const notice = (ferret: string, over: { entry?: string } = {}) => ({
  source: 'daemon' as never,
  ref: {},
  entry: (over.entry ?? 'helper-blocked') as never,
  subject: `${ferret} has blocked work`,
  why: 'It waits on a decision.',
  raisedBy: { kind: 'daemon' as const },
  ferret: ferret as never,
});

describe('the machine agenda as a home', () => {
  test('a notice about a sub-ferret nobody owns lands on the machine agenda, one row per ferret', async () => {
    const { asks, repository } = world();

    const first = await asks.standing(notice('child'));
    const second = await asks.standing(notice('other'));

    expect(first.ferret).toBe(MACHINE_AGENDA_ID);
    expect(second.ferret).toBe(MACHINE_AGENDA_ID);
    expect(first.id).not.toBe(second.id);
    expect(repository.ledgers.has('child')).toBe(false);
    expect((await asks.open({ ferret: MACHINE_AGENDA_ID as never })).length).toBe(2);
  });

  test('an identical retry is the same row, and closing it through the ref closes the machine row', async () => {
    const { asks } = world();
    const first = await asks.standing(notice('child'));

    const again = await asks.standing(notice('child'));
    await asks.close(again, 'answered');

    expect(again).toEqual(first);
    expect((await asks.get(first))?.state).toBe('closed');
  });

  test('the Warden’s orphan card is raised on the machine board itself, and the owner reads it back', async () => {
    const { asks, service } = world();

    const ref = await asks.standing({ ...notice(MACHINE_AGENDA_ID), entry: 'warden.orphans' as never });

    expect(ref.ferret).toBe(MACHINE_AGENDA_ID);
    const listed = await service.list(MACHINE_AGENDA_ID);
    expect(listed.ok && listed.value.items.map(item => item.subject)).toEqual([
      `${MACHINE_AGENDA_ID} has blocked work`,
    ]);
  });

  test('a gate item or a follow-up never falls back to the machine: it stays on the ferret’s lead', async () => {
    const { asks } = world();

    const ref = await asks.raise({
      source: 'daemon' as never,
      ref: {},
      entry: 'follow-up' as never,
      kind: 'yesno',
      subject: 'Ship it?',
      why: 'The release is ready.',
      raisedBy: { kind: 'daemon' },
      ferret: 'child' as never,
    });

    expect(ref.ferret).not.toBe(MACHINE_AGENDA_ID);
  });
});
