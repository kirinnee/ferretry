import { describe, it } from 'bun:test';
import should from 'should';
import { AUTO_MOVE_FAILED_REF, AutoMoveFailures, WardenAutoMoveService } from '../../daemon/lib/index.ts';
import type { MachineAgendaPort, MachineMembersStore, MachineRaise } from '../../daemon/lib/machine-notices.ts';
import { DEFAULT_WARDEN_CONFIG } from '../../daemon/lib/protocol.ts';
import { credential, facts, runtime, tool } from '../support/pack.ts';
import { enabled, NOW, session } from './sweep-harness.ts';

/** A ferret on `claude-a-wrapper` sitting on a limit that has not reset. */
const limited = (id = 's1') => {
  const view = session({ id, status: 'rate_limited', state: { quota: { resetAt: Date.parse('2099-01-01') } } });
  return { ...view, config: { ...view.config, agent: 'claude-a-wrapper', harness: 'claude' as const } };
};

const config = enabled({ autoMove: { ...DEFAULT_WARDEN_CONFIG.autoMove, enabled: true } });

class Members implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    return this.value;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    this.value = { ...members };
  }
}

/** The mover wired to a REAL failures list, over a fleet the test changes: `where` is each live ferret's login. */
function wired(options: { moveFails: boolean }) {
  const raised: { ref: string; request: MachineRaise; members: readonly string[] | undefined }[] = [];
  const resolved: string[] = [];
  const machine: MachineAgendaPort = {
    raiseOrUpdate: async (ref, request, members) => void raised.push({ ref, request, members }),
    resolve: async ref => void resolved.push(ref),
  };
  const where = new Map<string, string>([['s1', 'claude-a-wrapper']]);
  const failures = new AutoMoveFailures(
    new Members(),
    machine,
    {
      current: async id => (where.has(id) ? { agent: where.get(id)! } : undefined),
      candidate: async () => undefined,
    },
    () => '2026-11-06T09:00:00.000Z',
  );
  const stored = { value: undefined as unknown };
  const service = new WardenAutoMoveService({
    facts: async () =>
      facts({
        runtimes: [runtime('claude-a'), runtime('claude-b')],
        credentials: [credential('claude-a-login'), credential('claude-b-login')],
        tools: [tool('claude', true)],
      }),
    ownerHold: async () => undefined,
    blockingJobs: async () => [],
    askToStopJobs: async () => undefined,
    stopJobs: async () => ({ stopped: [], survivors: [] }),
    move: async (sessionId, request) => {
      if (options.moveFails) throw new Error('Ferrets refused: a job is running');
      where.set(sessionId, request.agent);
    },
    resume: async () => undefined,
    agentOf: async sessionId => where.get(sessionId),
    ledger: {
      read: async () => stored.value,
      write: async memory => {
        stored.value = memory;
      },
    },
    notifyOwner: async () => undefined,
    emit: async () => undefined,
    journal: { record: () => undefined },
    failed: async (sessionId, detail, quiet) => await failures.note(sessionId, detail, quiet),
    settled: async () => await failures.reconcile(),
  });
  return { service, where, raised, resolved };
}

describe('the ferrets the Warden could not move, from the auto-move service', () => {
  it('should list a ferret whose move did not take, on the one machine item', async () => {
    // Arrange
    const { service, raised } = wired({ moveFails: true });

    // Act
    await service.run({ fleet: [limited()], config, nowMs: NOW });

    // Assert
    const last = raised.at(-1)!;
    should(last.ref).equal(AUTO_MOVE_FAILED_REF);
    should(last.members).eql(['s1']);
    should(last.request.context).containEql('the move did not take: Ferrets refused: a job is running');
  });

  it('should drop it once the ferret was moved by someone else', async () => {
    // Arrange
    const { service, where, resolved } = wired({ moveFails: true });
    await service.run({ fleet: [limited()], config, nowMs: NOW });

    // Act: a person moved it; the limit is gone, so the next run finds nothing to move
    where.set('s1', 'claude-b-wrapper');
    await service.run({ fleet: [], config, nowMs: NOW + 60_000 });

    // Assert
    should(resolved).eql([AUTO_MOVE_FAILED_REF]);
  });

  it('should drop it once the ferret was stopped', async () => {
    // Arrange
    const { service, where, resolved } = wired({ moveFails: true });
    await service.run({ fleet: [limited()], config, nowMs: NOW });

    // Act
    where.delete('s1');
    await service.run({ fleet: [], config, nowMs: NOW + 60_000 });

    // Assert
    should(resolved).eql([AUTO_MOVE_FAILED_REF]);
  });

  it('should list nothing when the move took', async () => {
    // Arrange
    const { service, raised } = wired({ moveFails: false });

    // Act
    await service.run({ fleet: [limited()], config, nowMs: NOW });

    // Assert
    should(raised).eql([]);
  });

  it('should keep working when the list itself fails: the sweep never throws over it', async () => {
    // Arrange
    const { service } = wired({ moveFails: true });
    const broken = new WardenAutoMoveService({
      ...(service as unknown as { ports: ConstructorParameters<typeof WardenAutoMoveService>[0] }).ports,
      failed: async () => {
        throw new Error('agenda down');
      },
      settled: async () => {
        throw new Error('agenda down');
      },
    });

    // Act
    const run = broken.run({ fleet: [limited()], config, nowMs: NOW });

    // Assert
    await should(run).be.fulfilled();
  });
});
