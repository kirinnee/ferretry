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

const build = (
  homeOf: (sessionId: string) => Promise<string> = async () => 'lead',
  focusOf: (sessionId: string) => Promise<{ id: string } | null> = async () => null,
) => {
  const ledgers = new Ledgers();
  const service = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
    undefined,
    { focusOf },
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

  it('clears a row where the daemon names it when it stands there, and never the lead’s own row of the same reference', async () => {
    const { ledgers, service } = build();
    // The kid's own, unscoped row (a pre-upgrade one, or one the move left behind) and the lead's own row, one reference.
    await service.raise(
      'lead',
      request({ source: 'agent-raised', sourceRef: 'warden:ask:K' }),
      daemon('warden-escalation'),
    );
    const kidRow = await service.raise(
      'grandkid',
      request({ source: 'agent-raised', sourceRef: 'warden:ask:K' }),
      daemon('input-request'),
    );
    should(kidRow).match({ ok: true });
    should(ledgers.open('grandkid')).have.length(1);

    const cleared = await service.resolveSource(
      'grandkid',
      'agent-raised',
      'warden:ask:K',
      daemon('warden-escalation'),
      'recovered',
    );

    should(cleared).match({ ok: true, change: 'resolved' });
    should(ledgers.open('grandkid')).be.empty();
    should(ledgers.open('lead').map(each => each.sourceRef)).eql(['warden:ask:K']);
  });

  it('looks for the row on the home when the named board does not hold it', async () => {
    const { ledgers, service } = build();
    await service.raise(
      'kid',
      request({ source: 'agent-raised', sourceRef: 'warden:ask:K:kid' }),
      daemon('warden-escalation'),
    );
    const cleared = await service.resolveSource(
      'kid',
      'agent-raised',
      'warden:ask:K:kid',
      daemon('warden-escalation'),
      'recovered',
    );
    should(cleared).match({ ok: true, change: 'resolved' });
    should(ledgers.open('lead')).be.empty();
  });

  it('does not look for a row on a session id that is not one', async () => {
    const { service } = build();
    const cleared = await service.resolveSource(
      'not a session!',
      'agent-raised',
      'warden:ask:K',
      daemon('warden-escalation'),
    );
    should(cleared).match({ ok: false, error: { code: 'invalid' } });
  });

  it('gives a redirected warden row no focus card, and a row raised in place its own', async () => {
    const { ledgers, service } = build(
      async () => 'lead',
      async id => (id === 'lead' ? { id: 'F12' } : null),
    );
    await service.raise('kid', request({ source: 'agent-raised', sourceRef: 'w:kid' }), daemon('warden-escalation'));
    await service.raise('lead', request({ source: 'agent-raised', sourceRef: 'w:lead' }), daemon('warden-escalation'));
    const tasks = ledgers.open('lead').map(each => [each.sourceRef, each.task?.id ?? null]);
    should(tasks).eql([
      ['w:kid', null],
      ['w:lead', 'F12'],
    ]);
  });

  it('keeps two sub-ferrets and the lead itself, with one kind, on separate rows of the home', async () => {
    const { ledgers, service } = build();
    const escalation = (sessionId: string, sourceRef: string) =>
      service.raise(sessionId, request({ source: 'agent-raised', sourceRef }), daemon('warden-escalation'));
    await escalation('kid', 'warden:ask:sus_thinking:kid');
    await escalation('grandkid', 'warden:ask:sus_thinking:grandkid');
    await escalation('lead', 'warden:ask:sus_thinking');
    // A second sweep refreshes its own row and no other.
    await escalation('kid', 'warden:ask:sus_thinking:kid');

    should(ledgers.open('lead').map(each => each.sourceRef)).eql([
      'warden:ask:sus_thinking:kid',
      'warden:ask:sus_thinking:grandkid',
      'warden:ask:sus_thinking',
    ]);
    should(ledgers.open('lead').map(each => each.title?.split(':')[0])).eql([
      'becki',
      'grandkid',
      'A ferret needs a human',
    ]);
  });

  it('resolves only the row of the sub-ferret that recovered', async () => {
    const { ledgers, service } = build();
    for (const [session, ref] of [
      ['kid', 'warden:ask:sus_thinking:kid'],
      ['grandkid', 'warden:ask:sus_thinking:grandkid'],
      ['lead', 'warden:ask:sus_thinking'],
    ] as const) {
      await service.raise(session, request({ source: 'agent-raised', sourceRef: ref }), daemon('warden-escalation'));
    }

    // The Warden resolves on the board that holds the row, which is the lead's: the service does not move it again.
    const cleared = await service.resolveSource(
      'lead',
      'agent-raised',
      'warden:ask:sus_thinking:kid',
      daemon('warden-escalation'),
      'recovered',
    );

    should(cleared).match({ ok: true, change: 'resolved' });
    should(ledgers.open('lead').map(each => each.sourceRef)).eql([
      'warden:ask:sus_thinking:grandkid',
      'warden:ask:sus_thinking',
    ]);
  });

  it('says where a session’s asks land: its home for a sub-ferret, itself for a lead or an unknown session', async () => {
    const { service } = build();
    should(await service.homeOf('kid')).equal('lead');
    should(await service.homeOf('lead')).equal('lead');
    should(await service.homeOf('not valid!')).equal('not valid!');
    const failing = build(async () => {
      throw new Error('no');
    });
    should(await failing.service.homeOf('kid')).equal('kid');
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
