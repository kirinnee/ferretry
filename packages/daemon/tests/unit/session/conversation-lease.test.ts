import { describe, it } from 'bun:test';
import {
  type ConversationHolderStanding,
  type ConversationLeaseClaim,
  ConversationLeaseHeldError,
  type ConversationLeaseRecord,
  type ConversationLeaseStore,
} from '@ferretry/fleet';
import should from 'should';
import {
  type ConversationLeaseDocuments,
  ConversationLeases,
  LeaseClaimingLaunchWrapper,
  LeaseReleasingSessionExits,
} from '../../../src/lib/session/conversation-lease.ts';
import type { SessionExitObservation } from '../../../src/lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../src/lib/session/health/service.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

const SESSION = 'ms8-abcd1234';
const HOLDER = 'ms8-holder01';
const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const AGENT = '/state/fleet/bin/claude-review';

function lease(session: string): ConversationLeaseRecord {
  return {
    v: 1,
    harness: 'claude',
    conversation: CONVERSATION,
    holder: { pid: 1, session, runtime: 'claude-review' },
    since: '2026-10-13T14:02:00.000Z',
  };
}

/** Answers every claim with a scripted outcome and records what it was asked. */
class FakeStore implements ConversationLeaseStore {
  readonly claims: ConversationLeaseClaim[] = [];
  readonly released: string[] = [];
  standings: ConversationHolderStanding[] = [];
  held = false;

  async claim(
    claim: ConversationLeaseClaim,
    standing: (session: string) => Promise<ConversationHolderStanding>,
  ): ReturnType<ConversationLeaseStore['claim']> {
    this.claims.push(claim);
    this.standings.push(await standing(HOLDER));
    return this.held
      ? { kind: 'held', lease: lease(HOLDER) }
      : { kind: 'claimed', decision: 'create', lease: lease(claim.holder.session ?? '') };
  }

  async releaseSession(session: string): Promise<readonly string[]> {
    this.released.push(session);
    return [CONVERSATION];
  }
}

/** Session documents by id; a function value is a read that fails. */
class FakeDocuments implements ConversationLeaseDocuments {
  readonly configs = new Map<string, unknown>([[SESSION, { harness: 'claude', agent: 'claude-review' }]]);
  readonly states = new Map<string, unknown>();
  failState = false;

  async readConfig(id: string): Promise<unknown> {
    const value = this.configs.get(id);
    if (value instanceof Error) throw value;
    return value;
  }

  async readState(id: string): Promise<unknown> {
    if (this.failState) throw new Error('unreadable');
    return this.states.get(id);
  }
}

function subject(): {
  readonly store: FakeStore;
  readonly documents: FakeDocuments;
  readonly leases: ConversationLeases;
} {
  const store = new FakeStore();
  const documents = new FakeDocuments();
  return { store, documents, leases: new ConversationLeases(store, documents, 4242) };
}

describe('ConversationLeases', () => {
  it('should claim the conversation a launch names as this daemon and the session, on its runtime', async () => {
    // Arrange
    const { store, leases } = subject();

    // Act
    await leases.claim(SESSION, [AGENT, '--session-id', CONVERSATION]);

    // Assert
    should(store.claims).eql([
      {
        harness: 'claude',
        conversation: CONVERSATION,
        holder: { pid: 4242, session: SESSION, runtime: 'claude-review' },
      },
    ]);
  });

  it('should read a holder session as over once it is terminal or gone, and live while it runs', async () => {
    // Arrange
    const { store, documents, leases } = subject();
    const command = [AGENT, '--resume', CONVERSATION];

    // Act
    await leases.claim(SESSION, command);
    documents.states.set(HOLDER, { status: 'completed' });
    await leases.claim(SESSION, command);
    documents.states.set(HOLDER, { status: 'waiting' });
    await leases.claim(SESSION, command);
    documents.states.set(HOLDER, 'not a document');
    await leases.claim(SESSION, command);

    // Assert
    should(store.standings).eql(['over', 'over', 'live', 'over']);
  });

  it('should leave the pid to decide when the holder record cannot be read', async () => {
    // Arrange
    const { store, documents, leases } = subject();
    documents.failState = true;

    // Act
    await leases.claim(SESSION, [AGENT, '--resume', CONVERSATION]);

    // Assert
    should(store.standings).eql(['unknown']);
  });

  it('should leave a holder that is not a session id to the pid', async () => {
    // Arrange
    const store = new FakeStore();
    const documents = new FakeDocuments();
    const leases = new ConversationLeases(
      {
        claim: async (claim, standing) => {
          store.standings.push(await standing('../not-a-session'));
          return { kind: 'claimed', decision: 'create', lease: lease(claim.holder.session ?? '') };
        },
        releaseSession: async () => [],
      },
      documents,
      1,
    );

    // Act
    await leases.claim(SESSION, [AGENT, '--resume', CONVERSATION]);

    // Assert
    should(store.standings).eql(['unknown']);
  });

  it('should refuse naming the holder when another live writer has the conversation', async () => {
    // Arrange
    const { store, leases } = subject();
    store.held = true;

    // Act
    const claiming = leases.claim(SESSION, [AGENT, '--resume', CONVERSATION]);

    // Assert
    await should(claiming).be.rejectedWith(ConversationLeaseHeldError);
    await should(leases.claim(SESSION, [AGENT, '--resume', CONVERSATION])).be.rejectedWith(
      new RegExp(`being written by session ${HOLDER} on claude-review`, 'u'),
    );
  });

  it('should claim nothing a launch cannot name or a session document cannot place', async () => {
    // Arrange
    const { store, documents, leases } = subject();
    documents.configs.set('ms8-noharness', { agent: 'x' });
    documents.configs.set('ms8-broken0001', new Error('unreadable'));
    documents.configs.set('ms8-noagent001', { harness: 'codex', agent: '' });

    // Act
    await leases.claim('../escape', [AGENT, '--resume', CONVERSATION]);
    await leases.claim('ms8-noharness', [AGENT, '--resume', CONVERSATION]);
    await leases.claim('ms8-broken0001', [AGENT, '--resume', CONVERSATION]);
    await leases.claim(SESSION, [AGENT, '--continue']);
    // The executable is never read as an argument, even when it looks like one.
    await leases.claim(SESSION, ['--resume', CONVERSATION]);
    await leases.claim('ms8-noagent001', [AGENT, 'resume', CONVERSATION]);

    // Assert
    should(store.claims).eql([
      { harness: 'codex', conversation: CONVERSATION, holder: { pid: 4242, session: 'ms8-noagent001' } },
    ]);
  });

  it('should release every conversation a session holds', async () => {
    // Arrange
    const { store, leases } = subject();

    // Act
    await leases.release(SESSION);

    // Assert
    should(store.released).eql([SESSION]);
  });
});

const OBSERVATION: SessionExitObservation = {
  id: SESSION,
  status: 'running',
  registration: { daemonId: 'd', sessionId: SESSION, tmuxSession: 't', paneId: '%1', pid: 1, processStartTicks: 1 },
  exit: { kind: 'exited', exitStatus: 0 },
};
const TRANSITION = {
  status: 'completed',
  health: 'idle',
  reason: 'the agent exited on its own (exit status 0)',
} as const;

describe('LeaseReleasingSessionExits', () => {
  /** Every survey the wrapped port was handed: the decorator must pass the check's own walk through. */
  const surveys: unknown[] = [];

  function exits(settled: boolean): SessionExitPort {
    return {
      observe: async survey => {
        surveys.push(survey);
        return [OBSERVATION];
      },
      settle: async () => settled,
    };
  }

  it('should release what an exited session held once its exit settles', async () => {
    // Arrange
    const released: string[] = [];
    const subject = new LeaseReleasingSessionExits(exits(true), { release: async id => void released.push(id) });

    // Act
    const survey = [{ id: parseSessionId(SESSION), journalLost: false }];
    const observed = await subject.observe(survey);
    const settled = await subject.settle(OBSERVATION, TRANSITION);

    // Assert
    should(observed).eql([OBSERVATION]);
    should(surveys.at(-1)).equal(survey);
    should(settled).be.true();
    should(released).eql([SESSION]);
  });

  it('should release nothing for an exit that did not settle', async () => {
    // Arrange
    const released: string[] = [];
    const subject = new LeaseReleasingSessionExits(exits(false), { release: async id => void released.push(id) });

    // Act
    const settled = await subject.settle(OBSERVATION, TRANSITION);

    // Assert
    should(settled).be.false();
    should(released).be.empty();
  });

  it('should keep the settle when the release fails', async () => {
    // Arrange
    const subject = new LeaseReleasingSessionExits(exits(true), {
      release: async () => {
        throw new Error('disk full');
      },
    });

    // Act
    const settled = await subject.settle(OBSERVATION, TRANSITION);

    // Assert
    should(settled).be.true();
  });
});

describe('LeaseClaimingLaunchWrapper', () => {
  it('should claim the relaunch argv, then hand it to the wrapper it decorates', async () => {
    // Arrange
    const order: string[] = [];
    const subject = new LeaseClaimingLaunchWrapper(
      { claim: async (id, command) => void order.push(`claim:${id}:${command.join(' ')}`) },
      { command: async (_id, command) => ['scope', ...command] },
    );

    // Act
    const command = await subject.command(SESSION, [AGENT, '--resume', CONVERSATION]);

    // Assert
    should(order).eql([`claim:${SESSION}:${AGENT} --resume ${CONVERSATION}`]);
    should(command).eql(['scope', AGENT, '--resume', CONVERSATION]);
  });

  it('should pass the argv through unchanged with nothing to decorate, and refuse when the claim does', async () => {
    // Arrange
    const passing = new LeaseClaimingLaunchWrapper({ claim: async () => undefined });
    const refusing = new LeaseClaimingLaunchWrapper({
      claim: async () => {
        throw new ConversationLeaseHeldError(lease(HOLDER));
      },
    });

    // Act
    const command = await passing.command(SESSION, [AGENT]);
    const refused = refusing.command(SESSION, [AGENT]);

    // Assert
    should(command).eql([AGENT]);
    await should(refused).be.rejectedWith(ConversationLeaseHeldError);
  });
});
