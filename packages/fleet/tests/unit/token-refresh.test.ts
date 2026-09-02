/**
 * The renewal gate and the service that owns it.
 *
 * Two properties are load-bearing and both are proved here rather than documented: a still-valid
 * credential is NEVER fired at, because a rotating refresh token is spent by being used; and
 * `renewed` is concluded from the credential's own re-read expiry, never from the port having run.
 *
 * No test spawns a harness, and no fake ever hands the service credential material — the sentinel
 * below is the material a real store would be holding, and the last test proves none of it can reach
 * anything the service produces.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type {
  CredentialCloneOutcome,
  CredentialReading,
  FleetCredentialStore,
  FleetIdentity,
  FleetIdentityMember,
  FleetIdentityMemberStatus,
} from '../../src/lib/identity.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import type {
  FleetTokenRefreshAttempt,
  FleetTokenRefreshPort,
  FleetTokenRefreshSettled,
  FleetTokenRefreshTarget,
} from '../../src/lib/token-refresh.ts';
import { FleetTokenRefreshService, planTokenRefresh } from '../../src/lib/token-refresh.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** What a real store would be holding while it answers with a classification. Never legitimate output. */
const SENTINEL = 'sk-ferretry-not-a-real-token-0123456789';

const VALID: CredentialReading = { state: 'valid', expiresAt: NOW + HOUR };
const REFRESHABLE: CredentialReading = { state: 'refreshable', expiresAt: NOW - HOUR };
const MISSING: CredentialReading = { state: 'missing' };
const UNREADABLE: CredentialReading = { state: 'unreadable', reason: 'the keychain read timed out' };

const member = (overrides: Partial<FleetIdentityMember> = {}): FleetIdentityMember => ({
  accountId: ID_ONE,
  wrapper: '/fleet/bin/claude-kirin',
  home: '/fleet/homes/claude-kirin',
  displayName: 'Claude Kirin',
  mode: 'interactive',
  available: true,
  unavailableReason: null,
  ...overrides,
});

const identity = (overrides: Partial<FleetIdentity> = {}): FleetIdentity => ({
  key: 'claude:kirin',
  kind: 'claude',
  identity: 'kirin',
  auth: 'oauth',
  declared: true,
  members: [member()],
  ...overrides,
});

const status = (
  reading: CredentialReading,
  overrides: Partial<FleetIdentityMember> = {},
): FleetIdentityMemberStatus => ({
  member: member(overrides),
  reading,
});

/**
 * A store that answers with classifications and holds the material.
 *
 * Readings advance one pass per {@link RecordingRefreshPort} run, which is how "the harness rewrote
 * its own store" becomes visible without anything here writing a credential.
 */
class ScriptedCredentialStore implements FleetCredentialStore {
  readonly reads: string[] = [];
  private pass = 0;
  /** The material this store would hold. Nothing may ever ask for it, and nothing does. */
  readonly material = SENTINEL;

  constructor(
    private readonly passes: readonly Readonly<Record<string, CredentialReading>>[],
    private readonly failure?: Error,
  ) {}

  nextPass(): void {
    this.pass = Math.min(this.pass + 1, this.passes.length - 1);
  }

  read(_kind: HarnessKind, target: FleetIdentityMember): Promise<CredentialReading> {
    this.reads.push(target.accountId);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.passes[this.pass]?.[target.accountId] ?? MISSING);
  }

  clone(): Promise<CredentialCloneOutcome> {
    throw new Error('a renewal never clones anything');
  }
}

/** A port that records the target it was handed, and never launches a harness. */
class RecordingRefreshPort implements FleetTokenRefreshPort {
  readonly targets: FleetTokenRefreshTarget[] = [];
  readonly settledAnswers: boolean[] = [];

  constructor(
    private readonly attempt: FleetTokenRefreshAttempt = { outcome: 'ran' },
    private readonly store?: ScriptedCredentialStore,
    private readonly askSettled = false,
  ) {}

  async refresh(target: FleetTokenRefreshTarget, settled: FleetTokenRefreshSettled): Promise<FleetTokenRefreshAttempt> {
    this.targets.push(target);
    // A real renewal makes the harness rewrite its own store; advancing the script is how that shows.
    this.store?.nextPass();
    if (this.askSettled) this.settledAnswers.push(await settled());
    return this.attempt;
  }
}

/**
 * A port that fails the way a broken spawn does: by throwing.
 *
 * It counts anyway. Two failures carry the same sentence, so a test that a failed renewal did not
 * leave its identity permanently joined cannot be written against the RESULT — both callers would
 * hold that identical failure either way. The count is the only thing that distinguishes them.
 */
class ThrowingRefreshPort implements FleetTokenRefreshPort {
  attempts = 0;

  refresh(): Promise<FleetTokenRefreshAttempt> {
    this.attempts += 1;
    return Promise.reject(new Error('spawn claude ENOENT'));
  }
}

/**
 * A port that stays inside the refresh until it is told to leave.
 *
 * A real renewal spawns a child and waits on it, so the interesting window — two callers both past
 * their own credential read, neither finished — only exists while something is in flight. Holding the
 * port open is how a test occupies it deterministically, with no timer and no sleep.
 */
class BlockingRefreshPort implements FleetTokenRefreshPort {
  readonly targets: FleetTokenRefreshTarget[] = [];
  #entered: (() => void) | undefined;
  readonly entered = new Promise<void>(resolve => {
    this.#entered = resolve;
  });
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>(resolve => {
    this.#release = resolve;
  });

  constructor(private readonly store?: ScriptedCredentialStore) {}

  release(): void {
    this.#release?.();
  }

  async refresh(target: FleetTokenRefreshTarget): Promise<FleetTokenRefreshAttempt> {
    this.targets.push(target);
    this.#entered?.();
    await this.#gate;
    this.store?.nextPass();
    return { outcome: 'ran' };
  }
}

const build = (store: ScriptedCredentialStore, port: FleetTokenRefreshPort): FleetTokenRefreshService =>
  new FleetTokenRefreshService({ store, port });

describe('planTokenRefresh', () => {
  it('should refuse an identity that authenticates with a key, which has no provider token at all', () => {
    // Act
    const actual = planTokenRefresh(identity({ auth: 'api-key' }), [status(MISSING)]);

    // Assert
    should(actual).match({ kind: 'skip', status: 'not-required' });
  });

  it('should refuse to fire when any home still holds a valid token, because a rotation is spent by being used', () => {
    // Arrange — the destructive case: one lane is fine, another could renew. Renewing would burn a
    // single-use refresh token for an identity that needed nothing.
    const members = [status(VALID, { accountId: ID_ONE }), status(REFRESHABLE, { accountId: ID_TWO })];

    // Act
    const actual = planTokenRefresh(identity(), members);

    // Assert
    should(actual).match({ kind: 'skip', status: 'not-expired' });
  });

  it('should choose the renewable home whose access token expired last', () => {
    // Arrange
    const members = [
      status({ state: 'refreshable', expiresAt: NOW - 2 * HOUR }, { accountId: ID_ONE }),
      status({ state: 'refreshable', expiresAt: NOW - HOUR }, { accountId: ID_TWO }),
    ];

    // Act
    const actual = planTokenRefresh(identity(), members);

    // Assert
    should(actual).match({ kind: 'renew', member: { accountId: ID_TWO } });
  });

  it('should settle a tie on the account id, so the home it reports on does not move between runs', () => {
    // Arrange
    const members = [status(REFRESHABLE, { accountId: ID_TWO }), status(REFRESHABLE, { accountId: ID_ONE })];

    // Act
    const actual = planTokenRefresh(identity(), members);

    // Assert
    should(actual).match({ kind: 'renew', member: { accountId: ID_ONE } });
  });

  it('should report that nothing here can renew itself when no home holds a refresh token', () => {
    // Act
    const actual = planTokenRefresh(identity(), [status(MISSING)]);

    // Assert
    should(actual).match({ kind: 'skip', status: 'not-renewable' });
  });

  it('should refuse to decide when the homes that are not renewable could not be read', () => {
    // Act
    const actual = planTokenRefresh(identity(), [status(UNREADABLE, { accountId: ID_ONE }), status(MISSING)]);

    // Assert
    should(actual).match({ kind: 'skip', status: 'indeterminate' });
    should((actual as { reason: string }).reason).match(/1 of 2/u);
  });
});

describe('FleetTokenRefreshService', () => {
  it('should renew an expired credential and report it from the credential, not from the call', async () => {
    // Arrange — expired with a way back, and the harness rewrites its own store when it runs.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).deepEqual([{ accountId: ID_ONE, kind: 'claude', home: '/fleet/homes/claude-kirin' }]);
    should(actual).match({ identity: 'claude:kirin', accountId: ID_ONE, status: 'renewed', ran: true });
  });

  it('should never reach the port for a credential that is still valid', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort();

    // Act
    const actual = await build(store, port).renew(identity(), [status(VALID)]);

    // Assert — nothing spawned, nothing read: the plan refused before any credential was touched.
    should(port.targets).deepEqual([]);
    should(store.reads).deepEqual([]);
    should(actual).match({ status: 'not-expired', ran: false });
  });

  it('should refuse to fire when the chosen home was renewed between the survey and now', async () => {
    // Arrange — the survey said renewable; the home's own credential now says otherwise. Firing here
    // would spend the refresh token that renewal just minted.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort();

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).deepEqual([]);
    should(actual).match({ accountId: ID_ONE, status: 'not-expired', ran: false });
  });

  it('should refuse to fire when the chosen home lost its refresh token between the survey and now', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: MISSING }]);
    const port = new RecordingRefreshPort();

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).deepEqual([]);
    should(actual).match({ status: 'not-renewable', ran: false });
  });

  it('should refuse to fire when the chosen home could not be read a second time', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: UNREADABLE }]);
    const port = new RecordingRefreshPort();

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).deepEqual([]);
    should(actual).match({ status: 'indeterminate', ran: false });
  });

  it('should treat a store that throws as a home it could not read, never as one with no credential', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }], new Error('the keychain is locked'));
    const port = new RecordingRefreshPort();

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).deepEqual([]);
    should(actual).match({ status: 'indeterminate', ran: false });
  });

  it('should report a host without the harness installed as unavailable, with nothing having moved', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }]);
    const port = new RecordingRefreshPort({ outcome: 'unavailable', reason: 'the "claude" CLI is not on this host' });

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(actual).match({ status: 'unavailable', ran: false, reason: /not on this host/u });
  });

  it('should treat a port failure as a survey that is now stale, because the child may already have spoken', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }]);
    const port = new RecordingRefreshPort({ outcome: 'error', reason: 'the app server closed its input' });

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(actual).match({ status: 'failed', ran: true, reason: 'the app server closed its input' });
  });

  it("should carry a thrown port failure's own sentence rather than inventing one", async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }]);

    // Act
    const actual = await build(store, new ThrowingRefreshPort()).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(actual).match({ status: 'failed', ran: true, reason: 'spawn claude ENOENT' });
  });

  it('should call a renewal that ran and changed nothing a failure, not a success', async () => {
    // Arrange — this is the trap: the port ran and would have exited zero. The credential decides.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.targets).have.length(1);
    should(actual).match({ status: 'failed', ran: true, reason: /still expired/u });
  });

  it('should say a spent refresh token now needs a login, rather than reporting a bare failure', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: MISSING }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(actual).match({ status: 'failed', ran: true, reason: /needs a login/u });
  });

  it('should report an unreadable home after a renewal as unknown rather than as renewed or failed', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: UNREADABLE }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(actual).match({ status: 'indeterminate', ran: true });
  });

  it('should answer the stop condition from the credential, so a long path can end the moment it lands', async () => {
    // Arrange — the port asks whether the credential has settled; by then the script has advanced.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store, true);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert
    should(port.settledAnswers).deepEqual([true]);
    should(actual).match({ status: 'renewed' });
  });

  it('should never let credential material reach the port, the result, or a reason', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store, true);

    // Act
    const actual = await build(store, port).renew(identity(), [status(REFRESHABLE)]);

    // Assert — the target carries a home and nothing else that could hold a credential, and every
    // sentence this produced is free of the material the store was holding all along.
    should(Object.keys(port.targets[0] ?? {}).sort()).deepEqual(['accountId', 'home', 'kind']);
    should(JSON.stringify({ actual, targets: port.targets })).not.containEql(store.material);
  });

  it('should fire once for two callers racing one identity, and answer both from that one renewal', async () => {
    // Arrange — the window the fresh read cannot close: both callers read `refreshable` before either
    // spawned. A rotating refresh token is spent by whoever uses it first, so a second spawn would fire
    // at a home whose token the first already consumed and report a working identity as broken.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: VALID }]);
    const port = new BlockingRefreshPort(store);
    const service = build(store, port);

    // Act — the second caller arrives while the first is inside the port.
    const first = service.renew(identity(), [status(REFRESHABLE)]);
    await port.entered;
    const second = service.renew(identity(), [status(REFRESHABLE)]);
    port.release();
    const [one, two] = await Promise.all([first, second]);

    // Assert — one spawn, and both callers hold the same answer. `ran` is true for the joiner too:
    // its survey is stale either way, which is the only thing `ran` exists to say.
    should(port.targets).have.length(1);
    should(one).match({ status: 'renewed', ran: true });
    should(two).deepEqual(one);
  });

  it('should not join two different identities, because they do not share a credential', async () => {
    // Arrange — the dedupe is keyed on the identity, not on the service. Two provider accounts renewing
    // at once is the ordinary case for a fleet, and serialising them would make a fleet renewal take as
    // long as the sum of its harness spawns for no safety at all.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: REFRESHABLE, [ID_TWO]: REFRESHABLE },
      { [ID_ONE]: VALID, [ID_TWO]: VALID },
    ]);
    const port = new BlockingRefreshPort(store);
    const service = build(store, port);
    const other = identity({ key: 'claude:jazelle', identity: 'jazelle', members: [member({ accountId: ID_TWO })] });

    // Act
    const first = service.renew(identity(), [status(REFRESHABLE)]);
    await port.entered;
    const second = service.renew(other, [status(REFRESHABLE, { accountId: ID_TWO })]);
    port.release();
    await Promise.all([first, second]);

    // Assert — two spawns, one per identity.
    should(port.targets.map(target => target.accountId)).deepEqual([ID_ONE, ID_TWO]);
  });

  it('should release the identity when its renewal settles, so a later caller renews rather than joining', async () => {
    // Arrange — a stale entry would be worse than no dedupe at all: every later renewal of that
    // identity would resolve instantly with an old verdict and never fire.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }, { [ID_ONE]: VALID }]);
    const port = new RecordingRefreshPort({ outcome: 'ran' }, store);
    const service = build(store, port);

    // Act — sequential, so the first is fully settled before the second is asked for.
    const first = await service.renew(identity(), [status(REFRESHABLE)]);
    const second = await service.renew(identity(), [status(REFRESHABLE)]);

    // Assert — the second was decided on its own terms: the credential is valid now, so the plan
    // refused it. That refusal is only reachable if the first call's entry is gone.
    should(first).match({ status: 'renewed' });
    should(second).match({ status: 'not-expired', ran: false });
  });

  it('should release the identity even when its renewal failed, so a failure is not a permanent join', async () => {
    // Arrange — `finally`, not `then`. An entry left behind by a failed renewal would answer every
    // later caller with that same failure, for the lifetime of the process.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: REFRESHABLE }]);
    const port = new ThrowingRefreshPort();
    const service = build(store, port);

    // Act
    const first = await service.renew(identity(), [status(REFRESHABLE)]);
    const second = await service.renew(identity(), [status(REFRESHABLE)]);

    // Assert — the COUNT is the assertion. Both results carry the same sentence whether the second
    // call fired or merely inherited the first one's answer, so only the port can tell them apart.
    should(port.attempts).equal(2);
    should(first).match({ status: 'failed', reason: 'spawn claude ENOENT' });
    should(second).match({ status: 'failed', reason: 'spawn claude ENOENT' });
  });
});
