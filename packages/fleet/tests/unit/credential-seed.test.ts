/**
 * The first run's credential seed.
 *
 * Every store here is a table. NOTHING in this file reads, writes or names a real credential, a real
 * `~/.claude` or a real `~/.codex` — the product does that on somebody's machine and a test never
 * does, which is why the donor homes below are obvious fixture paths rather than anything that could
 * resolve on the machine running this.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CredentialCloneOutcome,
  type CredentialReading,
  FleetFirstRunSeeder,
  type FleetCredentialStore,
  type FleetIdentityMember,
  type FleetSeedResult,
  type FleetSeedTarget,
  type HarnessKind,
  hostHarnessInstall,
  seedDonorGaps,
  seedFailures,
  seedImports,
  seedUnsigned,
} from '../../src/lib/index.ts';

const DONORS = { claude: '/fixture/user/.claude', codex: '/fixture/user/.codex' } as const;

/** A published account exactly as a preparation would have just added it. */
const target = (wrapper: string, kind: HarnessKind = 'claude'): FleetSeedTarget => ({
  secretEnv: {},
  id: `00000000-0000-4000-8000-00000000000${wrapper.length % 10}`,
  kind,
  mode: 'interactive',
  wrapper: `/fixture/fleet/bin/${wrapper}`,
  home: `/fixture/fleet/homes/${wrapper}`,
  displayName: wrapper,
  defaultModel: 'a-model',
  models: [{ id: 'a-model', available: true }],
  available: true,
  unavailableReason: null,
});

/**
 * A store driven from a table, keyed by HOME.
 *
 * Keyed by home rather than by account id because the donor is not an account: it is this host's own
 * harness directory, and the whole question this module answers is "what is in that directory".
 */
class TableCredentialStore implements FleetCredentialStore {
  readonly reads: string[] = [];
  readonly clones: Array<{ kind: HarnessKind; donor: string; target: string }> = [];

  constructor(
    private readonly readings: Readonly<Record<string, CredentialReading>> = {},
    private readonly outcomes: Readonly<Record<string, CredentialCloneOutcome>> = {},
    private readonly throws: Readonly<Record<string, string>> = {},
  ) {}

  read(_kind: HarnessKind, subject: FleetIdentityMember): Promise<CredentialReading> {
    this.reads.push(subject.home);
    const thrown = this.throws[`read:${subject.home}`];
    if (thrown !== undefined) return Promise.reject(new Error(thrown));
    return Promise.resolve(this.readings[subject.home] ?? { state: 'missing' });
  }

  clone(kind: HarnessKind, donor: FleetIdentityMember, subject: FleetIdentityMember): Promise<CredentialCloneOutcome> {
    this.clones.push({ kind, donor: donor.home, target: subject.home });
    const thrown = this.throws[`clone:${subject.home}`];
    if (thrown !== undefined) return Promise.reject(new Error(thrown));
    return Promise.resolve(this.outcomes[subject.home] ?? { ok: true });
  }
}

const outcomes = (results: readonly FleetSeedResult[]): readonly string[] =>
  results.map(result => `${result.account}:${result.outcome.kind}`);

describe('hostHarnessInstall', () => {
  it('should describe itself as the host own install rather than impersonate a fleet account', async () => {
    // Assert — a synthesised uuid here would be indistinguishable from an account somebody could go
    // looking for, and the display name is what a surface would print if one ever did.
    const donor = hostHarnessInstall('claude', DONORS.claude);
    should(donor.home).equal(DONORS.claude);
    should(donor.accountId).equal('host:claude');
    should(donor.displayName).containEql("this host's own Claude install");
    should(hostHarnessInstall('codex', DONORS.codex).displayName).containEql("this host's own Codex install");
  });
});

describe('FleetFirstRunSeeder', () => {
  it('should copy the host own login into an account that has none', async () => {
    // Arrange — the donor has a working login, the new account has nothing.
    const store = new TableCredentialStore({ [DONORS.claude]: { state: 'valid', expiresAt: 1 } });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert — the copy went from the host's own directory into the new account's home, end to end
    // inside the store, and the report says which account it was in the words a person reads.
    should(store.clones).deepEqual([
      { kind: 'claude', donor: DONORS.claude, target: '/fixture/fleet/homes/claude-default' },
    ]);
    should(results).deepEqual([
      {
        account: 'claude-default',
        // BOTH HALVES. The name is what a boot line says; the id is what the seed-provenance record
        // joins on, and a result carrying only the name could not be turned back into a home.
        accountId: target('claude-default').id,
        kind: 'claude',
        outcome: { kind: 'seeded', donorHome: DONORS.claude },
      },
    ]);
  });

  it('should read one donor once however many accounts share it', async () => {
    // Arrange — four default accounts, two harnesses, two donors.
    const store = new TableCredentialStore({
      [DONORS.claude]: { state: 'valid', expiresAt: 1 },
      [DONORS.codex]: { state: 'refreshable' },
    });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    await subject.seed(
      [
        target('claude-default'),
        target('claude-auto-default'),
        target('codex-default', 'codex'),
        target('codex-auto-default', 'codex'),
      ],
      DONORS,
    );

    // Assert — on macOS a Claude read is a keychain read, and a locked keychain shows a dialog. Four
    // questions to one item is three more chances to block a boot for an answer it already had.
    should(store.reads.filter(home => home === DONORS.claude)).have.length(1);
    should(store.reads.filter(home => home === DONORS.codex)).have.length(1);
    should(store.clones).have.length(4);
  });

  it('should leave an account that already has a credential exactly as it is', async () => {
    // Arrange — this is an import, not a sync: an ongoing one would race the harness's own token
    // refresh forever and lose silently.
    const store = new TableCredentialStore({
      [DONORS.claude]: { state: 'valid', expiresAt: 1 },
      '/fixture/fleet/homes/claude-default': { state: 'valid', expiresAt: 1 },
    });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert
    should(outcomes(results)).deepEqual(['claude-default:kept']);
    should(store.clones).be.empty();
  });

  it('should ask the donor nothing at all when the account already has a credential', async () => {
    // Arrange
    const store = new TableCredentialStore({
      '/fixture/fleet/homes/claude-default': { state: 'refreshable' },
    });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    await subject.seed([target('claude-default')], DONORS);

    // Assert — the target is read FIRST, so a second start on a seeded host raises no keychain prompt
    // for a copy it was never going to make.
    should(store.reads).deepEqual(['/fixture/fleet/homes/claude-default']);
  });

  it('should say there was nothing to copy when the host own install holds no login', async () => {
    // Arrange
    const store = new TableCredentialStore({ [DONORS.codex]: { state: 'missing' } });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('codex-default', 'codex')], DONORS);

    // Assert — the home travels with it, because "no login found" without a path is not something a
    // person can check.
    should(results[0]?.outcome).deepEqual({ kind: 'no-donor', donorHome: DONORS.codex });
    should(store.clones).be.empty();
  });

  it('should refuse to treat an unreadable donor as an absent one', async () => {
    // Arrange — a locked keychain, a timed-out read, or bytes a newer harness wrote.
    const store = new TableCredentialStore({
      [DONORS.claude]: { state: 'unreadable', reason: 'the keychain read for this home failed (exit 51)' },
    });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert — "I could not tell" is not "there is nothing there", and the two send a reader to two
    // different places.
    should(results[0]?.outcome).deepEqual({
      kind: 'donor-unreadable',
      donorHome: DONORS.claude,
      reason: 'the keychain read for this home failed (exit 51)',
    });
    should(store.clones).be.empty();
  });

  it('should never write over an account whose own credential could not be read', async () => {
    // Arrange — the target has bytes this build could not classify. Overwriting them would destroy a
    // login that may have been working perfectly.
    const store = new TableCredentialStore({
      [DONORS.claude]: { state: 'valid', expiresAt: 1 },
      '/fixture/fleet/homes/claude-default': { state: 'unreadable', reason: 'not readable JSON' },
    });
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'refused', reason: 'not readable JSON' });
    should(store.clones).be.empty();
  });

  it('should report a refused copy rather than claim one happened', async () => {
    // Arrange — the store re-reads and re-classifies the donor at copy time and may still refuse.
    const store = new TableCredentialStore(
      { [DONORS.claude]: { state: 'valid', expiresAt: 1 } },
      { '/fixture/fleet/homes/claude-default': { ok: false, reason: 'the keychain write failed (exit 45)' } },
    );
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'failed', reason: 'the keychain write failed (exit 45)' });
  });

  it('should turn a store that throws on a read into a refusal for that account alone', async () => {
    // Arrange
    const store = new TableCredentialStore(
      { [DONORS.claude]: { state: 'valid', expiresAt: 1 } },
      {},
      { 'read:/fixture/fleet/homes/claude-default': 'EACCES' },
    );
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default'), target('claude-auto-default')], DONORS);

    // Assert — a seed never fails a preparation: the fleet is published either way and one account's
    // bad read costs a boot one sentence.
    should(outcomes(results)).deepEqual(['claude-default:refused', 'claude-auto-default:seeded']);
  });

  it('should turn a store that throws on a copy into a failure with the reason it threw', async () => {
    // Arrange
    const store = new TableCredentialStore(
      { [DONORS.claude]: { state: 'valid', expiresAt: 1 } },
      {},
      { 'clone:/fixture/fleet/homes/claude-default': 'ENOSPC: no space left on device' },
    );
    const subject = new FleetFirstRunSeeder(store);

    // Act
    const results = await subject.seed([target('claude-default')], DONORS);

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'failed', reason: 'ENOSPC: no space left on device' });
  });

  it('should fall back to its own words when a thrown value carries no message', async () => {
    // Arrange — a store that rejects with something that is not an Error at all.
    class SilentStore implements FleetCredentialStore {
      read(): Promise<CredentialReading> {
        return Promise.resolve({ state: 'unreadable' });
      }
      clone(): Promise<CredentialCloneOutcome> {
        return Promise.reject(new Error(''));
      }
    }

    // Act — the target reads `unreadable` with no reason of its own.
    const results = await new FleetFirstRunSeeder(new SilentStore()).seed([target('claude-default')], DONORS);

    // Assert — an outcome with an empty reason is a dead end for whoever reads the boot trail.
    should(results[0]?.outcome).deepEqual({
      kind: 'refused',
      reason: 'this account credential could not be read',
    });
  });

  it('should fall back to its own words when a copy throws an empty error', async () => {
    // Arrange
    const store = new TableCredentialStore(
      { [DONORS.claude]: { state: 'valid', expiresAt: 1 } },
      {},
      { 'clone:/fixture/fleet/homes/claude-default': '' },
    );

    // Act
    const results = await new FleetFirstRunSeeder(store).seed([target('claude-default')], DONORS);

    // Assert
    should(results[0]?.outcome).deepEqual({ kind: 'failed', reason: 'the credential could not be copied' });
  });

  it('should fall back to its own words for a donor that is unreadable and says nothing', async () => {
    // Arrange
    const store = new TableCredentialStore({ [DONORS.claude]: { state: 'unreadable' } });

    // Act
    const results = await new FleetFirstRunSeeder(store).seed([target('claude-default')], DONORS);

    // Assert
    should(results[0]?.outcome).deepEqual({
      kind: 'donor-unreadable',
      donorHome: DONORS.claude,
      reason: 'the credential could not be read',
    });
  });

  it('should report every account it was given, in the order it was given them', async () => {
    // Arrange — the report is what the boot line is built from, so a missing entry is an account
    // nobody is ever told about.
    const store = new TableCredentialStore({
      [DONORS.claude]: { state: 'valid', expiresAt: 1 },
      [DONORS.codex]: { state: 'missing' },
    });

    // Act
    const results = await new FleetFirstRunSeeder(store).seed(
      [
        target('claude-default'),
        target('claude-auto-default'),
        target('codex-default', 'codex'),
        target('codex-auto-default', 'codex'),
      ],
      DONORS,
    );

    // Assert
    should(outcomes(results)).deepEqual([
      'claude-default:seeded',
      'claude-auto-default:seeded',
      'codex-default:no-donor',
      'codex-auto-default:no-donor',
    ]);
  });
});

describe('reading a seed', () => {
  const results: readonly FleetSeedResult[] = [
    {
      account: 'claude-default',
      accountId: 'id-claude-default',
      kind: 'claude',
      outcome: { kind: 'seeded', donorHome: DONORS.claude },
    },
    {
      account: 'claude-auto-default',
      accountId: 'id-claude-auto-default',
      kind: 'claude',
      outcome: { kind: 'seeded', donorHome: DONORS.claude },
    },
    {
      account: 'codex-default',
      accountId: 'id-codex-default',
      kind: 'codex',
      outcome: { kind: 'no-donor', donorHome: DONORS.codex },
    },
    { account: 'codex-auto-default', accountId: 'id-codex-auto-default', kind: 'codex', outcome: { kind: 'kept' } },
  ];

  it('should group what it imported by harness, naming the home once', async () => {
    // Assert — one login covers every lane of one harness, so saying it per account reads as two
    // separate things having happened.
    should(seedImports(results)).deepEqual([
      {
        kind: 'claude',
        label: 'Claude',
        donorHome: DONORS.claude,
        accounts: ['claude-default', 'claude-auto-default'],
      },
    ]);
  });

  it('should group what it could not find by harness too', async () => {
    // Assert
    should(seedDonorGaps(results)).deepEqual([
      { kind: 'codex', label: 'Codex', donorHome: DONORS.codex, accounts: ['codex-default'] },
    ]);
  });

  it('should count an account that already had a credential as signed in', async () => {
    // Assert — `kept` means it already had one; listing it as unsigned would send somebody to log in
    // to an account that is already logged in.
    should(seedUnsigned(results)).deepEqual(['codex-default']);
  });

  it('should say nothing about ordinary endings when asked for failures', async () => {
    // Assert — seeded, kept and no-donor are things a person is told once; a failure is a state on
    // this host they may want to go and look at.
    should(seedFailures(results)).be.empty();
  });

  it('should turn each way a copy can fail into one sentence naming the account', async () => {
    // Act
    const failures = seedFailures([
      {
        account: 'a',
        accountId: 'id-a',
        kind: 'claude',
        outcome: { kind: 'donor-unreadable', donorHome: DONORS.claude, reason: 'exit 51' },
      },
      { account: 'b', accountId: 'id-b', kind: 'claude', outcome: { kind: 'refused', reason: 'not readable JSON' } },
      { account: 'c', accountId: 'id-c', kind: 'codex', outcome: { kind: 'failed', reason: 'ENOSPC' } },
    ]);

    // Assert
    should(failures).deepEqual([
      { account: 'a', reason: '/fixture/user/.claude could not be read (exit 51)' },
      { account: 'b', reason: 'its own credential could not be read (not readable JSON)' },
      { account: 'c', reason: 'ENOSPC' },
    ]);
  });
});
