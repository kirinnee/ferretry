import { describe, it } from 'bun:test';
import should from 'should';
import { SessionCredentialRotation } from '../../../../src/lib/session/lifecycle/credential-rotation.ts';
import type {
  SessionCapabilityHashStore,
  SessionCredential,
  SessionEnvironmentStore,
} from '../../../../src/lib/session/lifecycle/types.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const FRESH: SessionCredential = { capability: 'fresh-capability', hash: 'f'.repeat(64) };

/** An in-memory environment store that journals each write into the shared order. */
class MemoryEnvironment implements SessionEnvironmentStore {
  readonly documents = new Map<SessionId, Readonly<Record<string, string>>>();
  writeFailure?: unknown;

  constructor(private readonly order: string[]) {}

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.order.push('environment');
    this.documents.set(id, environment);
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    return this.documents.get(id) ?? {};
  }
}

class RecordingHashes implements SessionCapabilityHashStore {
  readonly recorded: Array<readonly [SessionId, string]> = [];

  constructor(private readonly order: string[]) {}

  async record(id: SessionId, hash: string): Promise<void> {
    this.order.push('hash');
    this.recorded.push([id, hash]);
  }
}

function harness() {
  const order: string[] = [];
  const environment = new MemoryEnvironment(order);
  const hashes = new RecordingHashes(order);
  const subject = new SessionCredentialRotation({ credentials: { issue: () => FRESH }, environment, hashes });
  return { order, environment, hashes, subject };
}

describe('SessionCredentialRotation', () => {
  it('should replace the credential, keep every other variable, and record the hash after the plaintext', async () => {
    // Arrange — the environment a previous pane was launched with.
    const { order, environment, hashes, subject } = harness();
    environment.documents.set(ID, { FY_SESSION_BOARD_CAPABILITY: 'previous-capability', FY_SESSION_MODE: 'auto' });

    // Act
    const actual = await subject.rotate(ID);

    // Assert
    should(actual).equal(FRESH.hash);
    should(environment.documents.get(ID)).deepEqual({
      FY_SESSION_BOARD_CAPABILITY: FRESH.capability,
      FY_SESSION_MODE: 'auto',
    });
    should(hashes.recorded).deepEqual([[ID, FRESH.hash]]);
    // The plaintext is durable before any hash names it — the creation rule, kept for every launch.
    should(order).deepEqual(['environment', 'hash']);
  });

  it('should give a session that held no credential its first one', async () => {
    // Arrange
    const { environment, subject } = harness();

    // Act
    await subject.rotate(ID);

    // Assert
    should(environment.documents.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: FRESH.capability });
  });

  it('should record no hash when the plaintext could not be made durable', async () => {
    // Arrange
    const { environment, hashes, subject } = harness();
    environment.writeFailure = new Error('environment rename failed');

    // Act + Assert — a hash with no plaintext behind it would admit a pane holding nothing.
    await should(subject.rotate(ID)).be.rejectedWith('environment rename failed');
    should(hashes.recorded).deepEqual([]);
  });
});
