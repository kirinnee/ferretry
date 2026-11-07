import { describe, it } from 'bun:test';
import should from 'should';
import {
  agentSpokenName,
  CALLSIGN_WINDOW_MS,
  claimStartName,
  displayAgentName,
  type NameAllocationRequest,
  type NameAllocationResult,
  type SessionNameClaims,
  type SessionNames,
  type SessionRenamedEntry,
  SessionRenameError,
  SessionRenameService,
  sessionNameClaim,
} from '../../../src/lib/names/index.ts';

const CREATED = '2026-10-01T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const NOW = new Date('2026-10-16T12:00:00.000Z');

/** A claim surface that answers each allocation from a script and records what it was asked. */
class ScriptedClaims implements SessionNameClaims {
  readonly asked: NameAllocationRequest[] = [];
  readonly released: Array<readonly [string, string]> = [];

  constructor(private readonly answer: (request: NameAllocationRequest) => NameAllocationResult) {}

  async allocate(request: NameAllocationRequest): Promise<NameAllocationResult> {
    this.asked.push(request);
    return this.answer(request);
  }

  async release(callsign: string, ownerId: string): Promise<void> {
    this.released.push([callsign, ownerId]);
    if (callsign === 'unreleasable') throw new Error('the ledger is gone');
  }
}

const granted =
  (callsign?: string) =>
  (request: NameAllocationRequest): NameAllocationResult => ({
    ok: true,
    source: request.requested === undefined ? 'automatic' : 'requested',
    claim: {
      callsign: callsign ?? request.requested?.trim().toLowerCase() ?? 'hadi',
      ownerId: request.ownerId,
      claimedAtMs: request.nowMs,
      expiresAtMs: request.nowMs + 1,
    },
  });

const refused =
  (code: 'callsign_taken' | 'pool_exhausted' | 'claim_store_failed' | 'invalid_callsign' | 'random_source_failed') =>
  (): NameAllocationResult => ({ ok: false, error: { code, message: `refused: ${code}` } });

/** Fails a case whose rename was meant to be refused and was not. */
const expectedRefusal = (): never => {
  throw new Error('expected the rename to be refused');
};

/** One session's documents in memory, so a rename has something to read and write. */
class MemorySession {
  names: SessionNames | undefined;
  readonly writes: Array<readonly [SessionNames, string]> = [];
  readonly journal: SessionRenamedEntry[] = [];
  writeFailure: Error | undefined;

  constructor(names: SessionNames | undefined) {
    this.names = names;
  }

  service(claims: SessionNameClaims): SessionRenameService {
    return new SessionRenameService({
      current: async () => this.names,
      write: async (_id, next, at) => {
        if (this.writeFailure !== undefined) throw this.writeFailure;
        this.writes.push([next, at]);
        this.names = next;
      },
      journal: async (_id, entry) => {
        this.journal.push(entry);
      },
      claims,
      now: () => NOW,
    });
  }
}

describe('sessionNameClaim', () => {
  it('should hold a live session name for as long as the session exists', () => {
    // Act
    const running = sessionNameClaim({ id: 's1', teammate: 'Hadi', createdAt: CREATED, status: 'running' });
    const unindexed = sessionNameClaim({ id: 's2', teammate: 'marin', createdAt: CREATED });

    // Assert
    should(running).deepEqual({
      callsign: 'hadi',
      ownerId: 's1',
      claimedAtMs: CREATED_MS,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    should(unindexed?.expiresAtMs).equal(Number.MAX_SAFE_INTEGER);
  });

  it('should let an ended session keep its name for the window after it last moved', () => {
    // Arrange
    const updatedAt = '2026-10-10T00:00:00.000Z';

    // Act
    const stopped = sessionNameClaim({ id: 's1', teammate: 'hadi', createdAt: CREATED, updatedAt, status: 'stopped' });
    const undated = sessionNameClaim({ id: 's1', teammate: 'hadi', createdAt: CREATED, status: 'completed' });
    const shortWindow = sessionNameClaim({ id: 's1', teammate: 'hadi', createdAt: CREATED, status: 'failed' }, 10);

    // Assert
    should(stopped?.expiresAtMs).equal(Date.parse(updatedAt) + CALLSIGN_WINDOW_MS);
    should(undated?.expiresAtMs).equal(CREATED_MS + CALLSIGN_WINDOW_MS);
    should(shortWindow?.expiresAtMs).equal(CREATED_MS + 10);
  });

  it('should claim nothing for a session with no name, a malformed name, or no creation instant', () => {
    // Act / Assert
    should(sessionNameClaim({ id: 's1', createdAt: CREATED })).be.undefined();
    should(sessionNameClaim({ id: 's1', teammate: '[Hadi]', createdAt: CREATED })).be.undefined();
    should(sessionNameClaim({ id: 's1', teammate: 'hadi' })).be.undefined();
  });
});

describe('claimStartName', () => {
  it('should give an unnamed start a name from the pool', async () => {
    // Arrange
    const claims = new ScriptedClaims(granted('jacinta'));

    // Act
    const outcome = await claimStartName(claims, 's1', {}, 5);

    // Assert
    should(outcome).deepEqual({ ok: true, callsign: 'jacinta' });
    should(claims.asked).deepEqual([{ ownerId: 's1', nowMs: 5 }]);
  });

  it('should start an agent unnamed rather than refuse it when no automatic name can be had', async () => {
    // Arrange
    const claims = new ScriptedClaims(refused('pool_exhausted'));

    // Act
    const outcome = await claimStartName(claims, 's1', {}, 5);

    // Assert
    should(outcome).deepEqual({ ok: true });
  });

  it('should claim a requested name, passing the fallback only when the caller allowed one', async () => {
    // Arrange
    const claims = new ScriptedClaims(granted());

    // Act
    const strict = await claimStartName(claims, 's1', { teammate: 'Marin' }, 5);
    const lenient = await claimStartName(claims, 's2', { teammate: 'Marin', teammateFallback: true }, 6);

    // Assert
    should(strict).deepEqual({ ok: true, callsign: 'marin' });
    should(lenient).deepEqual({ ok: true, callsign: 'marin' });
    should(claims.asked).deepEqual([
      { ownerId: 's1', nowMs: 5, requested: 'Marin' },
      { ownerId: 's2', nowMs: 6, requested: 'Marin', fallback: true },
    ]);
  });

  it('should hand a refused requested name back to the caller', async () => {
    // Arrange
    const claims = new ScriptedClaims(refused('callsign_taken'));

    // Act
    const outcome = await claimStartName(claims, 's1', { teammate: 'marin' }, 5);

    // Assert
    should(outcome).deepEqual({ ok: false, error: { code: 'callsign_taken', message: 'refused: callsign_taken' } });
  });
});

describe('agent display names', () => {
  it('should title-case every hyphen segment', () => {
    should(displayAgentName('hadi')).equal('Hadi');
    should(displayAgentName('mary-jane')).equal('Mary-Jane');
  });

  it('should speak of an agent by its first name, and by its title only when it has none', () => {
    should(agentSpokenName({ teammate: 'hadi', name: 'Fix the build' })).equal('Hadi');
    should(agentSpokenName({ name: 'Fix the build' })).equal('Fix the build');
    should(agentSpokenName({ teammate: '[odd]', name: 'Fix the build' })).equal('Fix the build');
  });
});

describe('SessionRenameService', () => {
  it('should claim a new first name, rewrite the matching title prefix, and journal both sides', async () => {
    // Arrange
    const session = new MemorySession({ teammate: 'hadi', name: '[Hadi] Fix the build' });
    const claims = new ScriptedClaims(granted());

    // Act
    await session.service(claims).rename('s1', { teammate: 'Marin' }, 'admin-cli');

    // Assert
    should(claims.asked).deepEqual([{ ownerId: 's1', nowMs: NOW.getTime(), requested: 'Marin' }]);
    should(session.writes).deepEqual([[{ teammate: 'marin', name: '[Marin] Fix the build' }, NOW.toISOString()]]);
    should(session.journal).deepEqual([
      {
        actor: 'admin-cli',
        from: { teammate: 'hadi', name: '[Hadi] Fix the build' },
        to: { teammate: 'marin', name: '[Marin] Fix the build' },
      },
    ]);
  });

  it('should leave a title alone that does not open with the old first name', async () => {
    // Arrange
    const session = new MemorySession({ teammate: 'hadi', name: 'Fix the build' });

    // Act
    await session.service(new ScriptedClaims(granted())).rename('s1', { teammate: 'marin' }, 'admin-ui');

    // Assert
    should(session.names).deepEqual({ teammate: 'marin', name: 'Fix the build' });
  });

  it('should name an unnamed agent and keep its title', async () => {
    // Arrange
    const session = new MemorySession({ name: 'Fix the build' });

    // Act
    await session.service(new ScriptedClaims(granted())).rename('s1', { teammate: 'marin' }, 'admin-ui');

    // Assert
    should(session.names).deepEqual({ teammate: 'marin', name: 'Fix the build' });
  });

  it('should change only the title, without claiming anything, when no first name is given', async () => {
    // Arrange
    const session = new MemorySession({ teammate: 'hadi', name: '[Hadi] Fix the build' });
    const unnamed = new MemorySession({ name: 'Old' });
    const claims = new ScriptedClaims(granted());

    // Act
    await session.service(claims).rename('s1', { name: '  Ship\tthe   release ' }, 'peer:s1');
    await unnamed.service(claims).rename('s2', { name: 'New' }, 'peer:s2');

    // Assert
    should(claims.asked).be.empty();
    should(session.names).deepEqual({ teammate: 'hadi', name: 'Ship the release' });
    should(unnamed.names).deepEqual({ name: 'New' });
  });

  it('should treat renaming an agent to its own name, in any case, as no claim at all', async () => {
    // Arrange
    const session = new MemorySession({ teammate: 'hadi', name: 'Fix' });
    const claims = new ScriptedClaims(granted());

    // Act
    await session.service(claims).rename('s1', { teammate: 'HADI', name: 'Fixed' }, 'admin-ui');

    // Assert
    should(claims.asked).be.empty();
    should(session.names).deepEqual({ teammate: 'hadi', name: 'Fixed' });
  });

  it('should refuse a name another agent holds, in plain words, and write nothing', async () => {
    // Arrange
    const session = new MemorySession({ teammate: 'hadi', name: 'Fix' });

    // Act
    const failure = await session
      .service(new ScriptedClaims(refused('callsign_taken')))
      .rename('s1', { teammate: 'mary-jane' }, 'admin-ui')
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionRenameError);
    should((failure as SessionRenameError).failure).equal('taken');
    should((failure as Error).message).equal(
      'another agent on this machine is already called Mary-Jane — choose a different name',
    );
    should(session.writes).be.empty();
    should(session.journal).be.empty();
  });

  it('should restate every other allocation refusal in the rename taxonomy', async () => {
    // Arrange
    const codes = ['invalid_callsign', 'claim_store_failed', 'pool_exhausted', 'random_source_failed'] as const;

    // Act
    const failures = await Promise.all(
      codes.map(
        async code =>
          await new MemorySession({ name: 'Fix' })
            .service(new ScriptedClaims(refused(code)))
            .rename('s1', { teammate: 'marin' }, 'admin-ui')
            .then(expectedRefusal, (error: unknown) => error as SessionRenameError),
      ),
    );

    // Assert
    should(failures.map(failure => [failure.failure, failure.message])).deepEqual([
      ['invalid', 'refused: invalid_callsign'],
      ['unavailable', 'refused: claim_store_failed'],
      ['failed', 'refused: pool_exhausted'],
      ['failed', 'refused: random_source_failed'],
    ]);
  });

  it('should refuse to detach a session from its parent, before reading anything', async () => {
    // Arrange
    const session = new MemorySession(undefined);

    // Act
    const failure = await session
      .service(new ScriptedClaims(granted()))
      .rename('s1', { clearParent: true }, 'admin-ui')
      .then(expectedRefusal, (error: unknown) => error as SessionRenameError);

    // Assert
    should(failure.failure).equal('unsupported');
  });

  it('should answer an absent session and a title with nothing printable', async () => {
    // Arrange
    const claims = new ScriptedClaims(granted());

    // Act
    const absent = await new MemorySession(undefined)
      .service(claims)
      .rename('ghost', { name: 'X' }, 'admin-ui')
      .then(expectedRefusal, (error: unknown) => error as SessionRenameError);
    const blank = await new MemorySession({ name: 'Fix' })
      .service(claims)
      .rename('s1', { name: '\u0007' }, 'admin-ui')
      .then(expectedRefusal, (error: unknown) => error as SessionRenameError);

    // Assert
    should([absent.failure, absent.message]).deepEqual(['not_found', 'no session ghost']);
    should(blank.failure).equal('invalid');
  });

  it('should give back a freshly claimed name when the write fails, and keep an old one', async () => {
    // Arrange
    const renamed = new MemorySession({ teammate: 'hadi', name: 'Fix' });
    renamed.writeFailure = new Error('disk full');
    const retitled = new MemorySession({ teammate: 'hadi', name: 'Fix' });
    retitled.writeFailure = new Error('disk full');
    const stuck = new MemorySession({ name: 'Fix' });
    stuck.writeFailure = new Error('disk full');
    const odd = new MemorySession({ name: 'Fix' });
    odd.writeFailure = 'not an error' as unknown as Error;
    const claims = new ScriptedClaims(granted());

    // Act
    const failures = [
      await renamed
        .service(claims)
        .rename('s1', { teammate: 'marin' }, 'admin-ui')
        .then(expectedRefusal, (error: unknown) => error as SessionRenameError),
      await retitled
        .service(claims)
        .rename('s2', { name: 'Other' }, 'admin-ui')
        .then(expectedRefusal, (error: unknown) => error as SessionRenameError),
      await stuck
        .service(claims)
        .rename('s3', { teammate: 'unreleasable' }, 'admin-ui')
        .then(expectedRefusal, (error: unknown) => error as SessionRenameError),
      await odd
        .service(claims)
        .rename('s4', { name: 'Other' }, 'admin-ui')
        .then(expectedRefusal, (error: unknown) => error as SessionRenameError),
    ];

    // Assert
    should(failures.map(failure => [failure.failure, failure.message])).deepEqual([
      ['failed', 'disk full'],
      ['failed', 'disk full'],
      ['failed', 'disk full'],
      ['failed', 'not an error'],
    ]);
    // Only the names this rename claimed go back; `hadi` was never taken by it.
    should(claims.released).deepEqual([
      ['marin', 's1'],
      ['unreleasable', 's3'],
    ]);
  });
});
