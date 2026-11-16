import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ConversationId,
  ConversationIdSchema,
  type ConversationLeaseDisk,
  ConversationLeaseHeldError,
  ConversationLeaseRecordSchema,
  ConversationLeaseStore,
  type HistoryHarness,
} from '../../../../../contract/conversation-lease.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import {
  ConversationLeases,
  type ConversationLeaseSessions,
  registryLeaseSessions,
} from '../../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The daemon's conversation leases over the contract's own store, on an in-memory disk: the rules are the contract's, and
 * what is proved here is WHEN the daemon claims, for whom, and what it answers about a session it holds a lease for.
 */

const DAEMON_PID = 4000;
const WRAPPER_PID = 5000;
const S = parseSessionId('mw7bp88g-50e00159');
const T = parseSessionId('mw7bp89h-61f11260');
const C = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');
const D = ConversationIdSchema.parse('1c8f5d2b-2e3a-4d4c-8b9f-8a7e6d5c4b32');
const NOW = new Date('2026-11-16T10:00:00.000Z');

class MemoryDisk implements ConversationLeaseDisk {
  readonly files = new Map<string, string>();
  /** The pids that are running, with the start each reports. */
  readonly running = new Map<number, number>([[DAEMON_PID, 1]]);

  async exclusive<T>(_harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    return await work();
  }
  async read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined> {
    return this.files.get(`${harness}/${conversation}`);
  }
  async write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void> {
    this.files.set(`${harness}/${conversation}`, text);
  }
  async remove(harness: HistoryHarness, conversation: ConversationId): Promise<void> {
    this.files.delete(`${harness}/${conversation}`);
  }
  async list(harness: HistoryHarness): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter(key => key.startsWith(`${harness}/`))
      .map(key => key.slice(harness.length + 1));
  }
  async startOf(pid: number): Promise<number | undefined> {
    return this.running.get(pid);
  }
  holder(harness: HistoryHarness, conversation: ConversationId) {
    const text = this.files.get(`${harness}/${conversation}`);
    return text === undefined ? undefined : ConversationLeaseRecordSchema.parse(JSON.parse(text)).holder;
  }
}

class FakeSessions implements ConversationLeaseSessions {
  readonly launches = new Map<string, { harness: HistoryHarness; runtime?: string }>();
  /** A state document, `'unreadable'` for a read that rejects, or absent for a record that is gone. */
  readonly states = new Map<string, unknown>();
  launchOf(id: SessionId) {
    return this.launches.get(id);
  }
  async readState(id: SessionId): Promise<unknown> {
    const state = this.states.get(id);
    if (state === 'unreadable') throw new Error('disk fault');
    return state;
  }
}

function built() {
  const disk = new MemoryDisk();
  const sessions = new FakeSessions();
  const store = new ConversationLeaseStore(disk, () => NOW);
  const leases = new ConversationLeases(store, sessions, DAEMON_PID);
  const launching = (id: SessionId, status: string = 'running') => {
    sessions.launches.set(id, { harness: 'claude', runtime: 'claude-review' });
    sessions.states.set(id, { id, status });
  };
  return { disk, sessions, store, leases, launching };
}

const resume = (conversation: ConversationId): readonly string[] => ['/opt/fleet/bin/claude', '--resume', conversation];

describe('ConversationLeases.claim', () => {
  it('should lease the conversation a launch resumes to the session, as this daemon, before any pane exists', async () => {
    // Arrange
    const { disk, leases, launching } = built();
    launching(S);

    // Act
    await leases.claim(S, resume(C));

    // Assert
    should(disk.holder('claude', C)).deepEqual({ pid: DAEMON_PID, start: 1, session: S, runtime: 'claude-review' });
  });

  it('should lease the conversation a fresh Claude session writes (`--session-id`), and a Codex resume in its own pool', async () => {
    // Arrange
    const { disk, sessions, leases, launching } = built();
    launching(S);
    sessions.launches.set(T, { harness: 'codex' });
    sessions.states.set(T, { id: T, status: 'running' });

    // Act
    await leases.claim(S, ['/opt/fleet/bin/claude', '--session-id', C]);
    await leases.claim(T, ['/opt/fleet/bin/codex', 'resume', D]);

    // Assert — and no runtime is named when the registry has none
    should(disk.holder('claude', C)?.session).equal(S);
    should(disk.holder('codex', D)).deepEqual({ pid: DAEMON_PID, start: 1, session: T });
  });

  it('should claim nothing for a launch whose argv names no conversation', async () => {
    // Arrange
    const { disk, leases, launching } = built();
    launching(S);

    // Act — the executable is never an argument, and a bare resume names nothing
    await leases.claim(S, [C]);
    await leases.claim(S, ['/opt/fleet/bin/claude', '--resume']);

    // Assert
    should(disk.files.size).equal(0);
  });

  it('should claim nothing for a session the registry does not hold, or whose id is not one', async () => {
    // Arrange
    const { disk, leases } = built();

    // Act
    await leases.claim(S, resume(C));
    await leases.claim('../escape', resume(C));

    // Assert
    should(disk.files.size).equal(0);
  });

  it('should refuse a conversation another LIVE session holds, naming it, and leave that lease as it was', async () => {
    // Arrange — S writes C; T (a fork or a move target over S's conversation) asks for it
    const { disk, leases, launching } = built();
    launching(S);
    launching(T);
    await leases.claim(S, resume(C));

    // Act
    const claiming = leases.claim(T, resume(C));

    // Assert
    await should(claiming).rejectedWith(ConversationLeaseHeldError);
    await claiming.catch((error: ConversationLeaseHeldError) => {
      should(error.message).containEql(`being written by session ${S} on claude-review`);
    });
    should(disk.holder('claude', C)?.session).equal(S);
  });

  it('should take the conversation over once the holding session is over, whichever way it ended', async () => {
    // Arrange
    for (const status of ['stopped', 'failed', 'completed']) {
      const { disk, leases, launching } = built();
      launching(S, status);
      launching(T);
      await leases.claim(S, resume(C));

      // Act
      await leases.claim(T, resume(C));

      // Assert
      should(disk.holder('claude', C)?.session).equal(T);
    }
  });

  it('should take the conversation over from a session whose record is gone, but let the daemon pid decide when it cannot be read', async () => {
    // Arrange — S wrote C and its record was removed; U wrote D and its record cannot be read; this daemon is running
    const { disk, sessions, leases, launching } = built();
    const U = parseSessionId('mw7bp8ab-72a22371');
    launching(S);
    launching(T);
    launching(U);
    await leases.claim(S, resume(C));
    await leases.claim(U, resume(D));
    sessions.states.delete(S);
    sessions.states.set(U, 'unreadable');

    // Act
    await leases.claim(T, resume(C));
    const readingD = leases.claim(T, resume(D));

    // Assert — gone: taken over; unreadable: the holder's pid (this running daemon) still holds it
    should(disk.holder('claude', C)?.session).equal(T);
    await should(readingD).rejectedWith(ConversationLeaseHeldError);
    should(disk.holder('claude', D)?.session).equal(U);
  });

  it('should read a state that is not a document, or a session id that is not one, as no live writer', async () => {
    // Arrange — a lease naming a holder session this daemon cannot parse, and one whose state is a bare value
    const { disk, sessions, leases, launching } = built();
    launching(S);
    launching(T);
    await leases.claim(S, resume(C));
    sessions.states.set(S, 'garbage');
    disk.files.set(
      `claude/${D}`,
      `${JSON.stringify({ v: 1, harness: 'claude', conversation: D, holder: { pid: DAEMON_PID, session: '../x' }, since: NOW.toISOString() })}\n`,
    );

    // Act
    await leases.claim(T, resume(C));
    const alive = leases.claim(T, resume(D));

    // Assert — a malformed state is over; an unparseable holder session leaves the running pid to decide
    should(disk.holder('claude', C)?.session).equal(T);
    await should(alive).rejectedWith(ConversationLeaseHeldError);
  });
});

describe('ConversationLeases and a session that renews its own lease', () => {
  it("should not let S's own wrapper renewal satisfy a claim made for ANOTHER session over S's conversation", async () => {
    // Arrange — S's daemon claim, then S's wrapper (an agent inside S running `claude --resume C`) renews it as S
    const { disk, store, leases, launching } = built();
    launching(S);
    launching(T);
    await leases.claim(S, resume(C));
    disk.running.set(WRAPPER_PID, 7);
    const renewed = await store.claim(
      { harness: 'claude', conversation: C, holder: { pid: WRAPPER_PID, session: S } },
      async () => 'live',
    );

    // Act — the daemon now claims C for T
    const claiming = leases.claim(T, resume(C));

    // Assert
    should(renewed).containDeep({ kind: 'claimed', decision: 'renew' });
    await should(claiming).rejectedWith(ConversationLeaseHeldError);
    should(disk.holder('claude', C)).deepEqual({ pid: WRAPPER_PID, start: 7, session: S });
  });

  it("should not let S's agent take ANOTHER live session's conversation through the renewal that S's own lease allows", async () => {
    // Arrange — T writes D; an agent inside S, carrying S's session id, runs `claude --resume D`
    const { disk, store, leases, launching } = built();
    launching(S);
    launching(T);
    await leases.claim(T, resume(D));
    disk.running.set(WRAPPER_PID, 7);

    // Act — the wrapper's claim, exactly as `fy history claim` makes it for a process that carries FY_SESSION_ID=S
    const outcome = await store.claim(
      { harness: 'claude', conversation: D, holder: { pid: WRAPPER_PID, session: S } },
      async session => (session === T ? 'live' : 'unknown'),
    );

    // Assert — refused, and T still holds D
    should(outcome.kind).equal('held');
    should(disk.holder('claude', D)?.session).equal(T);
  });
});

describe('ConversationLeases.release', () => {
  it("should free every lease the session holds and no other session's", async () => {
    // Arrange
    const { disk, leases, launching } = built();
    launching(S);
    launching(T);
    await leases.claim(S, resume(C));
    await leases.claim(T, resume(D));

    // Act
    await leases.release(S);

    // Assert
    should(disk.holder('claude', C)).be.undefined();
    should(disk.holder('claude', D)?.session).equal(T);
  });
});

describe('registryLeaseSessions', () => {
  const registry = {
    get: (id: string) =>
      id === 'fern'
        ? { harness: 'claude-code' as const, runtime: 'claude-review' }
        : id === 'plain'
          ? { harness: 'codex' as const }
          : undefined,
  };
  const sessions = registryLeaseSessions(registry, async () => ({ status: 'running' }));

  it("should name a ferret's history pool and runtime from its registry record", () => {
    // Act
    const fern = sessions.launchOf(ferretId('fern') as unknown as SessionId);
    const plain = sessions.launchOf(ferretId('plain') as unknown as SessionId);

    // Assert
    should(fern).deepEqual({ harness: 'claude', runtime: 'claude-review' });
    should(plain).deepEqual({ harness: 'codex' });
  });

  it('should know nothing of a session the registry does not hold, and read its state from the store', async () => {
    // Act
    const ghost = sessions.launchOf(ferretId('ghost') as unknown as SessionId);
    const state = await sessions.readState(S);

    // Assert
    should(ghost).be.undefined();
    should(state).deepEqual({ status: 'running' });
  });
});
