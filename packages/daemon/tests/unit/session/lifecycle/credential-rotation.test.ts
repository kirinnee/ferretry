import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { NodeSessionCredentialIssuer } from '../../../../src/adapters/session/lifecycle/node-session-credential-issuer.ts';
import { CredentialAgentIdentities } from '../../../../src/lib/agent-tools/policy.ts';
import {
  authenticate,
  isSessionCredential,
  presentToken,
  SESSION_CREDENTIAL_PREFIX,
  secretsMatch,
} from '../../../../src/lib/api/authentication.ts';
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

  async erase(): Promise<void> {
    this.order.push('erase');
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

describe('the prefixed session credential, across a rotation', () => {
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  /** What a pane launched before the prefix holds: 43 base64url characters and nothing in front. */
  const UNPREFIXED = 'u'.repeat(43);

  /** The real issuer and rotation over in-memory stores, read back through the real lookup. */
  function rotating() {
    const order: string[] = [];
    const environment = new MemoryEnvironment(order);
    const hashes = new RecordingHashes(order);
    environment.documents.set(ID, { FY_SESSION_BOARD_CAPABILITY: UNPREFIXED });
    let stored = sha256(UNPREFIXED);
    const subject = new SessionCredentialRotation({
      credentials: new NodeSessionCredentialIssuer(),
      environment,
      hashes: {
        record: async (id, hash) => {
          await hashes.record(id, hash);
          stored = hash;
        },
        erase: async () => {},
      },
    });
    const identities = new CredentialAgentIdentities(
      { snapshot: async () => [{ id: ID, name: null, active: true, sessionCapabilityHash: stored }] },
      sha256,
      secretsMatch,
    );
    const directory = { resolve: async (capability: string) => await identities.resolve(capability) };
    const asBearer = async (value: string) =>
      authenticate(
        { admin: 'admin-secret', sessions: directory },
        await presentToken({ admin: 'admin-secret', sessions: directory }, value),
      );
    return { environment, subject, identities, asBearer };
  }

  it('should keep the value a running pane holds working on its header until that pane is relaunched', async () => {
    // Arrange
    const { identities, asBearer } = rotating();

    // Act / Assert — accepted where it always was; never as a bearer, which needs the prefix.
    should(await identities.resolve(UNPREFIXED)).deepEqual({ sessionId: ID });
    should(await asBearer(UNPREFIXED)).deepEqual({ kind: 'anonymous' });
  });

  it('should mint a prefixed credential at the launch, and the old value then names nothing', async () => {
    // Arrange
    const { environment, subject, identities, asBearer } = rotating();

    // Act
    const hash = await subject.rotate(ID);
    const minted = environment.documents.get(ID)?.FY_SESSION_BOARD_CAPABILITY ?? '';

    // Assert — the prefix and 43 base64url characters, hashed whole.
    should(isSessionCredential(minted)).be.true();
    should(minted).startWith(SESSION_CREDENTIAL_PREFIX);
    should(hash).equal(sha256(minted));
    should(await identities.resolve(minted)).deepEqual({ sessionId: ID });
    should(await asBearer(minted)).deepEqual({ kind: 'authenticated', tokenClass: 'session', sessionId: ID });
    should(await identities.resolve(UNPREFIXED)).be.undefined();
  });
});

describe('SessionCredentialRotation cutting a session off', () => {
  it('should refuse to cut off over a hash store that cannot mark a session, touching nothing', async () => {
    // Arrange — a store that can only erase: a revoke on it would not stick, so it is refused outright.
    const { order, environment, subject } = harness();
    environment.documents.set(ID, { FY_SESSION_BOARD_CAPABILITY: 'pane-capability' });

    // Act / Assert
    await should(subject.cutOff(ID)).be.rejectedWith(/cannot mark a session cut off/u);
    should(order).be.empty();
    should(environment.documents.get(ID)).deepEqual({ FY_SESSION_BOARD_CAPABILITY: 'pane-capability' });
  });

  it('should mark it first, then drop the plaintext, and refuse every rotation until restored', async () => {
    // Arrange
    const order: string[] = [];
    const environment = new MemoryEnvironment(order);
    const marked = new Set<SessionId>();
    const hashes: SessionCapabilityHashStore = {
      record: async () => {
        order.push('hash');
      },
      erase: async () => {
        order.push('erase');
      },
      cutOff: async id => {
        order.push('cut-off');
        marked.add(id);
      },
      isCutOff: async id => marked.has(id),
      restore: async id => {
        marked.delete(id);
      },
    };
    const subject = new SessionCredentialRotation({ credentials: { issue: () => FRESH }, environment, hashes });
    environment.documents.set(ID, { FY_SESSION_BOARD_CAPABILITY: 'pane-capability', FY_SESSION_MODE: 'auto' });

    // Act
    await subject.cutOff(ID);
    const refused = await subject.rotate(ID).catch((error: unknown) => error);
    await subject.restore(ID);
    const rotated = await subject.rotate(ID);

    // Assert
    should(order.slice(0, 2)).deepEqual(['cut-off', 'environment']);
    should((refused as Error).name).equal('SessionCredentialRevokedError');
    should(rotated).equal(FRESH.hash);
  });
});
