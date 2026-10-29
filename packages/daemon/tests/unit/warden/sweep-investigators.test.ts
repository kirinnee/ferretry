import { describe, it } from 'bun:test';
import { WARDEN_INVESTIGATOR_MAX_SEQUENCE } from '@ferretry/protocol';
import should from 'should';
import {
  type NameAllocationRequest,
  NameAllocator,
  type NameClaim,
  type NameClaimAttempt,
  type NameClaimStore,
  claimStartName,
  displayAgentName,
  agentSpokenName,
} from '../../../src/lib/names/index.ts';
import { WardenCallsignTakenError, type WardenFleetSession } from '../../../src/lib/warden/index.ts';
import { at, enabled, harness, journalTypes, NOW, session } from './sweep-harness.ts';

const INVESTIGATOR = /^warden-[0-9a-f]{6}$/u;
const POOL = ['ada', 'bea', 'cy', 'dot', 'eve'];

const suspect = (id: string): WardenFleetSession =>
  session({ id, status: 'awaiting_user', state: { lastActivityAt: at(-600) } });

const holding = (id: string, teammate: string): WardenFleetSession => {
  const base = session({ id });
  return { ...base, config: { ...base.config, teammate } };
};

class MemoryClaimStore implements NameClaimStore {
  readonly claims: NameClaim[] = [];

  async listClaims(): Promise<readonly NameClaim[]> {
    return [...this.claims];
  }

  async tryClaim(claim: NameClaim): Promise<NameClaimAttempt> {
    const conflict = this.claims.find(
      current => current.callsign === claim.callsign && current.expiresAtMs > claim.claimedAtMs,
    );
    if (conflict !== undefined) return { claimed: false, conflict };
    this.claims.push(claim);
    return { claimed: true, claim };
  }

  async release(callsign: string, ownerId: string): Promise<void> {
    const index = this.claims.findIndex(claim => claim.callsign === callsign && claim.ownerId === ownerId);
    if (index >= 0) this.claims.splice(index, 1);
  }
}

describe('naming the investigators', () => {
  it('should leave the human name pool untouched however many wardens are spawned', async () => {
    // Arrange: a faithful spawner — the real allocator over a real claim ledger, asked exactly as the daemon asks
    const store = new MemoryClaimStore();
    const allocator = new NameAllocator(store, { nextIndex: () => 0 }, POOL);
    const asked: NameAllocationRequest[] = [];
    const claims = {
      allocate: async (request: NameAllocationRequest) => {
        asked.push(request);
        return await allocator.allocate(request);
      },
      release: async (callsign: string, ownerId: string) => await store.release(callsign, ownerId),
    };
    const freeBefore = (await allocator.allocate({ ownerId: 'probe', nowMs: NOW })).ok;
    store.claims.length = 0;
    asked.length = 0;
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1'), suspect('s2'), suspect('s3')],
      spawn: async (request, call) => {
        const claimed = await claimStartName(claims, `w${call}`, { teammate: request.teammate }, NOW);
        if (!claimed.ok) throw new WardenCallsignTakenError(request.teammate ?? '');
        return {
          sessionId: `w${call}`,
          createdAt: at(0),
          agent: request.agent,
          harness: 'claude',
          model: 'glm-5.2',
          modelSource: 'configured',
        };
      },
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(freeBefore).be.true();
    should(subject.spawns.length).be.above(0);
    for (const spawn of subject.spawns) should(spawn.teammate).match(INVESTIGATOR);
    should(asked.every(request => request.requested !== undefined)).be.true();
    should(store.claims.map(claim => claim.callsign).filter(callsign => POOL.includes(callsign))).be.empty();
    should(store.claims.every(claim => INVESTIGATOR.test(claim.callsign))).be.true();
  });

  it('should give each warden its own next name and keep the sequence in the state', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [suspect('s1'), suspect('s2')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    const names = subject.spawns.map(spawn => spawn.teammate);
    should(names[0]).equal('warden-000001');
    should(new Set(names).size).equal(names.length);
    should(subject.state().investigatorSequence).equal(names.length);
  });

  it('should carry the sequence across restarts through the stored state', async () => {
    // Arrange
    const first = harness({ config: enabled(), fleet: [suspect('s1')] });
    await first.service.run({ force: false });
    const stored = JSON.parse(JSON.stringify(first.state()));
    const second = harness({ config: enabled(), fleet: [suspect('s9')], state: stored });

    // Act
    await second.service.run({ force: false });

    // Assert
    should(first.spawns[0]?.teammate).equal('warden-000001');
    should(second.spawns[0]?.teammate).equal('warden-000002');
  });

  it('should skip a name a live session in the fleet still holds', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1'), holding('old', 'warden-000001'), holding('older', 'warden-000002')],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns[0]?.teammate).equal('warden-000003');
  });

  it('should wrap from ffffff to 000001', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      state: { investigatorSequence: WARDEN_INVESTIGATOR_MAX_SEQUENCE },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns[0]?.teammate).equal('warden-000001');
    should(subject.state().investigatorSequence).equal(1);
  });

  it('should take the next free name and retry once when the name was taken, without striking the account', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      spawn: async (request, call) => {
        if (call === 0) throw new WardenCallsignTakenError(request.teammate ?? '');
        return {
          sessionId: `w${call}`,
          createdAt: at(0),
          agent: request.agent,
          harness: 'claude',
          model: 'glm-5.2',
          modelSource: 'configured',
        };
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.teammate)).deepEqual(['warden-000001', 'warden-000002']);
    should(actual.assignedWardens).deepEqual(['w1']);
    should(subject.state().failover?.strikes ?? {}).deepEqual({});
    should(subject.state().investigatorSequence).equal(2);
    should(journalTypes(subject)).containEql('fleet.warden_callsign_taken');
  });

  it('should not retry a second time when the second name is taken too', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      spawn: async request => {
        throw new WardenCallsignTakenError(request.teammate ?? '');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.length).be.aboveOrEqual(2);
    should(subject.spawns.slice(0, 2).map(spawn => spawn.teammate)).deepEqual(['warden-000001', 'warden-000002']);
  });

  it('should record the investigator on the investigation, the status, the provenance and the journal', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [suspect('s1')] });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.state().investigations?.[0]?.wardenName).equal('warden-000001');
    should(status.investigations?.[0]?.wardenName).equal('warden-000001');
    should([...subject.provenance.values()][0]?.investigator).equal('warden-000001');
    should(subject.journal.find(entry => entry.type === 'fleet.warden_assigned')?.data.investigator).equal(
      'warden-000001',
    );
  });

  it('should name the fleet-triage warden the same way', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'rate_limited', state: { quota: { resetAt: NOW - 60_000 } } })],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns[0]?.teammate).match(INVESTIGATOR);
    should(subject.spawns[0]?.name).equal('Fleet triage');
  });
});

describe('showing a system callsign', () => {
  it('should keep its prefix and uppercase its digits, unlike a first name', () => {
    // Arrange / Act / Assert
    should(displayAgentName('warden-00002a')).equal('warden-00002A');
    should(displayAgentName('mary-jane')).equal('Mary-Jane');
    should(agentSpokenName({ teammate: 'warden-00002a', name: 'Fleet triage' })).equal('warden-00002A');
  });
});

describe("the sweep's daily history", () => {
  it('should show today as a real zero once the daemon has looked', async () => {
    // Arrange
    const subject = harness({ config: enabled() });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(status.history?.map(entry => entry.day)).deepEqual(['2026-07-31']);
    should(status.history?.[0]?.moved).deepEqual({ auto: 0, jev: 0, llm: 0 });
  });

  it('should count what the owner did by hand under the owner', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [suspect('s1')],
      state: {
        lastAnomalies: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'd' }],
      },
    });

    // Act
    await subject.service.leaveAlone('s1', '4h');
    const status = await subject.service.status();

    // Assert
    should(subject.state().actions?.[0]?.actor).equal('owner');
    should(status.history?.at(-1)?.cleared.owner).equal(1);
  });
});
