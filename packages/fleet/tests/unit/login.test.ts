import { describe, it } from 'bun:test';
import should from 'should';
import type {
  CredentialCloneOutcome,
  CredentialReading,
  FleetCredentialStore,
  FleetIdentity,
  FleetIdentityMember,
} from '../../src/lib/identity.ts';
import { FleetIdentityService, UnknownIdentityAccountError } from '../../src/lib/identity.ts';
import type { FleetLoginOutcome, FleetLoginResult, FleetLoginTarget } from '../../src/lib/login.ts';
import { FleetLoginService } from '../../src/lib/login.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import type { FleetTokenRefreshResult, FleetTokenRenewal } from '../../src/lib/token-refresh.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';
const ID_THREE = '00000000-0000-4000-8000-000000000003';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const VALID: CredentialReading = { state: 'valid', expiresAt: NOW + HOUR };
/** An expired access token with a refresh token beside it — what a home holds BEFORE a sign-in. */
const REFRESHABLE: CredentialReading = { state: 'refreshable', expiresAt: NOW - HOUR };

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

/**
 * A credential store whose readings can change between surveys, so the re-read after an interactive
 * login is exercised as it really behaves. No test touches a real credential.
 *
 * A SUCCESSFUL CLONE CHANGES WHAT THE TARGET READS, exactly as the real store does — that is what
 * copying a credential into a home means. A fake whose writes were invisible would make the service's
 * proof that a named account holds a credential fail for a reason no host has, and would make an
 * assertion that the proof works impossible to distinguish from an assertion that the fake is inert.
 */
class ScriptedCredentialStore implements FleetCredentialStore {
  readonly clones: Array<{ donor: string; target: string }> = [];
  readonly written = new Map<string, CredentialReading>();
  private pass = 0;

  constructor(
    private readonly passes: readonly Readonly<Record<string, CredentialReading>>[],
    private readonly cloneOutcomes: Readonly<Record<string, CredentialCloneOutcome>> = {},
    /**
     * Homes whose writes report success and change nothing, which is not a hypothetical: a harness
     * writes credentials by temp-file-and-rename, and on macOS Claude derives its keychain item name
     * from the home path — so a copy can land somewhere that is not this account's credential and
     * still exit zero.
     */
    private readonly losesWrites: readonly string[] = [],
  ) {}

  /** Advance to the next scripted pass; the last one repeats forever. */
  nextPass(): void {
    this.pass = Math.min(this.pass + 1, this.passes.length - 1);
    // A login writes into one home; the script says which. Copies made before it are history.
    this.written.clear();
  }

  read(_kind: HarnessKind, target: FleetIdentityMember): Promise<CredentialReading> {
    return Promise.resolve(this.#read(target.accountId));
  }

  clone(_kind: HarnessKind, donor: FleetIdentityMember, target: FleetIdentityMember): Promise<CredentialCloneOutcome> {
    this.clones.push({ donor: donor.accountId, target: target.accountId });
    const outcome = this.cloneOutcomes[target.accountId] ?? { ok: true };
    if (outcome.ok && !this.losesWrites.includes(target.accountId)) {
      this.written.set(target.accountId, this.#read(donor.accountId));
    }
    return Promise.resolve(outcome);
  }

  #read(accountId: string): CredentialReading {
    return this.written.get(accountId) ?? this.passes[this.pass]?.[accountId] ?? { state: 'missing' };
  }
}

/** A login port that records what it was asked to launch and never spawns anything. */
class RecordingLoginPort {
  readonly launched: FleetLoginTarget[] = [];

  constructor(
    private readonly outcome: FleetLoginOutcome = { status: 'logged-in' },
    private readonly store?: ScriptedCredentialStore,
  ) {}

  login(target: FleetLoginTarget): Promise<FleetLoginOutcome> {
    this.launched.push(target);
    // A real login writes a credential; advancing the script is how that becomes visible.
    this.store?.nextPass();
    return Promise.resolve(this.outcome);
  }
}

const statusesOf = (results: readonly FleetLoginResult[]): Record<string, string> =>
  Object.fromEntries(results.map(result => [result.accountId, result.status]));

const build = (store: ScriptedCredentialStore, port: RecordingLoginPort): FleetLoginService =>
  new FleetLoginService({ identities: new FleetIdentityService(store), loginPort: port });

describe('FleetLoginService', () => {
  const twoLanes = identity({
    members: [member({ accountId: ID_ONE }), member({ accountId: ID_TWO, mode: 'auto' })],
  });

  it('should copy one credential across an identity instead of asking for a second approval', async () => {
    // Arrange — this is the capability: one usable credential, one sibling without.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }]);
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(port.launched).deepEqual([]);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'synced' });
  });

  it('should do nothing at all when every home already holds a usable credential', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: VALID }]);
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(store.clones).deepEqual([]);
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'usable' });
  });

  it('should ask for exactly one approval and then fan the fresh credential out', async () => {
    // Arrange — nothing usable anywhere, then the login writes a credential into the launched home.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert — one browser approval covered both lanes.
    should(port.launched).have.length(1);
    should(port.launched[0]?.accountId).equal(ID_ONE);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'logged-in', [ID_TWO]: 'synced' });
  });

  it('should launch the interactive lane, not whichever wrapper is listed first', async () => {
    // Arrange
    const identityWithAutoFirst = identity({
      members: [member({ accountId: ID_ONE, mode: 'auto' }), member({ accountId: ID_TWO, mode: 'interactive' })],
    });
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: VALID },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    await build(store, port).login({ identities: [identityWithAutoFirst], mode: 'full' });

    // Assert
    should(port.launched[0]?.accountId).equal(ID_TWO);
  });

  it('should report every lane failed when the login itself failed', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } }]);
    const port = new RecordingLoginPort({ status: 'failed', message: 'the wrapper is not installed' });

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'failed', [ID_TWO]: 'failed' });
    should(actual[0]?.message).equal('the wrapper is not installed');
  });

  it('should treat a login port that throws as a failure rather than crashing the pass', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' } }]);
    const subject = new FleetLoginService({
      identities: new FleetIdentityService(store),
      loginPort: {
        login: () => Promise.reject(new Error('the terminal was closed')),
      },
    });

    // Act
    const actual = await subject.login({ identities: [identity()], mode: 'full' });

    // Assert
    should(actual).deepEqual([
      { accountId: ID_ONE, identity: 'claude:kirin', status: 'failed', message: 'the terminal was closed' },
    ]);
  });

  it('should report a non-Error thrown by the login port with its own text', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' } }]);
    const subject = new FleetLoginService({
      identities: new FleetIdentityService(store),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a port may throw anything
      loginPort: { login: () => Promise.reject('cancelled') },
    });

    // Act
    const actual = await subject.login({ identities: [identity()], mode: 'full' });

    // Assert
    should(actual[0]?.message).equal('cancelled');
  });

  it('should call a login that left no usable credential a failure, not a success', async () => {
    // Arrange — the provider page may have been closed halfway through.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' } }]);
    const port = new RecordingLoginPort({ status: 'logged-in' });

    // Act
    const actual = await build(store, port).login({ identities: [identity()], mode: 'full' });

    // Assert — the lane that ran gets its own sentence: it names the account, says the credential is
    // not in its own home, and names the wrapper to run by hand. A row every member shared said
    // "this identity", which names nobody and suggests nothing to do.
    should(actual[0]?.status).equal('failed');
    should(actual[0]?.message).containEql(ID_ONE);
    should(actual[0]?.message).match(/left no credential in its own home/u);
    should(actual[0]?.message).containEql('/fleet/bin/claude-kirin');
  });

  it('should give a sibling the identity-wide sentence rather than the lane that ran', async () => {
    // Arrange — nothing usable anywhere and the login writes nothing.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } }]);

    // Act
    const actual = await build(store, new RecordingLoginPort({ status: 'logged-in' })).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — ID_TWO ran, so it owns the specific sentence; ID_ONE was not asked about and is told
    // the identity-wide fact rather than being handed somebody else's wrapper to go and run.
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'failed', [ID_TWO]: 'failed' });
    should(actual[0]?.message).equal('the login finished but this identity still has no usable credential');
    should(actual[1]?.message).containEql(ID_TWO);
  });

  it('should report logged-in when the approval left the launched home usable and no sibling needed it', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' } }, { [ID_ONE]: VALID }]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({ identities: [identity()], mode: 'full' });

    // Assert
    should(actual).deepEqual([{ accountId: ID_ONE, identity: 'claude:kirin', status: 'logged-in' }]);
  });

  /**
   * THE REPORTED BUG, end to end, in the shape it was observed in.
   *
   * A `reauthenticate` pass on a fleet whose homes held an expired-but-renewable copy. The wrapper
   * was missing, so the login port fell back to the bare harness CLI — launched with no
   * configuration directory, which signs the OPERATOR's own default home in and leaves the account's
   * home exactly as it was. It exited zero, so the pass reported `logged in`, picked the stale copy
   * as the identity's donor, cloned it onto the sibling as `credential copied from this identity`,
   * and `fy fleet health` then correctly reported both lanes as needing a refresh — seconds after a
   * real browser approval.
   *
   * An approval mints an access token, so a home it reached is `valid`. `refreshable` is the state
   * the home was already in, and a token minted seconds ago cannot be expired.
   */
  const staleAfterSignIn = [
    { [ID_ONE]: REFRESHABLE, [ID_TWO]: { state: 'missing' as const } },
    { [ID_ONE]: REFRESHABLE, [ID_TWO]: { state: 'missing' as const } },
  ];

  it('should refuse to call it a login when the sign-in left an expired access token behind', async () => {
    // Arrange
    const store = new ScriptedCredentialStore(staleAfterSignIn);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_ONE],
      mode: 'reauthenticate',
    });

    // Assert — the row a person reads must not claim something no read established.
    should(port.launched).have.length(1);
    should(statusesOf(actual)[ID_ONE]).equal('failed');
    should(actual.find(result => result.accountId === ID_ONE)?.message).containEql('already expired');
    should(actual.find(result => result.accountId === ID_ONE)?.message).containEql(ID_ONE);
  });

  it('should still call it a login when the sign-in left a freshly minted access token', async () => {
    // Arrange — the same pass, distinguished only by what the launched home holds afterwards.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: REFRESHABLE, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_ONE],
      mode: 'reauthenticate',
    });

    // Assert
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'logged-in', [ID_TWO]: 'synced' });
  });

  it('should leave a launched lane that received a copy reporting the copy, not a failure', async () => {
    // Arrange — the driver is a TARGET here, so its `synced` row is honest and must survive.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: VALID },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(port.launched[0]?.accountId).equal(ID_ONE);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'synced', [ID_TWO]: 'usable' });
  });

  it('should never open a browser under sync-only, and say what is still needed', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } }]);
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'sync-only' });

    // Assert
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'login-needed', [ID_TWO]: 'login-needed' });
    should(actual[0]?.message).match(/--sync-only/u);
  });

  it('should still copy credentials under sync-only when a donor exists', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }]);

    // Act
    const actual = await build(store, new RecordingLoginPort()).login({
      identities: [twoLanes],
      mode: 'sync-only',
    });

    // Assert
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)[ID_TWO]).equal('synced');
  });

  it('should report an api-key identity as needing no login, without reading anything', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{}]);
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(store, port).login({
      identities: [identity({ auth: 'api-key' })],
      mode: 'full',
    });

    // Assert
    should(port.launched).deepEqual([]);
    should(actual[0]?.status).equal('not-required');
    should(actual[0]?.message).equal('this account authenticates with a key');
  });

  it('should leave an identity it could not read untouched and report each home is reason', async () => {
    // Arrange — no usable credential and one home unreadable: nothing may be concluded or written.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'unreadable', reason: 'the keychain is locked' }, [ID_TWO]: { state: 'missing' } },
    ]);
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(port.launched).deepEqual([]);
    should(store.clones).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'indeterminate', [ID_TWO]: 'indeterminate' });
    should(actual[0]?.message).equal('the keychain is locked');
    should(actual[1]?.message).match(/refusing to decide/u);
  });

  it('should refuse an unreadable sibling a copy while still syncing the rest', async () => {
    // Arrange
    const three = identity({
      members: [
        member({ accountId: ID_ONE }),
        member({ accountId: ID_TWO, mode: 'auto' }),
        member({ accountId: ID_THREE, mode: 'auto' }),
      ],
    });
    const store = new ScriptedCredentialStore([
      {
        [ID_ONE]: VALID,
        [ID_TWO]: { state: 'missing' },
        [ID_THREE]: { state: 'unreadable', reason: 'the keychain is locked' },
      },
    ]);

    // Act
    const actual = await build(store, new RecordingLoginPort()).login({ identities: [three], mode: 'full' });

    // Assert — the unreadable home was never written to.
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({
      [ID_ONE]: 'usable',
      [ID_TWO]: 'synced',
      [ID_THREE]: 'indeterminate',
    });
  });

  it('should report a failed copy as a failure with the store is reason', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }], {
      [ID_TWO]: { ok: false, reason: 'the target home is read-only' },
    });

    // Act
    const actual = await build(store, new RecordingLoginPort()).login({ identities: [twoLanes], mode: 'full' });

    // Assert
    should(statusesOf(actual)[ID_TWO]).equal('failed');
    should(actual[1]?.message).equal('the target home is read-only');
  });

  it('should skip an account the manifest declares unavailable and say why', async () => {
    // Arrange
    const withUnavailable = identity({
      members: [
        member({ accountId: ID_ONE }),
        member({ accountId: ID_TWO, available: false, unavailableReason: 'the harness is not installed' }),
      ],
    });
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID }]);

    // Act
    const actual = await build(store, new RecordingLoginPort()).login({
      identities: [withUnavailable],
      mode: 'full',
    });

    // Assert
    should(store.clones).deepEqual([]);
    should(actual).deepEqual([
      {
        accountId: ID_TWO,
        identity: 'claude:kirin',
        status: 'unavailable',
        message: 'the harness is not installed',
      },
      { accountId: ID_ONE, identity: 'claude:kirin', status: 'usable' },
    ]);
  });

  it('should report an unavailable account with no stated reason without inventing one', async () => {
    // Arrange — the manifest schema forbids this pairing, so this only guards the renderer's input.
    const withUnavailable = identity({
      members: [member({ accountId: ID_TWO, available: false, unavailableReason: null })],
    });

    // Act
    const actual = await build(new ScriptedCredentialStore([{}]), new RecordingLoginPort()).login({
      identities: [withUnavailable],
      mode: 'full',
    });

    // Assert
    should(actual).deepEqual([{ accountId: ID_TWO, identity: 'claude:kirin', status: 'unavailable' }]);
  });

  it('should produce nothing to launch when every member of an identity is unavailable', async () => {
    // Arrange
    const allUnavailable = identity({
      members: [member({ accountId: ID_ONE, available: false, unavailableReason: 'no harness' })],
    });
    const port = new RecordingLoginPort();

    // Act
    const actual = await build(new ScriptedCredentialStore([{}]), port).login({
      identities: [allUnavailable],
      mode: 'full',
    });

    // Assert
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'unavailable' });
  });

  it('should select the whole identity a named account belongs to', async () => {
    // Arrange
    const other = identity({ key: 'codex:kirin', kind: 'codex', members: [member({ accountId: ID_THREE })] });
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }]);

    // Act — naming one lane must not leave its sibling signed out with nothing said.
    const actual = await build(store, new RecordingLoginPort()).login({
      identities: [twoLanes, other],
      accountIds: [ID_ONE],
      mode: 'full',
    });

    // Assert
    should(Object.keys(statusesOf(actual)).sort()).deepEqual([ID_ONE, ID_TWO].sort());
  });

  it('should treat an empty selection as every identity', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: VALID }]);

    // Act
    const actual = await build(store, new RecordingLoginPort()).login({
      identities: [twoLanes],
      accountIds: [],
      mode: 'full',
    });

    // Assert
    should(actual).have.length(2);
  });

  it('should refuse an account no identity claims', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{}]);

    // Act / Assert
    await build(store, new RecordingLoginPort())
      .login({ identities: [twoLanes], accountIds: [ID_THREE], mode: 'full' })
      .should.be.rejectedWith(UnknownIdentityAccountError);
  });

  it('should carry the harness kind and the home through to the port', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: { state: 'missing' } }, { [ID_ONE]: VALID }]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);
    const codex = identity({
      key: 'codex:kirin',
      kind: 'codex',
      members: [member({ accountId: ID_ONE, wrapper: '/fleet/bin/codex-kirin', home: '/fleet/homes/codex-kirin' })],
    });

    // Act
    await build(store, port).login({ identities: [codex], mode: 'full' });

    // Assert
    should(port.launched[0]).deepEqual({
      accountId: ID_ONE,
      kind: 'codex',
      wrapper: '/fleet/bin/codex-kirin',
      home: '/fleet/homes/codex-kirin',
    });
  });
});

/**
 * The renewal pass.
 *
 * Nothing here decides eligibility — that is the renewal's own gate, proved in `token-refresh.test.ts`
 * — so these fakes report what a renewal did and the tests are about what the login pass does with it.
 */
describe('FleetLoginService with a renewal', () => {
  /** A renewal that reports a scripted result and rewrites the store the way a real one would. */
  class RecordingRenewal implements FleetTokenRenewal {
    readonly asked: string[] = [];

    constructor(
      private readonly result: FleetTokenRefreshResult,
      private readonly store?: ScriptedCredentialStore,
    ) {}

    renew(identityToRenew: FleetIdentity): Promise<FleetTokenRefreshResult> {
      this.asked.push(identityToRenew.key);
      if (this.result.ran) this.store?.nextPass();
      return Promise.resolve(this.result);
    }
  }

  const withRenewal = (
    store: ScriptedCredentialStore,
    port: RecordingLoginPort,
    renewal: FleetTokenRenewal,
  ): FleetLoginService =>
    new FleetLoginService({ identities: new FleetIdentityService(store), loginPort: port, renewal });

  const expired: CredentialReading = { state: 'refreshable', expiresAt: NOW - HOUR };

  it('should renew an expired credential so the sibling receives a live one instead of a spent copy', async () => {
    // Arrange — both lanes expired. Without the renewal this copies an expired credential around and
    // every lane then races to spend the one refresh token it holds a copy of.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: expired, [ID_TWO]: expired },
      { [ID_ONE]: VALID, [ID_TWO]: expired },
    ]);
    const port = new RecordingLoginPort();
    const renewal = new RecordingRenewal(
      { identity: 'claude:kirin', accountId: ID_ONE, status: 'renewed', ran: true },
      store,
    );

    // Act
    const actual = await withRenewal(store, port, renewal).login({
      identities: [identity({ members: [member({ accountId: ID_ONE }), member({ accountId: ID_TWO, mode: 'auto' })] })],
      mode: 'full',
    });

    // Assert — nobody was asked for anything, and the credential that was copied is the renewed one.
    should(renewal.asked).deepEqual(['claude:kirin']);
    should(port.launched).deepEqual([]);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'renewed', [ID_TWO]: 'synced' });
  });

  it('should start nothing at all when the pass was asked not to renew', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: expired }]);
    const renewal = new RecordingRenewal({ identity: 'claude:kirin', status: 'renewed', ran: true });

    // Act
    const actual = await withRenewal(store, new RecordingLoginPort(), renewal).login({
      identities: [identity()],
      mode: 'full',
      refresh: false,
    });

    // Assert
    should(renewal.asked).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable' });
  });

  it('should lend a failed renewal its own sentence to a row that has nothing else to say', async () => {
    // Arrange — the renewal ran and achieved nothing, so the credential is still expired.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: expired }]);
    const renewal = new RecordingRenewal({
      identity: 'claude:kirin',
      accountId: ID_ONE,
      status: 'failed',
      reason: 'the renewal ran and this access token is still expired',
      ran: true,
    });

    // Act
    const actual = await withRenewal(store, new RecordingLoginPort(), renewal).login({
      identities: [identity()],
      mode: 'full',
    });

    // Assert
    should(actual).match([
      { accountId: ID_ONE, status: 'usable', message: 'the renewal ran and this access token is still expired' },
    ]);
  });

  it('should leave a row that already explains itself alone', async () => {
    // Arrange — a spent refresh token leaves the home with nothing, so this identity now needs a human
    // and the pass was told not to ask for one. That row's own message is the one that matters.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: expired }, { [ID_ONE]: { state: 'missing' } }]);
    const renewal = new RecordingRenewal(
      {
        identity: 'claude:kirin',
        accountId: ID_ONE,
        status: 'failed',
        reason: 'the refresh token is gone',
        ran: true,
      },
      store,
    );

    // Act
    const actual = await withRenewal(store, new RecordingLoginPort(), renewal).login({
      identities: [identity()],
      mode: 'sync-only',
    });

    // Assert
    should(actual).match([{ accountId: ID_ONE, status: 'login-needed' }]);
    should(actual[0]?.message).not.equal('the refresh token is gone');
  });
});

/**
 * THE ACCOUNT SOMEBODY NAMES IS THE ACCOUNT THAT ENDS UP AUTHENTICATED.
 *
 * Every test here is about one class of defect: a pass that reports success for an account it did not
 * actually sign in. Two shapes of it shipped, and they compound.
 *
 * The first is that the approval always ran through the identity's INTERACTIVE lane, so signing an
 * auto lane in put the credential in its sibling's home. The second is worse and hides the first: a
 * credential the provider has REVOKED still classifies as `valid` locally — it has an access token and
 * its expiry is in the future — so the cheapest-path pass decided the identity was `complete`, reported
 * every lane `usable`, and never launched anything. `fy fleet health` prints `fy fleet login
 * <accountId>` beside exactly the accounts in that state, and the browser's Sign in button reached the
 * same code, so the one remedy the product offers was the one thing guaranteed not to run.
 *
 * `mode: 'reauthenticate'` is what a named account gets, and the readings below are deliberately the
 * ones a revoked-but-unexpired token produces: every home reads `valid` and every home is wrong.
 */
describe('FleetLoginService signing in the account it was asked about', () => {
  /** ID_ONE is the interactive lane; ID_TWO is the auto lane somebody clicked. */
  const twoLanes = identity({
    members: [member({ accountId: ID_ONE }), member({ accountId: ID_TWO, mode: 'auto' })],
  });

  it('should sign a named account in even though every home reads as usable', async () => {
    // Arrange — what a revoked token looks like from here, and the exact state the old pass called
    // `complete`. The login then rewrites the home it was launched in.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: VALID, [ID_TWO]: VALID },
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: VALID },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — an approval was actually asked for, it ran in the named account's own wrapper, and the
    // fresh credential then reached the sibling too so the approval is not spent twice.
    should(port.launched).have.length(1);
    should(port.launched[0]?.accountId).equal(ID_TWO);
    should(store.clones).deepEqual([{ donor: ID_TWO, target: ID_ONE }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'synced', [ID_TWO]: 'logged-in' });
  });

  it('should report usable and launch nothing for the same homes when no account was named', async () => {
    // Arrange — the SAME store as above. This is the contrast that makes the test above mean something:
    // what changed is the request, not the readings.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: VALID, [ID_TWO]: VALID },
      { [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({ identities: [twoLanes], mode: 'full' });

    // Assert — a whole-fleet pass is still the cheapest one, and still costs nobody an approval.
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'usable' });
  });

  it('should launch the named account is own wrapper, so the credential lands in its own home', async () => {
    // Arrange — nothing usable anywhere. A harness writes its credential into the home of the wrapper
    // that was launched, so which wrapper runs decides which account ends up signed in. ID_TWO is the
    // auto lane, and the pass used to launch ID_ONE for it.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: VALID },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — no copy is needed for the account that was asked about, and its sibling gets one.
    should(port.launched[0]?.accountId).equal(ID_TWO);
    should(port.launched[0]?.home).equal('/fleet/homes/claude-kirin');
    should(store.clones).deepEqual([{ donor: ID_TWO, target: ID_ONE }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'synced', [ID_TWO]: 'logged-in' });
  });

  it('should still launch the interactive lane when a whole-fleet pass named nobody', async () => {
    // Arrange — the preference that remains, for the case it was always about: one approval has to
    // cover the identity, so some lane is chosen and a lane declared interactive is the right guess.
    const autoFirst = identity({
      members: [member({ accountId: ID_ONE, mode: 'auto' }), member({ accountId: ID_TWO, mode: 'interactive' })],
    });
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
      { [ID_ONE]: { state: 'missing' }, [ID_TWO]: VALID },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    await build(store, port).login({ identities: [autoFirst], mode: 'full' });

    // Assert
    should(port.launched[0]?.accountId).equal(ID_TWO);
  });

  it('should report a copy as synced rather than crediting the login that produced nothing', async () => {
    // Arrange — the named lane's own login exits zero and writes NOTHING, which is what a harness
    // whose argv it refused looks like from here. The identity's credential is then copied in from the
    // sibling, so the account does end up holding one.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — `logged-in` here would credit a sign-in that produced nothing AND hide a harness that
    // is failing silently. Observed by running the command: it read `logged in` while the credential
    // had in fact arrived by copy.
    should(port.launched[0]?.accountId).equal(ID_TWO);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'synced' });
  });

  it('should fail the named account by name when the copy into its home did not take', async () => {
    // Arrange — the named lane's own login exits zero and writes nothing, so the identity's credential
    // has to be copied into its home instead. The store reports that write a success and the home never
    // changes. This is the exact silent success the proof read exists to make impossible: without it
    // ID_TWO reports `synced` and somebody goes away believing the account they clicked is signed in.
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } }], {}, [ID_TWO]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — the sibling that does hold a credential still says so, and the named account says, by
    // name, that it does not.
    should(port.launched[0]?.accountId).equal(ID_TWO);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'failed' });
    should(actual[1]?.message).containEql(ID_TWO);
    should(actual[1]?.message).match(/no usable credential of its own/u);
  });

  it('should keep the store is own reason when a copy failed rather than replacing it with a general one', async () => {
    // Arrange — a refusal that already says where to look must not be overwritten by the proof step.
    const store = new ScriptedCredentialStore(
      [
        { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
        { [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } },
      ],
      { [ID_TWO]: { ok: false, reason: 'the target home is read-only' } },
    );
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert
    should(statusesOf(actual)[ID_TWO]).equal('failed');
    should(actual[1]?.message).equal('the target home is read-only');
  });

  it('should say a named account was left alone when its own home could not be read', async () => {
    // Arrange — an unreadable home is refused a copy, and that refusal is the safe one: overwriting it
    // could destroy a credential that is working. The named account still has to hear about it.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: VALID, [ID_TWO]: { state: 'unreadable', reason: 'the keychain is locked' } },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — the login ran in that account's own wrapper and exited zero, and the pass STILL refuses
    // to call it signed in: an exit code is not a credential read. No copy was forced onto the home
    // nobody could read, and that account hears the store's own reason rather than a general one.
    should(port.launched).have.length(1);
    should(port.launched[0]?.accountId).equal(ID_TWO);
    should(store.clones).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'indeterminate' });
    should(actual[1]?.message).equal('the keychain is locked');
  });

  it('should never open a browser for a named account under sync-only', async () => {
    // Arrange
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID, [ID_TWO]: VALID }]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act — the narrowing still wins; naming an account does not widen what a pass may do.
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'sync-only',
    });

    // Assert
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'usable', [ID_TWO]: 'usable' });
  });

  it('should leave a named account the manifest declares unavailable alone, and claim nothing about it', async () => {
    // Arrange
    const withUnavailable = identity({
      members: [
        member({ accountId: ID_ONE }),
        member({ accountId: ID_TWO, mode: 'auto', available: false, unavailableReason: 'its wrapper is missing' }),
      ],
    });
    const store = new ScriptedCredentialStore([{ [ID_ONE]: VALID }]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [withUnavailable],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — one sentence about ID_TWO, and it is the specific one the manifest already had.
    should(statusesOf(actual)).deepEqual({ [ID_TWO]: 'unavailable', [ID_ONE]: 'logged-in' });
    should(actual[0]?.message).equal('its wrapper is missing');
  });

  it('should prove both accounts when two lanes of one identity are named', async () => {
    // Arrange — the second one is written to and the write is silently lost.
    const store = new ScriptedCredentialStore(
      [
        { [ID_ONE]: { state: 'missing' }, [ID_TWO]: { state: 'missing' } },
        { [ID_ONE]: VALID, [ID_TWO]: { state: 'missing' } },
      ],
      {},
      [ID_TWO],
    );
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_ONE, ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — a subject that was delivered is not dragged down by one that was not.
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'logged-in', [ID_TWO]: 'failed' });
  });

  it('should refuse a named account whose identity could not be read, without asking for an approval', async () => {
    // Arrange — no usable credential anywhere AND a home nobody could classify. Naming an account does
    // not make an unreadable home readable, and a login here would write over one that may be fine.
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: { state: 'unreadable', reason: 'the keychain is locked' }, [ID_TWO]: { state: 'missing' } },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [twoLanes],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'indeterminate', [ID_TWO]: 'indeterminate' });
  });

  it('should report a named api-key account as needing no login rather than proving a credential it has none of', async () => {
    // Arrange — an api-key identity reads nothing at all, so the proof step must not decide its rows
    // are a failure. There is no provider login to run and saying so is the whole answer.
    const store = new ScriptedCredentialStore([{}]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await build(store, port).login({
      identities: [identity({ auth: 'api-key' })],
      accountIds: [ID_ONE],
      mode: 'reauthenticate',
    });

    // Assert
    should(port.launched).deepEqual([]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'not-required' });
  });
});

describe('FleetLoginService reauthenticating an account that can renew itself', () => {
  class SucceedingRenewal implements FleetTokenRenewal {
    constructor(private readonly store: ScriptedCredentialStore) {}

    renew(identityToRenew: FleetIdentity): Promise<FleetTokenRefreshResult> {
      this.store.nextPass();
      return Promise.resolve({
        identity: identityToRenew.key,
        accountId: ID_ONE,
        status: 'renewed',
        ran: true,
      });
    }
  }

  it('should let a renewal settle the pass, because a rotated token is the provider accepting one', async () => {
    // Arrange — expired with a refresh token, in both homes. A renewal reaches the provider and gets a
    // live credential back, which is what a sign-in is for; making somebody approve a browser on top of
    // that would be charging them for something they already have.
    const expired: CredentialReading = { state: 'refreshable', expiresAt: NOW - HOUR };
    const store = new ScriptedCredentialStore([
      { [ID_ONE]: expired, [ID_TWO]: expired },
      { [ID_ONE]: VALID, [ID_TWO]: expired },
    ]);
    const port = new RecordingLoginPort({ status: 'logged-in' }, store);

    // Act
    const actual = await new FleetLoginService({
      identities: new FleetIdentityService(store),
      loginPort: port,
      renewal: new SucceedingRenewal(store),
    }).login({
      identities: [identity({ members: [member({ accountId: ID_ONE }), member({ accountId: ID_TWO, mode: 'auto' })] })],
      accountIds: [ID_TWO],
      mode: 'reauthenticate',
    });

    // Assert — no browser, and the named account still ends up holding the fresh credential.
    should(port.launched).deepEqual([]);
    should(store.clones).deepEqual([{ donor: ID_ONE, target: ID_TWO }]);
    should(statusesOf(actual)).deepEqual({ [ID_ONE]: 'renewed', [ID_TWO]: 'synced' });
  });
});
