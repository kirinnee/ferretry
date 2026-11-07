import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  type AgentPin,
  AgentPinError,
  type AgentPinRepository,
  AgentPinService,
  AgentPinSubsystem,
  MAX_AGENT_PINS,
  withPinned,
} from '../../../../daemon/lib/agent-pins/index.ts';
import type { SerialExecutor } from '../../../src/lib/ports.ts';
import type { SessionDirectorySubsystem } from '../../../../daemon/lib/runtime/mounts/sessions.ts';
import { sessionView } from '../runtime/mounts/support.ts';
import { byPinOrder } from '../../../../daemon/lib/agent-pins/service.ts';

class MemoryPins implements AgentPinRepository {
  saved: readonly AgentPin[] = [];
  saves = 0;
  failLoad = false;
  failRetention = false;
  retentions: string[] = [];
  async load(): Promise<readonly AgentPin[]> {
    if (this.failLoad) throw new Error('disk gone');
    return this.saved;
  }
  async save(pins: readonly AgentPin[]): Promise<void> {
    this.saved = pins;
    this.saves++;
    for (const pin of pins) await this.retain(pin.sessionId);
  }
  async retain(sessionId: string): Promise<void> {
    this.retentions.push(sessionId);
    if (this.failRetention) throw new Error('transient retention failure');
  }
}

const inline: SerialExecutor = {
  run: async (_key, work) => await work(),
  runExclusive: async work => await work(),
};

function fixture(instants: readonly string[] = ['2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z']) {
  const repository = new MemoryPins();
  let tick = 0;
  const service = new AgentPinService(
    repository,
    { now: () => instants[Math.min(tick++, instants.length - 1)]! },
    inline,
  );
  return { repository, service };
}

class Roster implements SessionDirectorySubsystem {
  constructor(private readonly views: readonly SessionView[]) {}
  async list(): Promise<SessionView[]> {
    return [...this.views];
  }
  async get(reference: string): Promise<SessionView | undefined> {
    return this.views.find(view => view.config.id === reference || view.config.teammate === reference);
  }
}

describe('AgentPinService', () => {
  it('should remember when each ferret was pinned, in pin order', async () => {
    // Arrange
    const { service } = fixture();

    // Act
    await service.pin('b');
    await service.pin('a');

    // Assert
    should([...(await service.pinnedAt())]).deepEqual([
      ['b', '2026-11-01T10:00:00.000Z'],
      ['a', '2026-11-01T11:00:00.000Z'],
    ]);
  });

  it('should keep the place and the instant of a ferret pinned twice, without writing again', async () => {
    // Arrange
    const { service, repository } = fixture();
    await service.pin('a');

    // Act
    const again = await service.pin('a');

    // Assert
    should(again).equal('2026-11-01T10:00:00.000Z');
    should(repository.saves).equal(1);
  });

  it('should retry failed live membership restoration when pinned again, without saving the pin file twice', async () => {
    const { service, repository } = fixture();
    repository.failRetention = true;
    await should(service.pin('a')).be.rejectedWith('transient retention failure');
    should(repository.saves).equal(1);
    repository.failRetention = false;

    should(await service.pin('a')).equal('2026-11-01T10:00:00.000Z');
    should(repository.retentions).deepEqual(['a', 'a']);
    should(repository.saves).equal(1);
  });

  it('should unpin a ferret, and treat unpinning one that is not pinned as nothing to do', async () => {
    // Arrange
    const { service, repository } = fixture();
    await service.pin('a');

    // Act
    await service.unpin('a');
    await service.unpin('a');

    // Assert
    should((await service.pinnedAt()).size).equal(0);
    should(repository.saves).equal(2);
  });

  it('should refuse a pin past the limit and say so, leaving the list as it was', async () => {
    // Arrange
    const { service } = fixture();
    for (let index = 0; index < MAX_AGENT_PINS; index++) await service.pin(`s${index}`);

    // Act
    const refusal = await service.pin('one-too-many').catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceOf(AgentPinError);
    should((refusal as AgentPinError).code).equal('full');
    should((await service.pinnedAt()).size).equal(MAX_AGENT_PINS);
  });
});

describe('withPinned', () => {
  it('should put pinnedAt on the pinned ferrets and leave every other view untouched', async () => {
    // Arrange
    const { service } = fixture();
    await service.pin('s2');
    const reader = withPinned(new Roster([sessionView('s1'), sessionView('s2')]), service);

    // Act
    const views = await reader.list();
    const one = await reader.get('s2');

    // Assert
    should(views[0]).not.have.property('pinnedAt');
    should(views[1]?.pinnedAt).equal('2026-11-01T10:00:00.000Z');
    should(one?.pinnedAt).equal('2026-11-01T10:00:00.000Z');
    should(await reader.get('nope')).be.undefined();
  });

  it('should list every ferret unpinned when the pin list cannot be read', async () => {
    // Arrange
    const { service, repository } = fixture();
    repository.failLoad = true;
    const reader = withPinned(new Roster([sessionView('s1')]), service);

    // Act
    const views = await reader.list();

    // Assert
    should(views).have.length(1);
    should(views[0]).not.have.property('pinnedAt');
  });
});

describe('AgentPinSubsystem', () => {
  it('should pin by name, answer the view with its pin, and be idempotent both ways', async () => {
    // Arrange
    const { service } = fixture();
    const roster = withPinned(new Roster([sessionView('s1', { teammate: 'marin' })]), service);
    const subject = new AgentPinSubsystem(roster, service);

    // Act
    const pinned = await subject.pin('marin');
    const pinnedAgain = await subject.pin('s1');
    const unpinned = await subject.unpin('s1');
    const unpinnedAgain = await subject.unpin('marin');

    // Assert
    should(pinned.pinnedAt).equal('2026-11-01T10:00:00.000Z');
    should(pinnedAgain.pinnedAt).equal(pinned.pinnedAt);
    should(unpinned).not.have.property('pinnedAt');
    should(unpinnedAgain).not.have.property('pinnedAt');
  });

  it('should refuse a ferret that does not exist, never pinning a ghost', async () => {
    // Arrange
    const { service, repository } = fixture();
    const subject = new AgentPinSubsystem(withPinned(new Roster([]), service), service);

    // Act
    const refusal = await subject.pin('ghost').catch((error: unknown) => error);

    // Assert
    should((refusal as AgentPinError).code).equal('not-found');
    should(repository.saves).equal(0);
  });
});

describe('byPinOrder', () => {
  it('should put the earlier pin first and break an equal instant by session id', () => {
    // Arrange
    const early = { sessionId: 'z', pinnedAt: '2026-11-01T10:00:00.000Z' };
    const late = { sessionId: 'a', pinnedAt: '2026-11-01T11:00:00.000Z' };
    const tied = { sessionId: 'b', pinnedAt: '2026-11-01T10:00:00.000Z' };

    // Act
    const sorted = [late, tied, early].sort(byPinOrder).map(pin => pin.sessionId);

    // Assert
    should(byPinOrder(early, late)).equal(-1);
    should(byPinOrder(late, early)).equal(1);
    should(sorted).deepEqual(['b', 'z', 'a']);
  });
});
