import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type RaiseAgendaRequest,
} from '../../../../daemon/lib/agenda/index.ts';
import type { AgendaHomeResolver } from '../../../../daemon/lib/agenda/home.ts';
import type { MachineAgendaPort } from '../../../../daemon/lib/agenda/machine-agenda.ts';
import { agendaState } from '../../../../daemon/lib/protocol/agenda-state.ts';
import { type AgendaSnapshot, MACHINE_AGENDA_ID } from '../../../../daemon/lib/protocol/agenda.ts';
import type { SubFerretDirectory } from '../../../../daemon/lib/sub-ferret/index.ts';

const NOW = '2026-07-31T10:00:00Z';
const SESSIONS = new Set(['lead', 'child', 'stranger']);
const HUMAN = { kind: 'human' as const };
const LEAD = { kind: 'agent' as const, sessionId: 'lead', name: 'Lee' };
const CHILD = { kind: 'agent' as const, sessionId: 'child', name: 'Kit' };
const WARDEN = { kind: 'daemon' as const, cause: 'warden-escalation' as const };
const SYSTEM = { kind: 'daemon' as const, cause: 'system' as const };

/** `child` was started by `lead` (callsign `lizzette`); `stranger` is a lead. */
const DIRECTORY: SubFerretDirectory = {
  leadOf: async sessionId => (sessionId === 'child' ? 'lead' : undefined),
  addressOf: async sessionId => ({ lead: 'lizzette', child: 'kit' })[sessionId] ?? sessionId,
};

class MemoryRepository implements AgendaLedgerRepository {
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

const emptySnapshot = (sessionId: string): AgendaSnapshot =>
  ({ v: 1, sessionId, items: [], resolved: [], count: 0, parseErrors: 0, updatedAt: NOW }) as unknown as AgendaSnapshot;

/** A machine agenda that records what it was asked and answers as told. */
class FakeMachine implements MachineAgendaPort {
  readonly raised: { ref: string; request: Record<string, unknown>; members?: readonly string[] }[] = [];
  readonly resolved: { ref: string; note?: string }[] = [];
  writes: 'undefined' | 'throw' = 'undefined';
  async raiseOrUpdate(ref: string, request: object, members?: readonly string[]): Promise<AgendaMutation | undefined> {
    this.raised.push({
      ref,
      request: request as Record<string, unknown>,
      ...(members === undefined ? {} : { members }),
    });
    if (this.writes === 'throw') throw new Error('disk full');
    return undefined;
  }
  async resolve(ref: string, note?: string): Promise<AgendaMutation | undefined> {
    this.resolved.push({ ref, ...(note === undefined ? {} : { note }) });
    return undefined;
  }
  async list(): Promise<AgendaSnapshot> {
    return emptySnapshot(MACHINE_AGENDA_ID);
  }
}

const machineHome: AgendaHomeResolver = { of: async () => MACHINE_AGENDA_ID };

const worldWith = (
  options: { machine?: FakeMachine; homes?: AgendaHomeResolver; repository?: MemoryRepository } = {},
) => {
  const repository = options.repository ?? new MemoryRepository();
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async sessionId => SESSIONS.has(sessionId) },
    { raised: async () => undefined },
    undefined,
    undefined,
    DIRECTORY,
    undefined,
    options.homes,
    undefined,
    options.machine,
  );
  return { repository, service };
};

const notice = (extra: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'task',
  sourceRef: null,
  notice: true,
  subject: 'The sandbox needs attention',
  why: 'It stopped answering.',
  howToResolve: 'Look at it.',
  ...extra,
});

describe('a notice about a sub-ferret that has no home but the machine agenda', () => {
  it('lands on the machine agenda, one row per ferret, titled with the ferret address', async () => {
    // Arrange
    const machine = new FakeMachine();
    const { service } = worldWith({ machine, homes: machineHome });

    // Act
    const mutation = await service.raise('child', notice({ title: 'Sandbox stopped' }), SYSTEM);

    // Assert
    should(mutation.ok && mutation.change).equal('unchanged');
    should(machine.raised).have.length(1);
    should(machine.raised[0]?.ref).equal('notice:system:child');
    should(machine.raised[0]?.members).eql(['child']);
    should(machine.raised[0]?.request.title).equal('kit: Sandbox stopped');
    should(machine.raised[0]?.request).not.have.property('source');
    should(machine.raised[0]?.request).not.have.property('sourceRef');
  });

  it('keeps the ferret in the row reference once, and names a Warden row by its source reference', async () => {
    // Arrange
    const machine = new FakeMachine();
    const { service } = worldWith({ machine, homes: machineHome });

    // Act
    await service.raise('child', notice({ sourceRef: 'warden:stuck:child' }), WARDEN);
    await service.raise('child', notice({ sourceRef: 'warden:stuck' }), WARDEN);

    // Assert
    should(machine.raised.map(call => call.ref)).eql(['warden:stuck:child', 'warden:stuck:child']);
  });

  it('is told as unchanged when the machine agenda wrote nothing, and as corrupt when it failed', async () => {
    // Arrange
    const quiet = new FakeMachine();
    const broken = new FakeMachine();
    broken.writes = 'throw';

    // Act
    const unchanged = await worldWith({ machine: quiet, homes: machineHome }).service.raise('child', notice(), SYSTEM);
    const failed = await worldWith({ machine: broken, homes: machineHome }).service.raise('child', notice(), SYSTEM);

    // Assert
    should(unchanged).containDeep({ ok: true, changed: false, change: 'unchanged' });
    should(unchanged.ok && unchanged.snapshot.sessionId).equal(MACHINE_AGENDA_ID);
    should(failed).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(!failed.ok && failed.error.message).startWith('the machine agenda could not be written: Error: disk full');
  });

  it('is cleared on the machine agenda when the daemon resolves its source', async () => {
    // Arrange
    const machine = new FakeMachine();
    const { service } = worldWith({ machine, homes: machineHome });

    // Act
    await service.resolveSource('child', 'task', 'warden:stuck', WARDEN, 'it recovered');
    await service.resolveSource('child', 'task', 'warden:stuck', WARDEN);

    // Assert
    should(machine.resolved).eql([{ ref: 'warden:stuck:child', note: 'it recovered' }, { ref: 'warden:stuck:child' }]);
  });
});

describe('where the daemon asks the owner for a session', () => {
  it('is the session itself when the home is the machine agenda but there is no machine agenda', async () => {
    // Arrange
    const { service } = worldWith({ homes: machineHome });

    // Assert
    should(await service.homeOf('child', true)).equal('child');
  });

  it('is the machine agenda when it exists, and the session itself when the resolver cannot say', async () => {
    // Arrange
    const withMachine = worldWith({ machine: new FakeMachine(), homes: machineHome }).service;
    const broken = worldWith({ homes: { of: async () => await Promise.reject(new Error('no config')) } }).service;

    // Assert
    should(await withMachine.homeOf('child', true)).equal(MACHINE_AGENDA_ID);
    should(await broken.homeOf('child')).equal('child');
    should(await withMachine.homeOf('stranger')).equal('stranger');
    should(await withMachine.homeOf('../escape')).equal('../escape');
  });
});

describe('the machine agenda over the session routes', () => {
  it('is listed only for the daemon, and refused by id to everyone else', async () => {
    // Arrange
    const { service } = worldWith({ machine: new FakeMachine() });

    // Act
    const daemon = await service.list(MACHINE_AGENDA_ID, SYSTEM);
    const owner = await service.list(MACHINE_AGENDA_ID, HUMAN);

    // Assert
    should(daemon).containDeep({ ok: true, value: { sessionId: MACHINE_AGENDA_ID } });
    should(owner).containDeep({
      ok: false,
      error: { code: 'not-found', message: 'the machine agenda is available only at /v1/machine/agenda' },
    });
  });
});

describe('a lead working on its sub-ferret’s board', () => {
  const seeded = async () => {
    const repository = new MemoryRepository();
    // The sub-ferret's board, raised by the daemon with no lineage in the way.
    const bare = new AgendaService(
      repository,
      { now: () => NOW },
      { has: async sessionId => SESSIONS.has(sessionId) },
      { raised: async () => undefined },
    );
    const raised = await bare.raise(
      'child',
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve the release?',
        why: 'It waits.',
        howToResolve: 'Approve.',
        premise: 'A decision is waiting.',
        context: 'It changes the public service.',
        ask: { kind: 'permission' },
      },
      CHILD,
    );
    if (!raised.ok) throw new Error(raised.error.message);
    return { repository, service: worldWith({ repository }).service };
  };

  it('may dismiss an item on it, as the lead of that lineage', async () => {
    // Arrange
    const { service } = await seeded();

    // Act
    const mutation = await service.dismiss('child', 'A1', LEAD, 'not needed');

    // Assert
    should(mutation.ok).be.true();
  });

  it('refuses the sub-ferret itself the lead’s verbs, naming whom to tell', async () => {
    // Arrange
    const { service } = await seeded();

    // Act
    const mutation = await service.dismiss('child', 'A1', CHILD, 'not needed');

    // Assert
    should(mutation).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(!mutation.ok && mutation.error.message).containEql('fy send lizzette');
  });
});

describe('the Warden’s record of a nudge', () => {
  const resting = async () => {
    const repository = new MemoryRepository();
    const { service } = worldWith({ repository });
    const raised = await service.raise(
      'stranger',
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Which region?',
        why: 'It waits.',
        howToResolve: 'Answer.',
        premise: 'A decision is waiting.',
        context: 'It changes the public service.',
        ask: { kind: 'open-question' },
      },
      { kind: 'agent', sessionId: 'stranger', name: 'Sam' },
    );
    if (!raised.ok) throw new Error(raised.error.message);
    await service.rest('stranger', 'A1', 'checking', { kind: 'agent', sessionId: 'stranger', name: 'Sam' });
    await service.reply('stranger', 'A1', HUMAN, 'what is this?');
    const item = (await service.list('stranger')).ok
      ? ((await service.list('stranger')) as { value: AgendaSnapshot }).value.items[0]
      : undefined;
    if (item === undefined) throw new Error('the item is gone');
    const view = agendaState(item);
    if (view.state !== 'resting' || view.sub !== 'waiting-on-ferret') throw new Error('not waiting on the ferret');
    return { service, repository, since: view.since };
  };

  it('records the send id first and the nudge after it, and counts the nudge on the rest', async () => {
    // Arrange
    const { service, since } = await resting();
    const target = { id: 'A1' as never, since, nudges: 0 };

    // Act
    const decided = await service.nudging('stranger', [target], 'send-1');
    const decidedAgain = await service.nudging('stranger', [target], 'send-2');
    const nudged = await service.nudged('stranger', target);
    const stale = await service.nudged('stranger', target);

    // Assert
    should(decided).containDeep({ ok: true, changed: true, change: 'nudged' });
    should(decidedAgain).containDeep({ ok: true, changed: false });
    should(nudged).containDeep({ ok: true, changed: true, change: 'nudged' });
    should(nudged.ok && nudged.snapshot.items[0]?.resting?.nudges).equal(1);
    should(nudged.ok && nudged.snapshot.items[0]?.resting?.nudgeSend).be.undefined();
    should(stale).containDeep({ ok: true, changed: false });
  });
});

describe('an answer that never reached its ferret', () => {
  it('reopens the item as the owner’s, saying why, and with the request that was not delivered', async () => {
    // Arrange
    const { service } = worldWith();
    await service.raise(
      'stranger',
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve the release?',
        why: 'It waits.',
        howToResolve: 'Approve.',
        premise: 'A decision is waiting.',
        context: 'It changes the public service.',
        ask: { kind: 'permission' },
      },
      { kind: 'agent', sessionId: 'stranger', name: 'Sam' },
    );
    await service.answer('stranger', 'A1', { kind: 'permission', decision: 'approve' }, HUMAN);

    // Act
    const mutation = await service.undelivered('stranger', 'A1', 'the ferret was gone', 1);
    const withoutRequest = await service.undelivered('stranger', 'A1', 'the ferret was gone');

    // Assert
    should(mutation.ok).be.true();
    should(withoutRequest.ok).be.true();
  });
});

describe('an ask about a card that the asker’s own agenda already carries', () => {
  it('points the asker to editing that item instead of raising a second one', async () => {
    // Arrange
    const service = new AgendaService(
      new MemoryRepository(),
      { now: () => NOW },
      { has: async sessionId => SESSIONS.has(sessionId) },
      { raised: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { asking: async () => ({ sessionId: 'stranger', id: 'A3' as never }) },
    );

    // Act
    const refused = await service.raise(
      'stranger',
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve the release?',
        why: 'It waits.',
        howToResolve: 'Approve.',
        premise: 'A decision is waiting.',
        context: 'It changes the public service.',
        ask: { kind: 'permission' },
        task: { id: 'F12' },
      },
      { kind: 'agent', sessionId: 'stranger', name: 'Sam' },
    );

    // Assert
    should(refused).containDeep({ ok: false, error: { code: 'invalid' } });
    should(!refused.ok && refused.error.message).startWith(
      '&F12 already asks the owner on !A3, which carries the card; put yours on it: fy agenda edit A3 --where',
    );
  });
});
