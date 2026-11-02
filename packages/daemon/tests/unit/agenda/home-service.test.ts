import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-10-01T10:00:00.000Z';
const LEADS: Readonly<Record<string, string>> = { kid: 'lead', grandkid: 'kid' };
const CALLSIGNS: Readonly<Record<string, string>> = { kid: 'becki' };

class Ledgers implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledgers.get(sessionId) ?? null);
    if (mutation.ok) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
  open(sessionId: string) {
    return (this.ledgers.get(sessionId)?.entries ?? []).flatMap(entry =>
      entry.lifecycle === 'active' ? [entry.item] : [],
    );
  }
}

const build = (homeOf: (sessionId: string) => Promise<string> = async () => 'lead') => {
  const ledgers = new Ledgers();
  const service = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
    undefined,
    undefined,
    { leadOf: async id => LEADS[id], addressOf: async id => CALLSIGNS[id] ?? id },
    undefined,
    { of: homeOf },
  );
  return { ledgers, service };
};

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'task',
  sourceRef: 'ref:1',
  subject: 'Something',
  why: 'Because.',
  howToResolve: 'Answer.',
  kind: 'info',
  ...overrides,
});
const daemon = (cause: Extract<AgendaActor, { kind: 'daemon' }>['cause']): AgendaActor => ({ kind: 'daemon', cause });

describe('AgendaService agenda homes', () => {
  it('raises a daemon item about a sub-ferret on its home', async () => {
    const { ledgers, service } = build();
    const raised = await service.raise('kid', request(), daemon('system'));
    should(raised).match({ ok: true, snapshot: { sessionId: 'lead' } });
    should(ledgers.open('lead')).have.length(1);
    should(ledgers.open('kid')).be.empty();
  });

  it('keeps every hands-on card on the sub-ferret', async () => {
    const { ledgers, service } = build();
    await service.raise('kid', request(), daemon('input-request'));
    await service.raise('kid', request({ sourceRef: 'ref:2' }), daemon('harness-prompt'));
    should(ledgers.open('kid')).have.length(2);
    should(ledgers.open('lead')).be.empty();
  });

  it('leaves a lead’s own item, an agent’s item and an unknown session alone', async () => {
    const { ledgers, service } = build();
    await service.raise('lead', request(), daemon('system'));
    should(ledgers.open('lead')).have.length(1);
    const byAgent = await service.raise('kid', request(), { kind: 'agent', sessionId: 'kid', name: null });
    should(byAgent).match({ ok: false, error: { code: 'forbidden' } });
    const odd = await service.raise('not valid!', request(), daemon('system'));
    should(odd).match({ ok: false, error: { code: 'invalid' } });
  });

  it('falls back to the session itself when the home cannot be found', async () => {
    const { ledgers, service } = build(async () => {
      throw new Error('no');
    });
    await service.raise('kid', request(), daemon('system'));
    should(ledgers.open('kid')).have.length(1);
  });

  it('names the sub-ferret on a redirected warden escalation, with a default title or its own', async () => {
    const { ledgers, service } = build();
    await service.raise('kid', request({ sourceRef: 'w:1' }), daemon('warden-escalation'));
    await service.raise(
      'grandkid',
      request({ sourceRef: 'w:2', title: 'Stuck for an hour' }),
      daemon('warden-escalation'),
    );
    should(ledgers.open('lead').map(each => each.title)).eql([
      'becki: A ferret needs a human',
      'grandkid: Stuck for an hour',
    ]);
  });

  it('resolves a non-hands-on source on the home, and a hands-on one in place', async () => {
    const { ledgers, service } = build();
    await service.raise('kid', request({ sourceRef: 'w:1' }), daemon('warden-escalation'));
    await service.raise('kid', request({ sourceRef: 'i:1' }), daemon('input-request'));
    const cleared = await service.resolveSource('kid', 'task', 'w:1', daemon('warden-escalation'), 'ok');
    const inPlace = await service.resolveSource('kid', 'task', 'i:1', daemon('input-request'), 'ok');
    should(cleared).match({ ok: true, change: 'resolved' });
    should(inPlace).match({ ok: true, change: 'resolved' });
    should(ledgers.open('lead')).be.empty();
    should(ledgers.open('kid')).be.empty();
  });

  it('never lets an agent carry an item over', async () => {
    const { ledgers, service } = build();
    await service.raise('lead', request(), daemon('system'));
    const carried = ledgers.open('lead')[0];

    const byAgent = await service.raise('lead', request({ source: 'agent-raised', sourceRef: null, carried }), {
      kind: 'agent',
      sessionId: 'lead',
      name: null,
    });

    should(byAgent).match({ ok: false, error: { code: 'forbidden' } });
    should(ledgers.open('lead')).have.length(1);
  });
});
