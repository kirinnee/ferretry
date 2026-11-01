import { describe, it } from 'bun:test';
import { SYSTEM_CALLSIGN_MAX_SEQUENCE, type SessionView, type StartSessionRequest } from '@ferretry/protocol';
import should from 'should';
import { FileSystemCallsignCounters } from '../../../src/adapters/names/index.ts';
import type { FileSystemPort } from '../../../src/lib/index.ts';
import {
  claimStartName,
  type NameAllocationRequest,
  NameAllocator,
  type NameClaim,
  type NameClaimAttempt,
  type NameClaimStore,
} from '../../../src/lib/names/index.ts';
import { SessionControlError, type SessionControlSubsystem } from '../../../src/lib/runtime/mounts/session-control.ts';
import { withSystemCallsign } from '../../../src/lib/runtime/mounts/system-session-control.ts';
import { issuerOver, MemoryCounters } from './system-callsigns-support.ts';
import { DAEMON_START } from '../../../src/lib/api/state-homes.ts';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const POOL = ['ada', 'bea', 'cy', 'dot', 'eve'];

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

  async release(): Promise<void> {}
}

function memoryFiles(): { readonly files: FileSystemPort; readonly text: Map<string, string> } {
  const text = new Map<string, string>();
  const files = {
    readText: async (path: string) => text.get(path),
    writeTextAtomic: async (path: string, value: string) => {
      text.set(path, value);
    },
  } as unknown as FileSystemPort;
  return { files, text };
}

/** A control that claims the name exactly as the daemon's start does, over a real allocator. */
function faithfulControl() {
  const store = new MemoryClaimStore();
  const allocator = new NameAllocator(store, { nextIndex: () => 0 }, POOL);
  const claims = {
    allocate: async (request: NameAllocationRequest) => await allocator.allocate(request),
    release: async () => {},
  };
  const started: StartSessionRequest[] = [];
  const control = {
    start: async (request: StartSessionRequest) => {
      const claimed = await claimStartName(claims, `s${started.length}`, { teammate: request.teammate }, NOW);
      if (!claimed.ok) throw new SessionControlError('callsign_taken', 'taken');
      started.push(request);
      return { config: { teammate: request.teammate } } as unknown as SessionView;
    },
    stop: async () => ({}) as SessionView,
    recover: async () => undefined,
  } as unknown as SessionControlSubsystem;
  return { control, started, store };
}

const request = (name: string): StartSessionRequest =>
  ({ agent: 'claude', mode: 'auto', prompt: 'p', name, cwd: '/', boardAccess: 'none' }) as StartSessionRequest;

describe('issuing system callsigns', () => {
  it('should count on from one for each prefix on its own', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = [await subject.next('learning'), await subject.next('learning'), await subject.next('pack')];

    // Assert
    should(names).deepEqual(['learning-000001', 'learning-000002', 'pack-000001']);
  });

  it('should step past ids the fleet still holds, and only those of its own prefix', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters(), () => [
      'learning-000001',
      'learning-000002',
      'pack-000001',
      'ada',
    ]);

    // Act
    const learning = await subject.next('learning');
    const pack = await subject.next('pack');

    // Assert
    should(learning).equal('learning-000003');
    should(pack).equal('pack-000002');
  });

  it('should wrap from ffffff to 000001', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters({ pack: SYSTEM_CALLSIGN_MAX_SEQUENCE }));

    // Act + Assert
    should(await subject.next('pack')).equal('pack-000001');
  });

  it('should never give two concurrent starts the same id', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = await Promise.all([subject.next('learning'), subject.next('learning'), subject.next('learning')]);

    // Assert
    should(new Set(names).size).equal(3);
  });
});

describe('the persisted counters', () => {
  it('should carry on after a restart, through the file', async () => {
    // Arrange
    const { files, text } = memoryFiles();
    const first = issuerOver(new FileSystemCallsignCounters('/state/system-callsigns.json', files));
    await first.next('learning');
    await first.next('learning');
    await first.next('pack');

    // Act
    const second = issuerOver(new FileSystemCallsignCounters('/state/system-callsigns.json', files));

    // Assert
    should(JSON.parse(text.get('/state/system-callsigns.json') ?? '{}')).deepEqual({ learning: 2, pack: 1 });
    should(await second.next('learning')).equal('learning-000003');
    should(await second.next('pack')).equal('pack-000002');
  });

  it('should start again from nothing when the file is damaged or says nonsense', async () => {
    // Arrange
    const { files, text } = memoryFiles();
    const counters = new FileSystemCallsignCounters('/c.json', files);

    // Act + Assert
    should(await counters.read()).deepEqual({});
    text.set('/c.json', '{not json');
    should(await counters.read()).deepEqual({});
    text.set('/c.json', JSON.stringify({ learning: -4, pack: 'x', other: 9 }));
    should(await counters.read()).deepEqual({});
    text.set('/c.json', JSON.stringify({ learning: 7 }));
    should(await counters.read()).deepEqual({ learning: 7 });
  });
});

describe('starting a system session', () => {
  it('should start under its own callsign and leave the human name pool untouched', async () => {
    // Arrange
    const { control, started, store } = faithfulControl();
    const learning = withSystemCallsign(control, issuerOver(), 'learning');
    const pack = withSystemCallsign(control, issuerOver(), 'pack');

    // Act
    await learning.start(request('Learning Miner'), 'a', 'ignored', undefined, DAEMON_START);
    await learning.start(request('Lesson Scan'), 'b', 'ignored', undefined, DAEMON_START);
    await pack.start(request('Clean up'), 'c', 'ignored', undefined, DAEMON_START);

    // Assert
    should(started.map(entry => entry.teammate)).deepEqual(['learning-000001', 'learning-000002', 'pack-000001']);
    should(store.claims.map(claim => claim.callsign).filter(callsign => POOL.includes(callsign))).be.empty();
    should(store.claims).have.length(3);
  });

  it('should send a payload that describes the request it actually started', async () => {
    // Arrange
    const payloads: string[] = [];
    const control = {
      start: async (_request: StartSessionRequest, _id: string, payload: string) => {
        payloads.push(payload);
        return {} as SessionView;
      },
    } as unknown as SessionControlSubsystem;

    // Act
    await withSystemCallsign(control, issuerOver(), 'pack').start(
      request('Clean up'),
      'a',
      'stale',
      undefined,
      DAEMON_START,
    );

    // Assert
    should(JSON.parse(payloads[0] ?? '{}')).containEql({ teammate: 'pack-000001', name: 'Clean up' });
  });

  it('should take the next id and retry once when the id was taken, and not a second time', async () => {
    // Arrange
    const seen: string[] = [];
    const refusing = (times: number) =>
      ({
        start: async (asked: StartSessionRequest) => {
          seen.push(asked.teammate ?? '');
          if (seen.length <= times) throw new SessionControlError('callsign_taken', 'taken');
          return {} as SessionView;
        },
      }) as unknown as SessionControlSubsystem;

    // Act
    await withSystemCallsign(refusing(1), issuerOver(), 'learning').start(
      request('x'),
      'a',
      '',
      undefined,
      DAEMON_START,
    );
    const second = await withSystemCallsign(refusing(99), issuerOver(), 'learning')
      .start(request('x'), 'b', '', undefined, DAEMON_START)
      .catch((error: unknown) => error);

    // Assert
    should(seen.slice(0, 2)).deepEqual(['learning-000001', 'learning-000002']);
    should(seen).have.length(4);
    should(second).be.instanceOf(SessionControlError);
  });

  it('should let any other failure through without retrying', async () => {
    // Arrange
    let calls = 0;
    const control = {
      start: async () => {
        calls += 1;
        throw new SessionControlError('limit_reached', 'no');
      },
    } as unknown as SessionControlSubsystem;

    // Act
    const actual = await withSystemCallsign(control, issuerOver(), 'pack')
      .start(request('x'), 'a', '', undefined, DAEMON_START)
      .catch((error: unknown) => error);

    // Assert
    should(calls).equal(1);
    should((actual as SessionControlError).failure).equal('limit_reached');
  });
});
