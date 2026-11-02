import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  migrateToAgendaHomes,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-10-01T10:00:00.000Z';
const UNTIL = '2026-12-01T10:00:00.000Z';
const LEADS: Readonly<Record<string, string>> = { kid: 'lead', kid2: 'lead' };
const daemon: AgendaActor = { kind: 'daemon', cause: 'system' };

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
  closed(sessionId: string) {
    return (this.ledgers.get(sessionId)?.entries ?? []).flatMap(entry =>
      entry.lifecycle === 'addressed' ? [entry.item] : [],
    );
  }
}

const GATE = {
  cardId: 'F1',
  laneId: 'tested',
  laneName: 'To test',
  entry: 1,
  projectId: 'P1',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'bad', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'task',
  sourceRef: 'ref:1',
  title: 'An old ask',
  subject: 'Something',
  why: 'Because.',
  howToResolve: 'Answer.',
  kind: 'info',
  ...overrides,
});

const build = (options: { marker?: boolean; failRaise?: boolean; failList?: string; failResolve?: boolean } = {}) => {
  const ledgers = new Ledgers();
  const service = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async () => true },
    { raised: async () => undefined },
  );
  const marker = { records: [] as (readonly string[])[], already: options.marker ?? false };
  const warnings: string[] = [];
  const names: Record<string, string> = { kid: 'becki', lead: 'lizzette' };
  const ports = (extra: Partial<Parameters<typeof migrateToAgendaHomes>[0]> = {}) =>
    ({
      agenda: {
        list: async (id: string) => {
          if (options.failList === id) throw new Error('unreadable');
          return await service.list(id);
        },
        raise: async (id: string, req: RaiseAgendaRequest, actor: AgendaActor) => {
          if (options.failRaise === true) throw new Error('unwritable');
          return await service.raise(id, req, actor);
        },
        resolve: async (...args: Parameters<AgendaService['resolve']>) => {
          if (options.failResolve === true) throw new Error('unwritable');
          return await service.resolve(...args);
        },
      },
      sessions: { all: async () => ['lead', 'kid', 'kid2', 'stray'] },
      subFerrets: { leadOf: async (id: string) => LEADS[id], addressOf: async (id: string) => names[id] ?? id },
      homes: { of: async (id: string) => (id in LEADS ? 'lead' : id) },
      marker: {
        ran: async () => marker.already,
        record: async (_at: string, moved: readonly string[]) => {
          marker.records.push(moved);
          marker.already = true;
        },
      },
      now: () => NOW,
      diagnostics: { warn: (message: string) => warnings.push(message) },
      ...extra,
    }) as Parameters<typeof migrateToAgendaHomes>[0];
  return { ledgers, service, marker, warnings, ports };
};

describe('migrateToAgendaHomes', () => {
  it('moves open items to the home, prefixes non-gate titles, carries a snooze, and closes the originals', async () => {
    const world = build();
    await world.service.raise('kid', request(), daemon);
    const second = await world.service.raise('kid', request({ sourceRef: 'ref:2', title: undefined }), daemon);
    const id = second.ok && second.item !== undefined ? second.item.id : 'A2';
    await world.service.snooze('kid', id, UNTIL, { kind: 'human' });
    await world.service.raise('kid', request({ source: 'question', sourceRef: 'q:1' }), {
      kind: 'daemon',
      cause: 'harness-prompt',
    });

    const outcome = await migrateToAgendaHomes(world.ports());

    should(outcome).eql({ ran: true, moved: 2 });
    const moved = world.ledgers.open('lead');
    should(moved.map(each => each.title)).eql(['becki: An old ask', 'becki: Needs you']);
    should(moved[1]?.parked?.reason).equal('snoozed');
    should(world.ledgers.open('kid').map(each => each.sourceRef)).eql(['q:1']);
    should(world.ledgers.closed('kid').map(each => each.resolutionNote)).containEql(
      "moved to !A1 on lizzette's agenda",
    );
    should(world.marker.records).have.length(1);
  });

  it('keeps a gate item’s reference and title, and collapses copies of one gate', async () => {
    const world = build();
    const gate = request({
      sourceRef: 'gate:F1:tested:1',
      title: 'Try it',
      gate: GATE as never,
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Not good' }] },
    });
    await world.service.raise('kid', gate, daemon);
    await world.service.raise('kid2', gate, daemon);

    await migrateToAgendaHomes(world.ports());

    const onLead = world.ledgers.open('lead');
    should(onLead).have.length(1);
    should(onLead[0]).match({ title: 'Try it', sourceRef: 'gate:F1:tested:1' });
    should(world.ledgers.open('kid')).be.empty();
    should(world.ledgers.open('kid2')).be.empty();
  });

  it('does nothing once the marker is written, and leaves leads and loners alone', async () => {
    const world = build();
    await world.service.raise('stray', request(), daemon);
    await world.service.raise('kid', request(), daemon);
    should(await migrateToAgendaHomes(world.ports())).eql({ ran: true, moved: 1 });
    await world.service.raise('kid', request({ sourceRef: 'later' }), daemon);
    should(await migrateToAgendaHomes(world.ports())).eql({ ran: false, moved: 0 });
    should(world.ledgers.open('kid')).have.length(1);
    should(world.ledgers.open('stray')).have.length(1);
  });

  it('skips a session that is its own home', async () => {
    const world = build();
    await world.service.raise('kid', request(), daemon);
    const outcome = await migrateToAgendaHomes(world.ports({ homes: { of: async id => id } }));
    should(outcome).eql({ ran: true, moved: 0 });
    should(world.ledgers.open('kid')).have.length(1);
  });

  it('is unfinished, and tries again, when an agenda cannot be read, raised on or closed', async () => {
    for (const options of [{ failList: 'kid' }, { failRaise: true }, { failResolve: true }]) {
      const world = build(options);
      await world.service.raise('kid', request(), daemon);
      const outcome = await migrateToAgendaHomes(world.ports());
      should(outcome.ran).be.false();
      should(world.marker.records).be.empty();
      should(world.warnings.some(each => each.includes('unfinished'))).be.true();
    }
  });

  it('is unfinished when the home refuses the item', async () => {
    const world = build();
    await world.service.raise('kid', request(), daemon);
    const refusing = world.ports({
      agenda: {
        ...world.ports().agenda,
        raise: async () => ({ ok: false, error: { code: 'full', message: 'full' } }),
      },
    });
    should((await migrateToAgendaHomes(refusing)).ran).be.false();
  });

  it('leaves an item a ferret or the owner raised where it is, and still writes the marker', async () => {
    const world = build();
    const byAgent = await world.service.raise(
      'kid',
      request({
        source: 'agent-raised',
        sourceRef: null,
        premise: 'A release waits.',
        context: 'The deploy is green.',
      }),
      {
        kind: 'agent',
        sessionId: 'kid',
        name: null,
      },
    );
    should(byAgent.ok).be.true();
    await world.service.raise('kid', request({ sourceRef: 'daemon:1' }), daemon);

    const outcome = await migrateToAgendaHomes(world.ports());

    should(outcome).eql({ ran: true, moved: 1 });
    should(world.ledgers.open('kid').map(each => each.raisedBy)).eql(['agent']);
    should(world.ledgers.open('lead').map(each => each.sourceRef)).eql(['daemon:1']);
    should(world.marker.records).have.length(1);
  });

  it('scopes a warden notification to the ferret it is about, and leaves a scoped or machine one as it is', async () => {
    const world = build();
    const warden: AgendaActor = { kind: 'daemon', cause: 'warden-escalation' };
    const raise = (sourceRef: string) =>
      world.service.raise('kid', request({ source: 'agent-raised', sourceRef }), warden);
    await raise('warden:ask:sus_thinking');
    await raise('warden:ask:sus_subprocess:kid');
    await raise('warden:ask:fleet:dead_monitor:daemon:liveness-stalled');

    const outcome = await migrateToAgendaHomes(world.ports());

    should(outcome).eql({ ran: true, moved: 3 });
    should(world.ledgers.open('lead').map(each => each.sourceRef)).eql([
      'warden:ask:sus_thinking:kid',
      'warden:ask:sus_subprocess:kid',
      'warden:ask:fleet:dead_monitor:daemon:liveness-stalled',
    ]);
  });

  it('warns, naming the session and the item, when an item moved but could not be closed where it was', async () => {
    const world = build({ failResolve: true });
    await world.service.raise('kid', request(), daemon);

    const outcome = await migrateToAgendaHomes(world.ports());

    should(outcome.ran).be.false();
    should(world.marker.records).be.empty();
    should(world.warnings.join('\n')).containEql(
      "!A1 on kid moved to !A1 on lead's agenda but could not be closed where it was",
    );
  });

  it('does not hold the marker back for an item the home refuses for good', async () => {
    const world = build();
    await world.service.raise('kid', request(), daemon);
    for (const code of ['forbidden', 'invalid', 'too-long'] as const) {
      const refusing = world.ports({
        agenda: { ...world.ports().agenda, raise: async () => ({ ok: false, error: { code, message: 'no' } }) },
      });
      world.marker.already = false;

      const outcome = await migrateToAgendaHomes(refusing);

      should(outcome).eql({ ran: true, moved: 0 });
    }
    should(world.ledgers.open('kid')).have.length(1);
    should(world.warnings.join('\n')).containEql('!A1 on kid cannot move to lead');
  });

  it('never rejects', async () => {
    const world = build();
    const broken = world.ports({
      marker: {
        ran: async () => {
          throw new Error('x');
        },
        record: async () => undefined,
      },
    });
    should(await migrateToAgendaHomes(broken)).eql({ ran: false, moved: 0 });
  });

  it('falls back to ids when a callsign or home cannot be found', async () => {
    const world = build();
    await world.service.raise('kid', request(), daemon);
    const outcome = await migrateToAgendaHomes(
      world.ports({
        subFerrets: {
          leadOf: async id => LEADS[id],
          addressOf: async () => {
            throw new Error('x');
          },
        },
      }),
    );
    should(outcome.moved).equal(1);
    should(world.ledgers.open('lead')[0]?.title).equal('kid: An old ask');
  });

  it('stays incomplete when a raise changed nothing and the standing item cannot be found', async () => {
    const world = build({ failList: 'lead' });
    await world.service.raise('kid', request(), daemon);
    const quiet = world.ports({
      agenda: { ...world.ports().agenda, raise: async () => ({ ok: true }) as never },
    });

    const outcome = await migrateToAgendaHomes(quiet);

    should(outcome.ran).be.false();
    should(world.warnings.join('\n')).containEql('could not move');
  });
});
