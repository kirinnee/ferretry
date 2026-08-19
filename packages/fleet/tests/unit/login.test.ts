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
 */
class ScriptedCredentialStore implements FleetCredentialStore {
  readonly clones: Array<{ donor: string; target: string }> = [];
  private pass = 0;

  constructor(
    private readonly passes: readonly Readonly<Record<string, CredentialReading>>[],
    private readonly cloneOutcomes: Readonly<Record<string, CredentialCloneOutcome>> = {},
  ) {}

  /** Advance to the next scripted pass; the last one repeats forever. */
  nextPass(): void {
    this.pass = Math.min(this.pass + 1, this.passes.length - 1);
  }

  read(_kind: HarnessKind, target: FleetIdentityMember): Promise<CredentialReading> {
    return Promise.resolve(this.passes[this.pass]?.[target.accountId] ?? { state: 'missing' });
  }

  clone(_kind: HarnessKind, donor: FleetIdentityMember, target: FleetIdentityMember): Promise<CredentialCloneOutcome> {
    this.clones.push({ donor: donor.accountId, target: target.accountId });
    return Promise.resolve(this.cloneOutcomes[target.accountId] ?? { ok: true });
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

    // Assert
    should(actual[0]?.status).equal('failed');
    should(actual[0]?.message).match(/still has no usable credential/u);
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
